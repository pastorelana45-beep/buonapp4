import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import * as Tone from 'tone';
import { 
  Music, Settings, Mic, Play, Square, Volume2, Trash2, 
  Activity, Disc, History, ChevronRight, XCircle, 
  Volume1, VolumeX, Mic2, Sparkles
} from 'lucide-react';

// --- TIPI E COSTANTI ---
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
  { id: 'rock-organ', name: 'ROCK ORGAN', category: 'ORGAN' },
  { id: 'finger-bass', name: 'FINGER BASS', category: 'BASS' },
  { id: 'strings-1', name: 'STRINGS 1', category: 'STRINGS' },
  { id: 'saw-lead', name: 'SAW LEAD', category: 'SYNTH' },
];

// --- LOGICA DI RILEVAMENTO PITCH (YIN) ---
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
    if (yinBuffer[t] < threshold) { tau = t; break; }
  }
  if (tau === -1) return null;
  return sampleRate / tau;
}

function frequencyToMidi(frequency: number): number {
  return Math.round(69 + 12 * Math.log2(frequency / 440));
}

function midiToNoteName(midi: number): string {
  const notes = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const m = Math.round(midi);
  return notes[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
}

// --- APP COMPONENT ---
const App: React.FC = () => {
  const [selectedInstrument, setSelectedInstrument] = useState<Instrument>(INSTRUMENTS[0]);
  const [mode, setMode] = useState<WorkstationMode>(WorkstationMode.IDLE);
  const [isStarted, setIsStarted] = useState(false);
  const [currentMidiNote, setCurrentMidiNote] = useState<number | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [sessions, setSessions] = useState<StudioSession[]>([]);
  const [rmsVolume, setRmsVolume] = useState(0);
  const [sensitivity, setSensitivity] = useState(0.015);
  const [micBoost, setMicBoost] = useState(2.5);
  const [isMonitorOn, setIsMonitorOn] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const synthRef = useRef<Tone.PolySynth | null>(null);
  const micRef = useRef<Tone.UserMedia | null>(null);
  const analyserRef = useRef<Tone.Analyser | null>(null);
  const recorderRef = useRef<Tone.Recorder | null>(null);
  const voicePassthroughRef = useRef<Tone.Gain | null>(null);
  
  const stateRef = useRef({ mode, lastMidi: null as number | null, micBoost, sensitivity });
  const recordingNotesRef = useRef<RecordedNote[]>([]);
  const recordingStartTimeRef = useRef<number>(0);
  const activeNoteStartRef = useRef<{ note: string, start: number } | null>(null);

  useEffect(() => {
    stateRef.current = { mode, lastMidi: currentMidiNote, micBoost, sensitivity };
    if (synthRef.current) {
        // Muto se non siamo in modalità musicale
        synthRef.current.volume.value = (mode === WorkstationMode.MIDI || mode === WorkstationMode.RECORD) ? 0 : -Infinity;
    }
    if (voicePassthroughRef.current) {
        voicePassthroughRef.current.gain.value = (isMonitorOn && mode === WorkstationMode.VOICE) ? 1 : 0;
    }
  }, [mode, currentMidiNote, micBoost, sensitivity, isMonitorOn]);

  const applyInstrumentSettings = (instrument: Instrument) => {
    if (!synthRef.current) return;
    let type: any = 'triangle';
    if (instrument.category === 'PIANO') type = 'triangle8';
    if (instrument.category === 'SYNTH') type = 'fatsawtooth';
    synthRef.current.set({ oscillator: { type } });
  };

  const initAudio = async () => {
    await Tone.start();
    const synth = new Tone.PolySynth(Tone.Synth, { maxPolyphony: 8 }).toDestination();
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
    
    setIsStarted(true);
    audioLoop();
  };

  const audioLoop = () => {
    if (!analyserRef.current || !synthRef.current) return;
    const buffer = analyserRef.current.getValue() as Float32Array;
    
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) sum += (buffer[i] * stateRef.current.micBoost) ** 2;
    const rms = Math.sqrt(sum / buffer.length);
    setRmsVolume(rms);

    const isMusicMode = stateRef.current.mode === WorkstationMode.MIDI || stateRef.current.mode === WorkstationMode.RECORD;

    if (rms > stateRef.current.sensitivity && isMusicMode) {
      const freq = detectPitch(buffer, Tone.getContext().sampleRate);
      const midi = freq ? frequencyToMidi(freq) : null;

      if (midi && midi !== stateRef.current.lastMidi) {
        if (stateRef.current.lastMidi) synthRef.current.triggerRelease(midiToNoteName(stateRef.current.lastMidi));
        
        const noteName = midiToNoteName(midi);
        synthRef.current.triggerAttack(noteName);
        setCurrentMidiNote(midi);

        if (stateRef.current.mode === WorkstationMode.RECORD) {
          activeNoteStartRef.current = { note: noteName, start: Tone.now() - recordingStartTimeRef.current };
        }
      }
    } else if (stateRef.current.lastMidi) {
      synthRef.current.triggerRelease(midiToNoteName(stateRef.current.lastMidi));
      if (stateRef.current.mode === WorkstationMode.RECORD && activeNoteStartRef.current) {
        recordingNotesRef.current.push({
          note: activeNoteStartRef.current.note,
          time: activeNoteStartRef.current.start,
          duration: (Tone.now() - recordingStartTimeRef.current) - activeNoteStartRef.current.start
        });
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
      setMode(WorkstationMode.RECORD);
      setIsRecording(true);
    } else {
      const blob = await recorderRef.current?.stop();
      const url = blob ? URL.createObjectURL(blob) : '';
      setSessions([{
        id: Date.now().toString(),
        timestamp: Date.now(),
        midiNotes: [...recordingNotesRef.current],
        audioUrl: url,
        instrumentName: selectedInstrument.name
      }, ...sessions]);
      setIsRecording(false);
      setMode(WorkstationMode.IDLE);
      synthRef.current?.releaseAll();
    }
  };

  return (
    <div className="fixed inset-0 bg-black text-white flex flex-col font-sans">
      <header className="p-4 border-b border-white/10 flex justify-between items-center bg-zinc-900">
        <h1 className="text-xs font-black uppercase tracking-widest text-purple-500">VocalSynth Pro</h1>
        {isStarted && <button onClick={() => setShowSettings(!showSettings)} className="p-2 bg-white/5 rounded-full"><Settings size={18}/></button>}
      </header>

      {!isStarted ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-6">
          <div className="w-20 h-20 bg-white rounded-3xl flex items-center justify-center text-black"><Music size={40}/></div>
          <button onClick={initAudio} className="px-8 py-4 bg-purple-600 rounded-2xl font-black uppercase">Enter Studio</button>
        </div>
      ) : (
        <main className="flex-1 flex flex-col p-4 overflow-hidden">
          <div className="grid grid-cols-3 gap-2 mb-6">
            <button onClick={() => { synthRef.current?.releaseAll(); setMode(mode === WorkstationMode.MIDI ? WorkstationMode.IDLE : WorkstationMode.MIDI); }} className={`p-4 rounded-xl flex flex-col items-center gap-2 ${mode === WorkstationMode.MIDI ? 'bg-purple-600' : 'bg-zinc-900 text-zinc-500'}`}><Activity size={20}/> MIDI</button>
            <button onClick={() => setMode(mode === WorkstationMode.VOICE ? WorkstationMode.IDLE : WorkstationMode.VOICE)} className={`p-4 rounded-xl flex flex-col items-center gap-2 ${mode === WorkstationMode.VOICE ? 'bg-blue-600' : 'bg-zinc-900 text-zinc-500'}`}><Mic2 size={20}/> VOICE</button>
            <button onClick={toggleRecording} className={`p-4 rounded-xl flex flex-col items-center gap-2 ${isRecording ? 'bg-red-600 animate-pulse' : 'bg-zinc-900 text-zinc-500'}`}>{isRecording ? <Square size={20} fill="white"/> : <Disc size={20}/>} REC</button>
          </div>

          <div className="flex-1 overflow-y-auto space-y-2 no-scrollbar">
            {!showHistory ? (
               <div className="grid grid-cols-2 gap-2">
                 {INSTRUMENTS.map(i => (
                   <button key={i.id} onClick={() => {setSelectedInstrument(i); applyInstrumentSettings(i);}} className={`p-4 rounded-xl text-left border-2 ${selectedInstrument.id === i.id ? 'border-purple-600 bg-zinc-900' : 'border-transparent bg-zinc-900/40'}`}>
                     <p className="text-[10px] font-black">{i.name}</p>
                   </button>
                 ))}
               </div>
            ) : (
              sessions.map(s => (
                <div key={s.id} className="p-4 bg-zinc-900 rounded-xl flex justify-between items-center">
                  <span className="text-[10px] font-bold">{s.instrumentName}</span>
                  <button onClick={() => {
                    const now = Tone.now();
                    s.midiNotes.forEach(n => synthRef.current?.triggerAttackRelease(n.note, n.duration, now + n.time));
                  }} className="p-2 bg-purple-600 rounded-lg"><Play size={12}/></button>
                </div>
              ))
            )}
          </div>

          <div className="mt-4 p-6 bg-zinc-900 rounded-3xl flex justify-between items-center">
             <div className="flex items-center gap-4">
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${isRecording ? 'bg-red-600' : 'bg-purple-600'}`}><Mic size={20}/></div>
                <div><p className="text-[8px] text-zinc-500 uppercase">{mode}</p><p className="font-black">{currentMidiNote ? midiToNoteName(currentMidiNote) : '--'}</p></div>
             </div>
             <button onClick={() => setShowHistory(!showHistory)} className="text-[10px] font-black uppercase text-purple-500">{showHistory ? 'Back' : 'History'}</button>
          </div>
        </main>
      )}

      {showSettings && (
        <div className="absolute inset-0 bg-black/90 z-[100] p-10 flex flex-col justify-center">
           <h3 className="text-xl font-black mb-6">SETTINGS</h3>
           <label className="text-[10px] text-zinc-500 mb-2">SENSITIVITY</label>
           <input type="range" min="0.001" max="0.1" step="0.001" value={sensitivity} onChange={(e) => setSensitivity(parseFloat(e.target.value))} className="w-full mb-6"/>
           <button onClick={() => setShowSettings(false)} className="w-full py-4 bg-white text-black font-black rounded-xl">CLOSE</button>
        </div>
      )}
    </div>
  );
};

export default App;
