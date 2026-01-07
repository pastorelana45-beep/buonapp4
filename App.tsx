import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import * as Tone from 'tone';
import { 
  Music, Settings, Mic, Play, Square, Volume2, Trash2, 
  Activity, Disc, History, AudioWaveform, Clock, 
  ChevronRight, XCircle, Volume1, VolumeX, Layers, Mic2, Sparkles
} from 'lucide-react';
import { GoogleGenerativeAI } from "@google/generative-ai";

// --- TIPI E COSTANTI (Integrati per evitare errori di import) ---

export enum WorkstationMode {
  IDLE = 'IDLE',
  MIDI = 'MIDI',
  VOICE = 'VOICE',
  RECORD = 'RECORD'
}

export interface Instrument {
  id: string;
  name: string;
  category: string;
}

export interface RecordedNote {
  note: string;
  time: number;
  duration: number;
}

export interface StudioSession {
  id: string;
  timestamp: number;
  midiNotes: RecordedNote[];
  audioUrl: string;
  instrumentName: string;
}

const INSTRUMENTS: Instrument[] = [
  { id: 'grand-piano', name: 'GRAND PIANO', category: 'PIANO' },
  { id: 'rhodes-piano', name: 'RHODES PIANO', category: 'KEYS' },
  { id: 'marimba', name: 'MARIMBA', category: 'PERC' },
  { id: 'rock-organ', name: 'ROCK ORGAN', category: 'ORGAN' },
  { id: 'nylon-guitar', name: 'NYLON GUITAR', category: 'GUITAR' },
  { id: 'finger-bass', name: 'FINGER BASS', category: 'BASS' },
  { id: 'strings-1', name: 'STRINGS 1', category: 'STRINGS' },
  { id: 'saw-lead', name: 'SAW LEAD', category: 'SYNTH' },
];

// --- LOGICA DI RILEVAMENTO PITCH (Algoritmo YIN) ---

function detectPitch(buffer: Float32Array, sampleRate: number): number | null {
  const threshold = 0.15;
  const SIZE = buffer.length;
  const yinBuffer = new Float32Array(Math.floor(SIZE / 2));

  for (let tau = 0; tau < yinBuffer.length; tau++) {
    for (let i = 0; i < yinBuffer.length; i++) {
      const delta = buffer[i] - buffer[i + tau];
      yinBuffer[tau] += delta * delta;
    }
  }

  yinBuffer[0] = 1;
  let runningSum = 0;
  for (let tau = 1; tau < yinBuffer.length; tau++) {
    runningSum += yinBuffer[tau];
    yinBuffer[tau] *= tau / (runningSum || 1);
  }

  let tau = -1;
  for (let t = 1; t < yinBuffer.length; t++) {
    if (yinBuffer[t] < threshold) {
      tau = t;
      break;
    }
  }

  if (tau === -1) {
    let minVal = 1;
    for (let t = 1; t < yinBuffer.length; t++) {
      if (yinBuffer[t] < minVal) {
        minVal = yinBuffer[t];
        tau = t;
      }
    }
    if (minVal > 0.4) return null;
  }

  if (tau > 0 && tau < yinBuffer.length - 1) {
    const s0 = yinBuffer[tau - 1];
    const s1 = yinBuffer[tau];
    const s2 = yinBuffer[tau + 1];
    const denominator = 2 * (2 * s1 - s2 - s0);
    if (denominator !== 0) {
      const betterTau = tau + (s2 - s0) / denominator;
      return sampleRate / betterTau;
    }
  }

  return tau > 0 ? sampleRate / tau : null;
}

function frequencyToMidi(frequency: number): number {
  if (!frequency || frequency <= 0) return 0;
  return Math.round(69 + 12 * Math.log2(frequency / 440));
}

function midiToNoteName(midi: number): string {
  if (midi === null || isNaN(midi)) return "--";
  const notes = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const m = Math.round(midi);
  const noteIndex = ((m % 12) + 12) % 12;
  const octave = Math.floor(m / 12) - 1;
  return notes[noteIndex] + octave;
}

