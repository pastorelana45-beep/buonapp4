
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import * as Tone from 'tone';
import { 
  Music, Settings, Mic, Play, Square, Volume2, Trash2, 
  Activity, Disc, History, AudioWaveform, Clock, 
  ChevronRight, XCircle, VolumeX, Volume1, Layers, Mic2, Sparkles, ExternalLink
} from 'lucide-react';
import { INSTRUMENTS } from './constants';
import { Instrument, WorkstationMode, RecordedNote, StudioSession } from './types';
import { detectPitch, frequencyToMidi, midiToNoteName } from './services/pitchDetection';
// Import GoogleGenAI as required by the coding guidelines.
import { GoogleGenAI } from "@google/genai";

const MIN_NOTE_DURATION = 0.05;

const App: React.FC = () => {
  const [selectedInstrument, setSelectedInstrument] = useState<Instrument>(INSTRUMENTS[0]);
  const [mode, setMode] = useState<WorkstationMode>(WorkstationMode.IDLE);
  const [isStarted, setIsStarted] = useState(false);
  const [isConfiguring, setIsConfiguring] = useState(false);
  const [setupStep, setSetupStep] = useState<'PERMISSION' | 'SILENCE' | 'VOICE' | 'COMPLETE'>('PERMISSION');
  const [currentMidiNote, setCurrentMidiNote] = useState<number | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isPlayingBack, setIsPlayingBack] = useState<string | null>(null);
  const [sessions, setSessions] = useState<StudioSession[]>([]);
  const [rmsVolume, setRmsVolume] = useState(0);
  const [sensitivity, setSensitivity] = useState(0.015);
  const [micBoost, setMicBoost] = useState(2.5);
  const [isMonitorOn, setIsMonitorOn] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  // Gemini state for sound design insights
  const [aiInsight, setAiInsight] = useState<{ text: string; sources: any[] } | null>(null);
  const [isAiLoading, setIsAiLoading] = useState(false);

  const synthRef = useRef<Tone.PolySynth | null>(null);
  const micRef = useRef<Tone.UserMedia | null>(null);
  const analyserRef = useRef<Tone.Analyser | null>(null);
  const recorderRef = useRef<Tone.Recorder | null>(null);
  const playerRef = useRef<Tone.Player | null>(null);
  const voicePassthroughRef = useRef<Tone.Gain | null>(null);
  
  const stateRef = useRef({ 
    mode: WorkstationMode.IDLE, 
    isRecording: false, 
    isPlayingBack: false, 
    lastMidi: null as number | null,
    sensitivity: 0.015,
    micBoost: 2.5,
    isMonitorOn: true
  });
  
  const recordingNotesRef = useRef<RecordedNote[]>([]);
  const recordingStartTimeRef = useRef<number>(0);
  const activeNoteStartRef = useRef<{ note: string, start: number } | null>(null);

  const groupedInstruments = useMemo(() => {
    return INSTRUMENTS.reduce((acc, inst) => {
      if (!acc[inst.category]) acc[inst.category] = [];
      acc[inst.category].push(inst);
      return acc;
    }, {} as Record<string, Instrument[]>);
  }, []);

  useEffect(() => {
    stateRef.current = { 
      mode, isRecording, isPlayingBack: !!isPlayingBack, 
      lastMidi: currentMidiNote, sensitivity, micBoost, isMonitorOn
    };
    
    // Gestione monitoraggio in tempo reale
    if (synthRef.current) {
      synthRef.current.volume.value = (isMonitorOn && (mode === WorkstationMode.MIDI || mode === WorkstationMode.RECORD)) ? 0 : -Infinity;
    }
    if (voicePassthroughRef.current) {
      voicePassthroughRef.current.gain.value = (isMonitorOn && mode === WorkstationMode.VOICE) ? 1 : 0;
    }
  }, [mode, isRecording, isPlayingBack, currentMidiNote, sensitivity, micBoost, isMonitorOn]);

  const applyInstrumentSettings = useCallback((instrument: Instrument) => {
    if (!synthRef.current) return;
    let settings: any = { oscillator: { type: 'triangle' }, envelope: { attack: 0.01, decay: 0.1, sustain: 0.5, release: 0.5 } };
    
    switch (instrument.category) {
      case 'PIANO':
        settings = { oscillator: { type: 'triangle8' }, envelope: { attack: 0.005, decay: 0.2, sustain: 0.3, release: 1.2 } };
        break;
      case 'STRINGS':
        settings = { oscillator: { type: 'sawtooth' }, envelope: { attack: 0.4, decay: 0.4, sustain: 0.8, release: 1.5 } };
        break;
      case 'SYNTH':
        settings = { oscillator: { type: 'fatsawtooth', count: 3, spread: 30 }, envelope: { attack: 0.05, decay: 0.3, sustain: 0.4, release: 0.8 } };
        break;
      case 'BASS':
        settings = { oscillator: { type: 'square' }, envelope: { attack: 0.01, decay: 0.1, sustain: 0.6, release: 0.2 } };
        break;
      case 'ORGAN':
        settings = { oscillator: { type: 'sine' }, envelope: { attack: 0.01, decay: 0, sustain: 1, release: 0.1 } };
        break;
    }
    synthRef.current.set(settings);
  }, []);

  useEffect(() => { applyInstrumentSettings(selectedInstrument); }, [selectedInstrument, applyInstrumentSettings]);

  const initAudioCore = async () => {
    await Tone.start();
    if (synthRef.current) return true;

    try {
      const synth = new Tone.PolySynth(Tone.Synth).toDestination();
      const mic = new Tone.UserMedia();
      const analyser = new Tone.Analyser('waveform', 1024);
      const recorder = new Tone.Recorder();
      const passthrough = new Tone.Gain(0).toDestination();
      
      await mic.open();
      mic.connect(analyser);
      mic.connect(recorder);
      mic.connect(passthrough);
      
      synthRef.current = synth;
      micRef.current = mic;
      analyserRef.current = analyser;
      recorderRef.current = recorder;
      voicePassthroughRef.current = passthrough;
      
      applyInstrumentSettings(selectedInstrument);
      return true;
    } catch (err) {
      console.error("Audio init error:", err);
      return false;
    }
  };

  const startSetupWizard = async () => {
    setIsConfiguring(true);
    setSetupStep('PERMISSION');
    const success = await initAudioCore();
    if (!success) {
      alert("Microfono non accessibile.");
      setIsConfiguring(false);
      return;
    }
    requestAnimationFrame(audioLoop);
    setSetupStep('SILENCE');
    setTimeout(() => setSetupStep('VOICE'), 1000);
    setTimeout(() => setSetupStep('COMPLETE'), 2000);
  };

  const audioLoop = () => {
    if (!analyserRef.current || !synthRef.current) return;
    
    const buffer = analyserRef.current.getValue() as Float32Array;
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) {
      const boostedSample = buffer[i] * stateRef.current.micBoost;
      sum += boostedSample * boostedSample;
    }
    const rms = Math.sqrt(sum / buffer.length);
    setRmsVolume(prev => prev * 0.7 + rms * 0.3);

    if (stateRef.current.isPlayingBack) {
      requestAnimationFrame(audioLoop);
      return;
    }

    const currentMode = stateRef.current.mode;
    const isMidiMode = currentMode === WorkstationMode.MIDI || currentMode === WorkstationMode.RECORD;

    if (rms > stateRef.current.sensitivity && isMidiMode) {
      const freq = detectPitch(buffer, Tone.getContext().sampleRate);
      const midi = freq ? frequencyToMidi(freq) : null;

      if (midi !== null && midi !== stateRef.current.lastMidi) {
        const noteName = midiToNoteName(midi);
        if (stateRef.current.lastMidi !== null) {
          synthRef.current.triggerRelease(midiToNoteName(stateRef.current.lastMidi));
          if (currentMode === WorkstationMode.RECORD && activeNoteStartRef.current) {
            const duration = Tone.now() - recordingStartTimeRef.current - activeNoteStartRef.current.start;
            if (duration >= MIN_NOTE_DURATION) {
              recordingNotesRef.current.push({ ...activeNoteStartRef.current, duration });
            }
          }
        }
        synthRef.current.triggerAttack(noteName);
        setCurrentMidiNote(midi);
        if (currentMode === WorkstationMode.RECORD) {
          activeNoteStartRef.current = { note: noteName, start: Tone.now() - recordingStartTimeRef.current, duration: 0 };
        }
      }
    } else if (stateRef.current.lastMidi !== null) {
      synthRef.current.triggerRelease(midiToNoteName(stateRef.current.lastMidi));
      if (currentMode === WorkstationMode.RECORD && activeNoteStartRef.current) {
        const duration = Tone.now() - recordingStartTimeRef.current - activeNoteStartRef.current.start;
        if (duration >= MIN_NOTE_DURATION) {
          recordingNotesRef.current.push({ ...activeNoteStartRef.current, duration });
        }
        activeNoteStartRef.current = null;
      }
      setCurrentMidiNote(null);
    }
    requestAnimationFrame(audioLoop);
  };

  const toggleRecording = async () => {
    if (!isRecording) {
      recordingNotesRef.current = [];
      recordingStartTimeRef.current = Tone.now();
      recorderRef.current?.start();
      setIsRecording(true);
      setMode(WorkstationMode.RECORD);
      setShowHistory(false);
    } else {
      const audioBlob = await recorderRef.current?.stop();
      if (!audioBlob) return;
      const url = URL.createObjectURL(audioBlob);
      if (activeNoteStartRef.current) {
        const duration = Tone.now() - recordingStartTimeRef.current - activeNoteStartRef.current.start;
        if (duration >= MIN_NOTE_DURATION) recordingNotesRef.current.push({ ...activeNoteStartRef.current, duration });
      }
      setSessions(prev => [{
        id: Math.random().toString(36).substr(2, 9),
        timestamp: Date.now(),
        midiNotes: [...recordingNotesRef.current],
        audioUrl: url,
        instrumentName: selectedInstrument.name
      }, ...prev]);
      setIsRecording(false);
      setMode(WorkstationMode.IDLE);
      synthRef.current?.releaseAll();
      setShowHistory(true);
    }
  };

  const playSessionMidi = (session: StudioSession) => {
    if (isPlayingBack) stopAllPlayback();
    setIsPlayingBack(session.id + "_midi");
    const now = Tone.now();
    session.midiNotes.forEach(n => {
      synthRef.current?.triggerAttackRelease(n.note, n.duration, now + n.time);
    });
    setTimeout(() => setIsPlayingBack(null), 5000); // Semplificato
  };

  const playSessionAudio = (session: StudioSession) => {
    if (isPlayingBack) stopAllPlayback();
    setIsPlayingBack(session.id + "_audio");
    const player = new Tone.Player({
      url: session.audioUrl,
      autostart: true,
      onstop: () => { setIsPlayingBack(null); player.dispose(); }
    }).toDestination();
    playerRef.current = player;
  };

  const stopAllPlayback = () => {
    synthRef.current?.releaseAll();
    playerRef.current?.stop();
    setIsPlayingBack(null);
  };

  /**
   * Gemini Insight Function: Fetches pro studio insights for the selected instrument.
   * Utilizes Gemini 3 Flash with Google Search grounding.
   */
  const fetchAiInsight = async () => {
    setIsAiLoading(true);
    setAiInsight(null);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: `Provide 3 concise professional studio recording and mixing tips for ${selectedInstrument.name}. Focus on modern sound production.`,
        config: {
          tools: [{ googleSearch: {} }]
        }
      });
      
      const text = response.text || "No insights found.";
      const chunks = (response.candidates?.[0]?.groundingMetadata?.groundingChunks || []) as any[];
      
      setAiInsight({ text, sources: chunks });
    } catch (e) {
      console.error("Gemini Insight Error:", e);
    } finally {
      setIsAiLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black text-white flex flex-col overflow-hidden font-sans select-none">
      
      {/* HEADER */}
      <header className="px-6 py-4 flex justify-between items-center bg-zinc-950/80 backdrop-blur-md border-b border-white/5 z-50">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 bg-purple-600 rounded-lg flex items-center justify-center shadow-lg shadow-purple-900/20">
            <Music size={20} />
          </div>
          <div>
            <h1 className="text-xs font-black uppercase tracking-tighter">VocalSynth<span className="text-purple-500">Pro</span></h1>
            <p className="text-[7px] font-bold text-zinc-500 uppercase tracking-widest">Live Studio v2</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
           {isStarted && (
            <>
              <button 
                onClick={() => setIsMonitorOn(!isMonitorOn)} 
                className={`p-2 rounded-full transition-all ${isMonitorOn ? 'bg-emerald-500/10 text-emerald-500' : 'bg-red-500/20 text-red-500'}`}
              >
                {isMonitorOn ? <Volume1 size={18} /> : <VolumeX size={18} />}
              </button>
              <button onClick={() => setShowSettings(!showSettings)} className="p-2 bg-zinc-900 rounded-full"><Settings size={18} /></button>
            </>
          )}
        </div>
      </header>

      {/* VOLUME BAR */}
      {isStarted && (
        <div className="w-full h-1 bg-zinc-900 overflow-hidden">
          <div className="h-full bg-purple-500 transition-all duration-75" style={{ width: `${Math.min(100, (rmsVolume / 0.3) * 100)}%` }} />
        </div>
      )}

      {/* SETUP WIZARD */}
      {isConfiguring && (
        <div className="absolute inset-0 z-[100] bg-black/95 flex flex-col items-center justify-center p-10 text-center animate-in fade-in">
          <Mic size={48} className="text-purple-500 animate-pulse mb-6" />
          <h3 className="text-2xl font-black uppercase mb-2">{setupStep}</h3>
          <p className="text-zinc-500 text-[10px] uppercase tracking-widest">Configuring engine...</p>
          {setupStep === 'COMPLETE' && (
            <button onClick={() => { setIsConfiguring(false); setIsStarted(true); }} className="mt-10 w-full bg-white text-black py-5 rounded-2xl font-black uppercase italic active:scale-95 transition-all">Start Experience</button>
          )}
        </div>
      )}

      {/* MAIN CONTENT */}
      {isStarted && (
        <main className="flex-1 flex flex-col px-5 pb-24 overflow-hidden">
          
          {/* 3 MODALITÀ GRID */}
          <section className="grid grid-cols-3 gap-3 my-5 shrink-0">
            <button 
              onClick={() => { setMode(WorkstationMode.MIDI); stopAllPlayback(); }}
              className={`py-5 rounded-2xl flex flex-col items-center gap-2 border-2 transition-all ${mode === WorkstationMode.MIDI ? 'bg-purple-600 border-purple-600 text-white shadow-lg' : 'bg-zinc-900 border-transparent text-zinc-500'}`}
            >
              <Activity size={20} strokeWidth={3} />
              <span className="text-[8px] font-black tracking-widest">MIDI</span>
            </button>
            <button 
              onClick={() => { setMode(WorkstationMode.VOICE); stopAllPlayback(); }}
              className={`py-5 rounded-2xl flex flex-col items-center gap-2 border-2 transition-all ${mode === WorkstationMode.VOICE ? 'bg-blue-600 border-blue-600 text-white shadow-lg' : 'bg-zinc-900 border-transparent text-zinc-500'}`}
            >
              <Mic2 size={20} strokeWidth={3} />
              <span className="text-[8px] font-black tracking-widest">VOICE</span>
            </button>
            <button 
              onClick={toggleRecording}
              className={`py-5 rounded-2xl flex flex-col items-center gap-2 border-2 transition-all ${isRecording ? 'bg-red-600 border-red-600 text-white animate-pulse' : 'bg-zinc-900 border-transparent text-zinc-500'}`}
            >
              {isRecording ? <Square size={20} fill="white" strokeWidth={0} /> : <Disc size={20} strokeWidth={3} />}
              <span className="text-[8px] font-black tracking-widest">{isRecording ? 'STOP' : 'REC'}</span>
            </button>
          </section>

          {/* TABS BROWSER / ARCHIVE */}
          <div className="flex gap-4 mb-3 border-b border-white/5 px-2">
            <button onClick={() => setShowHistory(false)} className={`pb-2 text-[10px] font-black uppercase tracking-widest ${!showHistory ? 'text-purple-500 border-b-2 border-purple-500' : 'text-zinc-600'}`}>Browser</button>
            <button onClick={() => setShowHistory(true)} className={`pb-2 text-[10px] font-black uppercase tracking-widest ${showHistory ? 'text-purple-500 border-b-2 border-purple-500' : 'text-zinc-600'}`}>History ({sessions.length})</button>
          </div>

          <div className="flex-1 overflow-y-auto no-scrollbar rounded-3xl bg-zinc-900/20 border border-white/5 p-4">
            {!showHistory ? (
              <div className="space-y-8 pb-10">
                {/* AI INSIGHT SECTION IN BROWSER */}
                <div className="bg-zinc-900/50 rounded-2xl p-4 border border-purple-500/20 mb-6">
                  <div className="flex justify-between items-center mb-3">
                    <div className="flex items-center gap-2">
                      <Sparkles size={14} className="text-purple-500" />
                      <span className="text-[10px] font-black uppercase tracking-widest text-purple-400">AI Studio Guide</span>
                    </div>
                    <button 
                      onClick={fetchAiInsight} 
                      disabled={isAiLoading}
                      className="text-[8px] font-black uppercase tracking-widest bg-purple-600 px-3 py-1 rounded-full disabled:opacity-50 transition-all hover:bg-purple-500 active:scale-95"
                    >
                      {isAiLoading ? 'Analyzing...' : 'Get Tips'}
                    </button>
                  </div>
                  {aiInsight ? (
                    <div className="space-y-3">
                      <p className="text-[10px] text-zinc-300 leading-relaxed italic">{aiInsight.text}</p>
                      {aiInsight.sources.length > 0 && (
                        <div className="pt-2 border-t border-white/5">
                          <p className="text-[7px] font-black text-zinc-500 uppercase tracking-widest mb-1">Sources:</p>
                          <div className="flex flex-wrap gap-2">
                            {aiInsight.sources.map((chunk, idx) => chunk.web && (
                              <a key={idx} href={chunk.web.uri} target="_blank" rel="noreferrer" className="text-[7px] text-purple-400 flex items-center gap-1 hover:underline">
                                {chunk.web.title || 'Link'} <ExternalLink size={8} />
                              </a>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <p className="text-[8px] text-zinc-600 uppercase tracking-widest text-center py-2 font-bold">Select an instrument for studio tips</p>
                  )}
                </div>

                {Object.entries(groupedInstruments).map(([cat, insts]) => (
                  <div key={cat} className="space-y-3">
                    <h4 className="text-[8px] font-black text-zinc-700 tracking-[0.3em] uppercase">{cat}</h4>
                    <div className="grid grid-cols-2 gap-2">
                      {insts.map(inst => (
                        <button 
                          key={inst.id} 
                          onClick={() => { setSelectedInstrument(inst); setAiInsight(null); }}
                          className={`p-4 rounded-xl border-2 transition-all text-left flex flex-col h-20 justify-between ${selectedInstrument.id === inst.id ? 'bg-zinc-900 border-purple-600' : 'bg-zinc-900/30 border-transparent'}`}
                        >
                          <Music size={14} className={selectedInstrument.id === inst.id ? 'text-purple-500' : 'text-zinc-800'} />
                          <span className={`text-[9px] font-bold uppercase tracking-tighter truncate ${selectedInstrument.id === inst.id ? 'text-white' : 'text-zinc-600'}`}>{inst.name}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="space-y-3 pb-10">
                {sessions.length === 0 && <p className="text-center py-10 text-[10px] text-zinc-700 font-bold uppercase tracking-widest">Archive Empty</p>}
                {/* FIX: Explicitly cast sessions to StudioSession[] to prevent 'unknown' type error in map iterator */}
                {(sessions as StudioSession[]).map((s: StudioSession) => (
                  <div key={s.id} className="p-4 bg-zinc-900/60 rounded-2xl border border-white/5">
                    <div className="flex justify-between items-start mb-4">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 bg-black rounded-lg flex items-center justify-center"><Layers size={14} className="text-purple-500/50" /></div>
                        <div>
                          <p className="text-[9px] font-black text-purple-400 uppercase">{s.instrumentName}</p>
                          <p className="text-[8px] font-mono text-zinc-600">{new Date(s.timestamp).toLocaleTimeString()}</p>
                        </div>
                      </div>
                      <button onClick={() => setSessions(prev => prev.filter(x => x.id !== s.id))} className="text-zinc-800 p-1"><Trash2 size={14} /></button>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <button onClick={() => playSessionMidi(s)} className="py-3 bg-black rounded-xl text-[9px] font-black uppercase tracking-widest flex items-center justify-center gap-2">
                        {isPlayingBack === s.id + "_midi" ? <Square size={10} fill="white" /> : <Play size={10} fill="currentColor" />} MIDI
                      </button>
                      <button onClick={() => playSessionAudio(s)} className="py-3 bg-black rounded-xl text-[9px] font-black uppercase tracking-widest flex items-center justify-center gap-2">
                        {isPlayingBack === s.id + "_audio" ? <Square size={10} fill="white" /> : <Volume2 size={10} />} AUDIO
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </main>
      )}

      {/* DASHBOARD BAR */}
      {isStarted && (
        <div className="fixed bottom-4 left-4 right-4 z-[60]">
          <div className="bg-zinc-950/90 backdrop-blur-2xl border border-white/10 p-4 rounded-[2rem] flex items-center justify-between shadow-2xl">
            <div className="flex items-center gap-4">
              <div className={`w-12 h-12 rounded-2xl flex items-center justify-center transition-all ${isRecording ? 'bg-red-600' : 'bg-purple-600 shadow-lg shadow-purple-600/20'}`}>
                {isRecording ? <Disc size={20} className="animate-spin-slow" /> : <Mic size={20} />}
              </div>
              <div>
                <p className="text-[9px] font-black uppercase text-zinc-500 tracking-wider">{mode === WorkstationMode.IDLE ? 'READY' : `${mode} MODE`}</p>
                <div className="flex items-center gap-2">
                   <div className={`w-1.5 h-1.5 rounded-full ${currentMidiNote ? 'bg-emerald-500 animate-pulse' : 'bg-zinc-800'}`} />
                   <p className="text-[10px] font-black tracking-widest">{currentMidiNote ? midiToNoteName(currentMidiNote) : !isMonitorOn ? 'MUTED' : '---'}</p>
                </div>
              </div>
            </div>
            <div className="pr-4 flex items-center gap-4">
               <div className="w-[1px] h-8 bg-white/5" />
               <p className={`text-3xl font-mono font-black italic tracking-tighter transition-all ${currentMidiNote ? 'text-purple-500 scale-110' : 'text-zinc-900'}`}>
                 {currentMidiNote ? String(midiToNoteName(currentMidiNote)).replace(/\d+/g, '') : '--'}
               </p>
            </div>
          </div>
        </div>
      )}

      {/* SETTINGS MODAL */}
      {showSettings && (
        <div className="absolute inset-0 z-[150] bg-black/90 backdrop-blur-xl flex items-center justify-center p-8 animate-in fade-in zoom-in duration-200">
           <div className="w-full max-w-xs bg-zinc-900 p-8 rounded-[2.5rem] border border-white/10 relative shadow-2xl">
              <button onClick={() => setShowSettings(false)} className="absolute top-6 right-6 p-2 bg-zinc-800 rounded-full"><XCircle size={18} /></button>
              <h3 className="text-lg font-black uppercase italic tracking-tighter mb-8">Studio Settings</h3>
              <div className="space-y-6">
                <div className="space-y-2">
                  <div className="flex justify-between text-[9px] font-black uppercase text-zinc-500"><span>Mic Sensitivity</span><span className="text-purple-500">{(sensitivity * 1000).toFixed(0)}</span></div>
                  <input type="range" min="0.001" max="0.1" step="0.001" value={sensitivity} onChange={(e) => setSensitivity(parseFloat(e.target.value))} className="w-full h-1 bg-zinc-800 rounded-lg appearance-none accent-purple-500" />
                </div>
                <div className="space-y-2">
                  <div className="flex justify-between text-[9px] font-black uppercase text-zinc-500"><span>Gain Boost</span><span className="text-purple-500">x{micBoost.toFixed(1)}</span></div>
                  <input type="range" min="1" max="10" step="0.5" value={micBoost} onChange={(e) => setMicBoost(parseFloat(e.target.value))} className="w-full h-1 bg-zinc-800 rounded-lg appearance-none accent-purple-500" />
                </div>
                <div className="pt-4 flex items-center justify-between border-t border-white/5">
                   <div className="text-[9px] font-black uppercase text-zinc-500">Monitor Output</div>
                   <button onClick={() => setIsMonitorOn(!isMonitorOn)} className={`px-4 py-2 rounded-full text-[9px] font-black uppercase ${isMonitorOn ? 'bg-zinc-800 text-zinc-500' : 'bg-emerald-500 text-black'}`}>
                     {isMonitorOn ? 'Default' : 'Bluetooth'}
                   </button>
                </div>
              </div>
           </div>
        </div>
      )}

      {/* SPLASH SCREEN */}
      {!isStarted && !isConfiguring && (
        <div className="absolute inset-0 z-[100] bg-black flex flex-col items-center justify-center p-10 animate-in fade-in duration-700">
          <div className="w-24 h-24 bg-white text-black rounded-[2.2rem] flex items-center justify-center shadow-2xl mb-10 rotate-3 transition-transform">
            <Music size={40} />
          </div>
          <h2 className="text-5xl font-black mb-2 tracking-tighter uppercase italic leading-none">Vocal<br/><span className="text-purple-500">Synth</span></h2>
          <p className="text-zinc-600 text-[10px] mb-14 uppercase font-bold tracking-[0.2em] max-w-[200px] text-center">Transform your voice into professional studio audio</p>
          <button onClick={startSetupWizard} className="w-full max-w-xs bg-white text-black py-7 rounded-[2rem] font-black text-xl hover:scale-105 active:scale-95 transition-all shadow-2xl flex items-center justify-center gap-3">
            ENTER STUDIO <ChevronRight size={24} />
          </button>
        </div>
      )}

      <style>{`
        @keyframes spin-slow { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .animate-spin-slow { animation: spin-slow 4s linear infinite; }
        .no-scrollbar::-webkit-scrollbar { display: none; }
        input[type='range']::-webkit-slider-thumb { -webkit-appearance: none; width: 18px; height: 18px; background: #fff; border-radius: 50%; border: 3px solid #a855f7; }
      `}</style>
    </div>
  );
};

export default App;
