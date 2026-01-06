
export interface Instrument {
  id: string;
  name: string;
  category: string;
  icon?: string;
}

export enum WorkstationMode {
  IDLE = 'IDLE',
  MIDI = 'MIDI',
  VOICE = 'VOICE',
  RECORD = 'RECORD'
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

export enum Category {
  ALL = 'ALL',
  PIANO = 'PIANO',
  KEYS = 'KEYS',
  PERC = 'PERC',
  ORGAN = 'ORGAN',
  GUITAR = 'GUITAR',
  BASS = 'BASS',
  STRINGS = 'STRINGS',
  BRASS = 'BRASS',
  REED = 'REED',
  SYNTH = 'SYNTH',
  ETHNIC = 'ETHNIC'
}