// --- COMPONENTE PRINCIPALE APP ---

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
  const voicePassthroughRef = useRef<Tone.Gain | null>(null);
  const playerRef = useRef<Tone.Player | null>(null);
  
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
    
    if (instrument.category === 'PIANO' || instrument.category === 'KEYS') {
      settings = { oscillator: { type: 'triangle8' }, envelope: { attack: 0.005, decay: 0.2, sustain: 0.3, release: 1.2 } };
    } else if (instrument.category === 'STRINGS') {
      settings = { oscillator: { type: 'sawtooth' }, envelope: { attack: 0.4, decay: 0.4, sustain: 0.8, release: 1.5 } };
    } else if (instrument.category === 'SYNTH') {
      settings = { oscillator: { type: 'fatsawtooth', count: 3, spread: 30 }, envelope: { attack: 0.05, decay: 0.3, sustain: 0.4, release: 0.8 } };
    } else if (instrument.category === 'BASS') {
      settings = { oscillator: { type: 'square' }, envelope: { attack: 0.01, decay: 0.1, sustain: 0.6, release: 0.2 } };
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

  const initAudioCore = async () => {
    if (synthRef.current) return true;
    try {
      await Tone.start();
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
      console.error(err);
      return false;
    }
  };

  const audioLoop = () => {
    if (!analyserRef.current || !synthRef.current) return;
    const buffer = analyserRef.current.getValue() as Float32Array;
    
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) {
      const boosted = buffer[i] * stateRef.current.micBoost;
      sum += boosted * boosted;
    }
    const rms = Math.sqrt(sum / buffer.length);
    setRmsVolume(prev => prev * 0.7 + rms * 0.3);

    if (!stateRef.current.isPlayingBack) {
      const isMidiActive = stateRef.current.mode === WorkstationMode.MIDI || stateRef.current.mode === WorkstationMode.RECORD;
      if (rms > stateRef.current.sensitivity && isMidiActive) {
        const freq = detectPitch(buffer, Tone.getContext().sampleRate);
        const midi = freq ? frequencyToMidi(freq) : null;

        if (midi !== null && midi !== stateRef.current.lastMidi) {
          const noteName = midiToNoteName(midi);
          if (stateRef.current.lastMidi !== null) {
            synthRef.current.triggerRelease(midiToNoteName(stateRef.current.lastMidi));
          }
          synthRef.current.triggerAttack(noteName);
          setCurrentMidiNote(midi);
          
          if (stateRef.current.mode === WorkstationMode.RECORD) {
            const startTime = Tone.now() - recordingStartTimeRef.current;
            activeNoteStartRef.current = { note: noteName, start: startTime, time: startTime };
          }
        }
      } else if (stateRef.current.lastMidi !== null) {
        synthRef.current.triggerRelease(midiToNoteName(stateRef.current.lastMidi));
        if (stateRef.current.mode === WorkstationMode.RECORD && activeNoteStartRef.current) {
          const duration = Tone.now() - recordingStartTimeRef.current - activeNoteStartRef.current.start;
          if (duration >= MIN_NOTE_DURATION) {
            recordingNotesRef.current.push({ ...activeNoteStartRef.current, duration });
          }
          activeNoteStartRef.current = null;
        }
        setCurrentMidiNote(null);
      }
    }
    requestAnimationFrame(audioLoop);
  };

  const startSetupWizard = async () => {
    setIsConfiguring(true);
    const success = await initAudioCore();
    if (success) {
      setSetupStep('COMPLETE');
      audioLoop();
    } else {
      setIsConfiguring(false);
      alert("Microphone Access Required");
    }
  };

  const toggleRecording = async () => {
    if (!isRecording) {
      recordingNotesRef.current = [];
      recordingStartTimeRef.current = Tone.now();
      recorderRef.current?.start();
      setIsRecording(true);
      setMode(WorkstationMode.RECORD);
    } else {
      const blob = await recorderRef.current?.stop();
      if (blob) {
        const url = URL.createObjectURL(blob);
        setSessions(prev => [{
          id: Math.random().toString(36).substr(2, 9),
          timestamp: Date.now(),
          midiNotes: [...recordingNotesRef.current],
          audioUrl: url,
          instrumentName: selectedInstrument.name
        }, ...prev]);
      }
      setIsRecording(false);
      setMode(WorkstationMode.IDLE);
      synthRef.current?.releaseAll();
    }
  };

  return (
    <div className="fixed inset-0 bg-black text-white flex flex-col overflow-hidden font-sans select-none">
      {/* Header */}
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

      {/* Volume Visualizer */}
      {isStarted && (
        <div className="w-full h-1 bg-zinc-900">
          <div className="h-full bg-purple-500 transition-all duration-75" style={{ width: `${Math.min(100, (rmsVolume / 0.3) * 100)}%` }} />
        </div>
      )}

      {/* Main App */}
      {!isStarted ? (
        <div className="absolute inset-0 z-[100] bg-black flex flex-col items-center justify-center p-10">
          {!isConfiguring ? (
            <>
              <div className="w-24 h-24 bg-white text-black rounded-[2.2rem] flex items-center justify-center mb-10 rotate-3"><Music size={40} /></div>
              <h2 className="text-5xl font-black mb-2 tracking-tighter uppercase italic leading-none text-center">Vocal<br/><span className="text-purple-500">Synth</span></h2>
              <button onClick={startSetupWizard} className="w-full max-w-xs bg-white text-black py-7 rounded-[2rem] font-black text-xl flex items-center justify-center gap-3 mt-10">ENTER STUDIO <ChevronRight size={24} /></button>
            </>
          ) : (
            <div className="flex flex-col items-center animate-pulse">
              <Mic size={48} className="text-purple-500 mb-6" />
              <h3 className="text-2xl font-black uppercase mb-10">{setupStep}</h3>
              {setupStep === 'COMPLETE' && (
                <button onClick={() => { setIsConfiguring(false); setIsStarted(true); }} className="px-10 bg-white text-black py-5 rounded-2xl font-black uppercase italic">Start Experience</button>
              )}
            </div>
          )}
        </div>
      ) : (
        <main className="flex-1 flex flex-col px-5 pb-24 overflow-hidden">
          {/* Controls */}
          <section className="grid grid-cols-3 gap-3 my-5 shrink-0">
            <button onClick={() => setMode(WorkstationMode.MIDI)} className={`py-5 rounded-2xl flex flex-col items-center gap-2 border-2 transition-all ${mode === WorkstationMode.MIDI ? 'bg-purple-600 border-purple-600' : 'bg-zinc-900 border-transparent text-zinc-500'}`}>
              <Activity size={20} strokeWidth={3} /><span className="text-[8px] font-black tracking-widest">MIDI</span>
            </button>
            <button onClick={() => setMode(WorkstationMode.VOICE)} className={`py-5 rounded-2xl flex flex-col items-center gap-2 border-2 transition-all ${mode === WorkstationMode.VOICE ? 'bg-blue-600 border-blue-600' : 'bg-zinc-900 border-transparent text-zinc-500'}`}>
              <Mic2 size={20} strokeWidth={3} /><span className="text-[8px] font-black tracking-widest">VOICE</span>
            </button>
            <button onClick={toggleRecording} className={`py-5 rounded-2xl flex flex-col items-center gap-2 border-2 transition-all ${isRecording ? 'bg-red-600 border-red-600 animate-pulse' : 'bg-zinc-900 border-transparent text-zinc-500'}`}>
              {isRecording ? <Square size={20} fill="white" strokeWidth={0} /> : <Disc size={20} strokeWidth={3} />}<span className="text-[8px] font-black tracking-widest">{isRecording ? 'STOP' : 'REC'}</span>
            </button>
          </section>

          {/* Browser / History */}
          <div className="flex gap-4 mb-3 border-b border-white/5 px-2">
            <button onClick={() => setShowHistory(false)} className={`pb-2 text-[10px] font-black uppercase tracking-widest ${!showHistory ? 'text-purple-500 border-b-2 border-purple-500' : 'text-zinc-600'}`}>Browser</button>
            <button onClick={() => setShowHistory(true)} className={`pb-2 text-[10px] font-black uppercase tracking-widest ${showHistory ? 'text-purple-500 border-b-2 border-purple-500' : 'text-zinc-600'}`}>History ({sessions.length})</button>
          </div>

          <div className="flex-1 overflow-y-auto no-scrollbar rounded-3xl bg-zinc-900/20 border border-white/5 p-4">
            {!showHistory ? (
              <div className="grid grid-cols-2 gap-2">
                {INSTRUMENTS.map(inst => (
                  <button key={inst.id} onClick={() => setSelectedInstrument(inst)} className={`p-4 rounded-xl border-2 transition-all text-left flex flex-col h-20 justify-between ${selectedInstrument.id === inst.id ? 'bg-zinc-900 border-purple-600' : 'bg-zinc-900/30 border-transparent'}`}>
                    <Music size={14} className={selectedInstrument.id === inst.id ? 'text-purple-500' : 'text-zinc-800'} />
                    <span className={`text-[9px] font-bold uppercase tracking-tighter truncate ${selectedInstrument.id === inst.id ? 'text-white' : 'text-zinc-600'}`}>{inst.name}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="space-y-3">
                {sessions.map(s => (
                  <div key={s.id} className="p-4 bg-zinc-900/60 rounded-2xl border border-white/5 flex flex-col gap-3">
                    <div className="flex justify-between">
                       <span className="text-[9px] font-black text-purple-400 uppercase">{s.instrumentName}</span>
                       <button onClick={() => setSessions(prev => prev.filter(x => x.id !== s.id))}><Trash2 size={14} className="text-zinc-800" /></button>
                    </div>
                    <button onClick={() => {
                        const now = Tone.now();
                        s.midiNotes.forEach(n => synthRef.current?.triggerAttackRelease(n.note, n.duration, now + n.time));
                    }} className="py-2 bg-black rounded-lg text-[8px] font-bold">PLAY MIDI</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Bottom Bar */}
          <div className="fixed bottom-4 left-4 right-4 z-[60]">
            <div className="bg-zinc-950/90 backdrop-blur-2xl border border-white/10 p-4 rounded-[2rem] flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className={`w-12 h-12 rounded-2xl flex items-center justify-center ${isRecording ? 'bg-red-600' : 'bg-purple-600'}`}>
                  {isRecording ? <Disc size={20} className="animate-spin" /> : <Mic size={20} />}
                </div>
                <div>
                  <p className="text-[9px] font-black uppercase text-zinc-500">{mode}</p>
                  <p className="text-[10px] font-black tracking-widest">{currentMidiNote ? midiToNoteName(currentMidiNote) : '---'}</p>
                </div>
              </div>
              <p className="text-3xl font-mono font-black italic text-purple-500 pr-4">{currentMidiNote ? midiToNoteName(currentMidiNote).replace(/\d/g, '') : '--'}</p>
            </div>
          </div>
        </main>
      )}

      {/* Settings Modal */}
      {showSettings && (
        <div className="absolute inset-0 z-[150] bg-black/90 flex items-center justify-center p-8 animate-in fade-in">
           <div className="w-full max-w-xs bg-zinc-900 p-8 rounded-[2.5rem] border border-white/10 relative">
              <button onClick={() => setShowSettings(false)} className="absolute top-6 right-6 p-2 bg-zinc-800 rounded-full"><XCircle size={18} /></button>
              <h3 className="text-lg font-black uppercase italic mb-8">Settings</h3>
              <div className="space-y-6">
                <div className="space-y-2">
                  <div className="flex justify-between text-[9px] font-black text-zinc-500 uppercase"><span>Sensitivity</span><span className="text-purple-500">{(sensitivity * 1000).toFixed(0)}</span></div>
                  <input type="range" min="0.001" max="0.1" step="0.001" value={sensitivity} onChange={(e) => setSensitivity(parseFloat(e.target.value))} className="w-full h-1 bg-zinc-800 rounded-lg appearance-none accent-purple-500" />
                </div>
                <div className="space-y-2">
                  <div className="flex justify-between text-[9px] font-black text-zinc-500 uppercase"><span>Mic Gain</span><span className="text-purple-500">x{micBoost.toFixed(1)}</span></div>
                  <input type="range" min="1" max="10" step="0.5" value={micBoost} onChange={(e) => setMicBoost(parseFloat(e.target.value))} className="w-full h-1 bg-zinc-800 rounded-lg appearance-none accent-purple-500" />
                </div>
              </div>
           </div>
        </div>
      )}

      <style>{`
        .no-scrollbar::-webkit-scrollbar { display: none; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .animate-spin { animation: spin 4s linear infinite; }
      `}</style>
    </div>
  );
};

export default App;
