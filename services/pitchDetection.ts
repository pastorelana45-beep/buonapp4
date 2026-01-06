
/**
 * Pitch Detection tramite algoritmo YIN semplificato
 * Più robusto dell'auto-correlazione per la voce umana
 */
export function detectPitch(buffer: Float32Array, sampleRate: number): number | null {
  const threshold = 0.15; // Tolleranza per l'errore
  const SIZE = buffer.length;
  const yinBuffer = new Float32Array(Math.floor(SIZE / 2));

  // Step 1: Difference function
  for (let tau = 0; tau < yinBuffer.length; tau++) {
    for (let i = 0; i < yinBuffer.length; i++) {
      const delta = buffer[i] - buffer[i + tau];
      yinBuffer[tau] += delta * delta;
    }
  }

  // Step 2: Cumulative mean normalized difference function
  yinBuffer[0] = 1;
  let runningSum = 0;
  for (let tau = 1; tau < yinBuffer.length; tau++) {
    runningSum += yinBuffer[tau];
    yinBuffer[tau] *= tau / (runningSum || 1);
  }

  // Step 3: Absolute threshold
  let tau = -1;
  for (let t = 1; t < yinBuffer.length; t++) {
    if (yinBuffer[t] < threshold) {
      tau = t;
      break;
    }
  }

  // Se non troviamo nulla sotto la soglia, cerchiamo il minimo globale
  if (tau === -1) {
    let minVal = 1;
    for (let t = 1; t < yinBuffer.length; t++) {
      if (yinBuffer[t] < minVal) {
        minVal = yinBuffer[t];
        tau = t;
      }
    }
    if (minVal > 0.4) return null; // Troppo rumore
  }

  // Step 4: Parabolic interpolation per precisione
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

export function frequencyToMidi(frequency: number): number {
  if (!frequency || frequency <= 0) return 0;
  return Math.round(69 + 12 * Math.log2(frequency / 440));
}

export function midiToNoteName(midi: number): string {
  if (midi === null || midi === undefined || isNaN(midi) || !isFinite(midi)) {
    return "--";
  }
  
  const notes = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const m = Math.round(midi);
  const octave = Math.floor(m / 12) - 1;
  const noteIndex = ((m % 12) + 12) % 12; // Gestisce correttamente i numeri negativi
  
  return String(notes[noteIndex]) + String(octave);
}
