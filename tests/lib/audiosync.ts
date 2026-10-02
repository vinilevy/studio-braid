/**
 * Locates where each source audio session landed in the exported WAV, by normalized
 * cross-correlation of a loud excerpt of the source against the export around its expected
 * position. Works on real projects (no markers needed) with sub-millisecond resolution.
 */
import { ffmpegBuffer } from './exec.ts';

export const CORR_RATE = 8000;

const toFloat32 = (buf: Buffer): Float32Array => {
  const bytes = buf.byteLength - (buf.byteLength % 4);
  const ab = new ArrayBuffer(bytes);
  new Uint8Array(ab).set(buf.subarray(0, bytes));
  return new Float32Array(ab);
};

/**
 * Decodes a window with input seeking. Only exact for PCM (WAV) — do NOT use on AAC sources:
 * after a seek FFmpeg does not re-apply the encoder-priming edit list (≈21 ms error).
 */
export async function decodeMono(file: string, startSec: number, durSec: number, rate = CORR_RATE): Promise<Float32Array> {
  return toFloat32(await ffmpegBuffer(['-ss', Math.max(0, startSec).toFixed(6), '-t', durSec.toFixed(6), '-i', file, '-vn', '-ac', '1', '-ar', String(rate), '-f', 'f32le', '-']));
}

const fullDecodes = new Map<string, Promise<Float32Array>>();
/** Decodes a whole (compressed) source from t=0, honouring edit lists; cached per file. */
export function decodeWholeMono(file: string, rate = CORR_RATE): Promise<Float32Array> {
  const key = `${file}@${rate}`;
  let pending = fullDecodes.get(key);
  if (!pending) {
    pending = ffmpegBuffer(['-i', file, '-vn', '-ac', '1', '-ar', String(rate), '-f', 'f32le', '-']).then(toFloat32);
    fullDecodes.set(key, pending);
  }
  return pending;
}

const rms = (x: Float32Array, from: number, len: number): number => {
  let s = 0;
  for (let i = from; i < from + len && i < x.length; i++) s += (x[i] as number) ** 2;
  return Math.sqrt(s / Math.max(1, len));
};

/** Loudest window of `winSec` inside `x`, scanned every `stepSec`. Returns offset in seconds. */
export function loudestWindow(x: Float32Array, rate: number, winSec: number, stepSec = 0.25): { offsetSec: number; rms: number } {
  const win = Math.round(winSec * rate);
  const step = Math.max(1, Math.round(stepSec * rate));
  let best = { offsetSec: 0, rms: 0 };
  for (let i = 0; i + win <= x.length; i += step) {
    const r = rms(x, i, win);
    if (r > best.rms) best = { offsetSec: i / rate, rms: r };
  }
  return best;
}

/** Normalized cross-correlation; returns the (sub-sample) lag where `template` best matches `haystack`. */
export function locate(template: Float32Array, haystack: Float32Array): { lag: number; score: number } {
  const n = template.length;
  const lags = haystack.length - n + 1;
  if (n === 0 || lags <= 0) return { lag: NaN, score: 0 };
  let tEnergy = 0;
  for (let i = 0; i < n; i++) tEnergy += (template[i] as number) ** 2;
  // Sliding energy of the haystack via prefix sums.
  const prefix = new Float64Array(haystack.length + 1);
  for (let i = 0; i < haystack.length; i++) prefix[i + 1] = (prefix[i] as number) + (haystack[i] as number) ** 2;
  const scores = new Float64Array(lags);
  let bestLag = 0;
  let bestScore = -Infinity;
  for (let lag = 0; lag < lags; lag++) {
    let dot = 0;
    for (let i = 0; i < n; i++) dot += (template[i] as number) * (haystack[lag + i] as number);
    const hEnergy = (prefix[lag + n] as number) - (prefix[lag] as number);
    const score = hEnergy > 0 && tEnergy > 0 ? dot / Math.sqrt(tEnergy * hEnergy) : 0;
    scores[lag] = score;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  // Parabolic refinement around the peak.
  let refined = bestLag;
  if (bestLag > 0 && bestLag < lags - 1) {
    const a = scores[bestLag - 1] as number;
    const b = scores[bestLag] as number;
    const c = scores[bestLag + 1] as number;
    const denom = a - 2 * b + c;
    if (denom !== 0) refined = bestLag + (0.5 * (a - c)) / denom;
  }
  return { lag: refined, score: bestScore };
}

export interface PlacementProbe {
  /** Position of the excerpt inside the source session (seconds from session start). */
  sourceOffsetSec: number;
  /** Measured position in the export minus expected position (timelineStart + sourceOffset), ms. */
  offsetMs?: number;
  score: number;
  silent: boolean;
}

/**
 * Measures how far the excerpt that starts `sourceOffsetSec` into the source session landed
 * from its expected place (timelineStartMs + sourceOffsetSec) in the export.
 */
export async function measurePlacement(
  sourceFile: string,
  exportFile: string,
  timelineStartMs: number,
  searchFromSec: number,
  searchToSec: number,
  opts: { winSec?: number; marginSec?: number } = {},
): Promise<PlacementProbe> {
  const winSec = opts.winSec ?? 1.0;
  const margin = opts.marginSec ?? 0.3;
  const span = Math.max(winSec, searchToSec - searchFromSec);
  const whole = await decodeWholeMono(sourceFile);
  const from = Math.round(searchFromSec * CORR_RATE);
  const region = whole.subarray(from, Math.min(whole.length, from + Math.round(span * CORR_RATE)));
  const best = loudestWindow(region, CORR_RATE, winSec);
  const sourceOffsetSec = searchFromSec + best.offsetSec;
  if (best.rms < 0.003) return { sourceOffsetSec, score: 0, silent: true };
  const start = Math.round(best.offsetSec * CORR_RATE);
  const template = region.subarray(start, start + Math.round(winSec * CORR_RATE));
  const expectedSec = timelineStartMs / 1000 + sourceOffsetSec;
  const haystackStart = Math.max(0, expectedSec - margin);
  const haystack = await decodeMono(exportFile, haystackStart, winSec + 2 * margin);
  const { lag, score } = locate(template, haystack);
  const foundSec = haystackStart + lag / CORR_RATE;
  return { sourceOffsetSec, offsetMs: (foundSec - expectedSec) * 1000, score, silent: false };
}
