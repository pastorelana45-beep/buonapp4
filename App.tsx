import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import * as Tone from 'tone';
import { 
  Music, Settings, Mic, Play, Square, Volume2, Trash2, 
  Activity, Disc, History, AudioWaveform, Clock, 
  ChevronRight, XCircle, Volume1, VolumeX, Layers, Mic2, Sparkles
} from 'lucide-react';
import { INSTRUMENTS } from './constants';
import { Instrument, WorkstationMode, RecordedNote, StudioSession } from './types';
import { detectPitch, frequencyToMidi, midiToNoteName } from './services/pitchDetection';
import { GoogleGenerativeAI } from "@google/generative-ai";

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
  const activeNoteStartRef = useRef<{ note: string, start: number, time: number } | null>(null);

  const groupedInstruments = useMemo(() => {
    return INSTRUMENTS.reduce((acc, inst) => {
      if (!acc[inst.category]) acc[inst.category] = [];
      acc[inst.category].push(inst);
      return acc;
    }, {} as Record<string, Instrument[]>);
  }, []);

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

  useEffect(() => {
    stateRef.current = { 
      mode, isRecording, isPlayingBack: !!isPlayingBack, 
      lastMidi: currentMidiNote, sensitivity, micBoost, isMonitorOn
    };
    
    if (synthRef.current) {
      const shouldMute = isRecording || !isMonitorOn || (mode !== WorkstationMode.MIDI && mode !== WorkstationMode.RECORD);
      synthRef.current.volume.value = shouldMute ? -Infinity : 0;
    }
    if (voicePassthroughRef.current) {
      voicePassthroughRef.current.gain.value = (isMonitorOn && mode === WorkstationMode.VOICE) ? 1 : 0;
    }
  }, [mode, isRecording, isPlayingBack, currentMidiNote, sensitivity, micBoost, isMonitorOn]);

  useEffect(() => { applyInstrumentSettings(selectedInstrument); }, [selectedInstrument, applyInstrumentSettings]);

  const initAudioCore = async () => {
    if (synthRef.current) return true;
    try {
      await Tone.start(); // Sblocco cruciale
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
    const isMidiActive = currentMode === WorkstationMode.MIDI || currentMode === WorkstationMode.RECORD;

    if (rms > stateRef.current.sensitivity && isMidiActive) {
      const freq = detectPitch(buffer, Tone.getContext().sampleRate);
      const midi = freq ? frequencyToMidi(freq) : null;

      if (midi !== null && midi !== stateRef.current.lastMidi) {
        const noteName = midiToNoteName(midi);
        if (stateRef.current.lastMidi !== null) {
          synthRef.current.triggerRelease(midiToNoteName(stateRef.current.lastMidi));
          if (currentMode === WorkstationMode.RECORD && activeNoteStartRef.current) {
            const duration = Tone.now() - recordingStartTimeRef.current - activeNoteStartRef.current.start;
            if (duration >= MIN_NOTE_DURATION) {
              recordingNotesRef.current.push({ note: activeNoteStartRef.current.note, time: activeNoteStartRef.current.time, duration });
            }
          }
        }
        synthRef.current.triggerAttack(noteName);
        setCurrentMidiNote(midi);
        if (currentMode === WorkstationMode.RECORD) {
          const startTime = Tone.now() - recordingStartTimeRef.current;
          activeNoteStartRef.current = { note: noteName, start: startTime, time: startTime };
        }
      }
    } else if (stateRef.current.lastMidi !== null) {
      synthRef.current.triggerRelease(midiToNoteName(stateRef.current.lastMidi));
      if (currentMode === WorkstationMode.RECORD && activeNoteStartRef.current) {
        const duration = Tone.now() - recordingStartTimeRef.current - activeNoteStartRef.current.start;
        if (duration >= MIN_NOTE_DURATION) {
          recordingNotesRef.current.push({ note: activeNoteStartRef.current.note, time: activeNoteStartRef.current.time, duration });
        }
        activeNoteStartRef.current = null;
      }
      setCurrentMidiNote(null);
    }
    requestAnimationFrame(audioLoop);
  };

  const startSetupWizard = async () => {
    setIsConfiguring(true);
    setSetupStep('PERMISSION');
    const success = await initAudioCore();
    if (success) {
      setSetupStep('COMPLETE');
      audioLoop();
    } else {
      setIsConfiguring(false);
      alert("Microphone access denied.");
    }
  };

  // ... (Tutte le altre funzioni toggleRecording, playSessionMidi, etc rimangono uguali)
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
        if (duration >= MIN_NOTE_DURATION) {
          recordingNotesRef.current.push({ note: activeNoteStartRef.current.note, time: activeNoteStartRef.current.time, duration });
        }
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

  const stopAllPlayback = () => {
    synthRef.current?.releaseAll();
    playerRef.current?.stop();
    setIsPlayingBack(null);
  };

  const playSessionMidi = (session: StudioSession) => {
    if (isPlayingBack) stopAllPlayback();
    applyInstrumentSettings(selectedInstrument);
    setIsPlayingBack(session.id + "_midi");
    const now = Tone.now();
    session.midiNotes.forEach(n => {
      synthRef.current?.triggerAttackRelease(n.note, n.duration, now + n.time);
    });
    const totalTime = Math.max(...session.midiNotes.map(n => n.time + n.duration), 2);
    setTimeout(() => setIsPlayingBack(null), totalTime * 1000);
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

  const toggleVoiceMode = () => {
    if (mode === WorkstationMode.VOICE) {
      setMode(WorkstationMode.IDLE);
    } else {
      stopAllPlayback();
      setMode(WorkstationMode.VOICE);
    }
  };

  const fetchAiInsight = async () => {
    setIsAiLoading(true);
    try {
      const apiKey = (import.meta as any).env?.VITE_API_KEY || "";
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
      const result = await model.generateContent(`Tips for playing ${selectedInstrument.name} with voice-to-midi`);
      const resp = await result.response;
      setAiInsight({ text: resp.text(), sources: [] });
    } catch (e) { console.error(e); } finally { setIsAiLoading(false); }
  };

  return (
    <div className="fixed inset-0 bg-black text-white flex flex-col overflow-hidden font-sans select-none">
      {/* Header, Main Content, Modals e Styles rimangono quelli che avevi */}
      <header className="px-6 py-4 flex justify-between items-center bg-zinc-950/80 backdrop-blur-md border-b border-white/5 z-50">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 bg-purple-600 rounded-lg flex items-center justify-center shadow-lg shadow-purple-900/20"><Music size={20} /></div>
          <div>
            <h1 className="text-xs font-black uppercase tracking-tighter">VocalSynth<span className="text-purple-500">Pro</span></h1>
            <p className="text-[7px] font-bold text-zinc-500 uppercase tracking-widest">Live Studio v2</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
           {isStarted && (
            <>
              <button onClick={() => setIsMonitorOn(!isMonitorOn)} className={`p-2 rounded-full transition-all ${isMonitorOn ? 'bg-emerald-500/10 text-emerald-500' : 'bg-red-500/20 text-red-500'}`}>
                {isMonitorOn ? <Volume1 size={18} /> : <VolumeX size={18} />}
              </button>
              <button onClick={() => setShowSettings(!showSettings)} className="p-2 bg-zinc-900 rounded-full"><Settings size={18} /></button>
            </>
          )}
        </div>
      </header>

      {isStarted && <div className="w-full h-1 bg-zinc-900"><div className="h-full bg-purple-500 transition-all duration-75" style={{ width: `${Math.min(100, (rmsVolume / 0.3) * 100)}%` }} /></div>}

      {isConfiguring && (
        <div className="absolute inset-0 z-[100] bg-black/95 flex flex-col items-center justify-center text-center animate-in fade-in">
          <Mic size={48} className="text-purple-500 animate-pulse mb-6" />
          <h3 className="text-2xl font-black uppercase mb-2">{setupStep}</h3>
          {setupStep === 'COMPLETE' && (
            <button onClick={() => { setIsConfiguring(false); setIsStarted(true); }} className="mt-10 px-10 bg-white text-black py-5 rounded-2xl font-black uppercase italic">Start Experience</button>
          )}
        </div>
      )}

      {isStarted && (
        <main className="flex-1 flex flex-col px-5 pb-24 overflow-hidden">
          <section className="grid grid-cols-3 gap-3 my-5 shrink-0">
            <button onClick={() => { setMode(WorkstationMode.MIDI); stopAllPlayback(); }} className={`py-5 rounded-2xl flex flex-col items-center gap-2 border-2 transition-all ${mode === WorkstationMode.MIDI ? 'bg-purple-600 border-purple-600' : 'bg-zinc-900 border-transparent text-zinc-500'}`}>
              <Activity size={20} strokeWidth={3} /><span className="text-[8px] font-black tracking-widest">MIDI</span>
            </button>
            <button onClick={toggleVoiceMode} className={`py-5 rounded-2xl flex flex-col items-center gap-2 border-2 transition-all ${mode === WorkstationMode.VOICE ? 'bg-blue-600 border-blue-600 shadow-lg' : 'bg-zinc-900 border-transparent text-zinc-500'}`}>
              <Mic2 size={20} strokeWidth={3} /><span className="text-[8px] font-black tracking-widest">VOICE</span>
            </button>
            <button onClick={toggleRecording} className={`py-5 rounded-2xl flex flex-col items-center gap-2 border-2 transition-all ${isRecording ? 'bg-red-600 border-red-600 animate-pulse' : 'bg-zinc-900 border-transparent text-zinc-500'}`}>
              {isRecording ? <Square size={20} fill="white" strokeWidth={0} /> : <Disc size={20} strokeWidth={3} />}<span className="text-[8px] font-black tracking-widest">{isRecording ? 'STOP' : 'REC'}</span>
            </button>
          </section>

          <div className="flex gap-4 mb-3 border-b border-white/5 px-2">
            <button onClick={() => setShowHistory(false)} className={`pb-2 text-[10px] font-black uppercase tracking-widest ${!showHistory ? 'text-purple-500 border-b-2 border-purple-500' : 'text-zinc-600'}`}>Browser</button>
            <button onClick={() => setShowHistory(true)} className={`pb-2 text-[10px] font-black uppercase tracking-widest ${showHistory ? 'text-purple-500 border-b-2 border-purple-500' : 'text-zinc-600'}`}>History ({sessions.length})</button>
          </div>

          <div className="flex-1 overflow-y-auto no-scrollbar rounded-3xl bg-zinc-900/20 border border-white/5 p-4">
            {!showHistory ? (
              <div className="space-y-8 pb-10">
                <div className="bg-zinc-900/50 rounded-2xl p-4 border border-purple-500/20 mb-6">
                  <div className="flex justify-between items-center mb-3">
                    <div className="flex items-center gap-2"><Sparkles size={14} className="text-purple-500" /><span className="text-[10px] font-black uppercase tracking-widest text-purple-400">AI Studio Guide</span></div>
                    <button onClick={fetchAiInsight} disabled={isAiLoading} className="text-[8px] font-black uppercase tracking-widest bg-purple-600 px-3 py-1 rounded-full disabled:opacity-50">{isAiLoading ? 'Analyzing...' : 'Get Tips'}</button>
                  </div>
                  {aiInsight && <p className="text-[10px] text-zinc-300 leading-relaxed italic">{aiInsight.text}</p>}
                </div>
                {Object.entries(groupedInstruments).map(([cat, insts]) => (
                  <div key={cat} className="space-y-3">
                    <h4 className="text-[8px] font-black text-zinc-700 tracking-[0.3em] uppercase">{cat}</h4>
                    <div className="grid grid-cols-2 gap-2">
                      {insts.map(inst => (
                        <button key={inst.id} onClick={() => { setSelectedInstrument(inst); setAiInsight(null); }} className={`p-4 rounded-xl border-2 transition-all text-left flex flex-col h-20 justify-between ${selectedInstrument.id === inst.id ? 'bg-zinc-900 border-purple-600' : 'bg-zinc-900/30 border-transparent'}`}>
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
                {sessions.map((s) => (
                  <div key={s.id} className="p-4 bg-zinc-900/60 rounded-2xl border border-white/5">
                    <div className="flex justify-between items-start mb-4">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 bg-black rounded-lg flex items-center justify-center"><Layers size={14} className="text-purple-500/50" /></div>
                        <div><p className="text-[9px] font-black text-purple-400 uppercase">{s.instrumentName}</p><p className="text-[8px] font-mono text-zinc-600">{new Date(s.timestamp).toLocaleTimeString()}</p></div>
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

      {isStarted && (
        <div className="fixed bottom-4 left-4 right-4 z-[60]">
          <div className="bg-zinc-950/90 backdrop-blur-2xl border border-white/10 p-4 rounded-[2rem] flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className={`w-12 h-12 rounded-2xl flex items-center justify-center ${isRecording ? 'bg-red-600' : 'bg-purple-600'}`}>
                {isRecording ? <Disc size={20} className="animate-spin-slow" /> : <Mic size={20} />}
              </div>
              <div>
                <p className="text-[9px] font-black uppercase text-zinc-500">{mode}</p>
                <p className="text-[10px] font-black tracking-widest">{currentMidiNote ? midiToNoteName(currentMidiNote) : '---'}</p>
              </div>
            </div>
            <p className="text-3xl font-mono font-black italic text-purple-500 pr-4">{currentMidiNote ? String(midiToNoteName(currentMidiNote)).replace(/\d+/g, '') : '--'}</p>
          </div>
        </div>
      )}

      {showSettings && (
        <div className="absolute inset-0 z-[150] bg-black/90 flex items-center justify-center p-8 animate-in fade-in">
           <div className="w-full max-w-xs bg-zinc-900 p-8 rounded-[2.5rem] border border-white/10 relative">
              <button onClick={() => setShowSettings(false)} className="absolute top-6 right-6 p-2 bg-zinc-800 rounded-full"><XCircle size={18} /></button>
              <h3 className="text-lg font-black uppercase italic mb-8">Settings</h3>
              <div className="space-y-6">
                <div className="space-y-2"><div className="flex justify-between text-[9px] font-black text-zinc-500 uppercase"><span>Sensitivity</span><span className="text-purple-500">{(sensitivity * 1000).toFixed(0)}</span></div><input type="range" min="0.001" max="0.1" step="0.001" value={sensitivity} onChange={(e) => setSensitivity(parseFloat(e.target.value))} className="w-full h-1 bg-zinc-800 rounded-lg appearance-none accent-purple-500" /></div>
                <div className="space-y-2"><div className="flex justify-between text-[9px] font-black text-zinc-500 uppercase"><span>Gain</span><span className="text-purple-500">x{micBoost.toFixed(1)}</span></div><input type="range" min="1" max="10" step="0.5" value={micBoost} onChange={(e) => setMicBoost(parseFloat(e.target.value))} className="w-full h-1 bg-zinc-800 rounded-lg appearance-none accent-purple-500" /></div>
              </div>
           </div>
        </div>
      )}

      {!isStarted && !isConfiguring && (
        <div className="absolute inset-0 z-[100] bg-black flex flex-col items-center justify-center p-10">
          <div className="w-24 h-24 bg-white text-black rounded-[2.2rem] flex items-center justify-center mb-10 rotate-3"><Music size={40} /></div>
          <h2 className="text-5xl font-black mb-2 tracking-tighter uppercase italic leading-none text-center">Vocal<br/><span className="text-purple-500">Synth</span></h2>
          <button onClick={startSetupWizard} className="w-full max-w-xs bg-white text-black py-7 rounded-[2rem] font-black text-xl flex items-center justify-center gap-3 mt-10">ENTER STUDIO <ChevronRight size={24} /></button>
        </div>
      )}

      <style>{`
        @keyframes spin-slow { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .animate-spin-slow { animation: spin-slow 4s linear infinite; }
        .no-scrollbar::-webkit-scrollbar { display: none; }
      `}</style>
    </div>
  );
};

export default App;
