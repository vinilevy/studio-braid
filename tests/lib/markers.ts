/**
 * Content-based sync check for mock bundles.
 *
 * Every mock session carries the same events in all four tracks: white flashes on SCREEN/CAMERA
 * and tone bursts on MICROPHONE (low tone) / SYSTEM_AUDIO (high tone). Session i starts with a
 * burst of (i % 5) + 1 pulses, so a missing, duplicated or reordered session is identifiable by
 * content — not only by duration. The ground truth lives next to the bundle in <bundle>.truth.json.
 */
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { ffmpeg } from './exec.ts';
import { probe, videoStream } from './ffprobe.ts';
import type { OutputLayout } from './layout.ts';
import { ms, Report, signedMs } from './report.ts';
import { fmtMs, KIND_LABEL, OUTPUT_FILE, type MediaKind } from './screenstudio.ts';

export interface TruthMarker {
  session: number;
  kind: 'burst' | 'late';
  pulses: number;
  /** Onset of the first pulse in the exported, pause-free timeline. */
  timeMs: number;
}

export interface MockTruth {
  schema: 'ssb-mock-truth/1';
  projectName: string;
  layout: 'ss4' | 'ss37';
  tracks: MediaKind[];
  sessions: { index: number; durationMs: number; timelineStartMs: number }[];
  timelineDurationMs: number;
  pulse: { onMs: number; offMs: number };
  beepHz: { microphone: number; systemAudio: number };
  resolution: { display: [number, number]; webcam: [number, number] };
  markers: TruthMarker[];
  quirks: Record<string, unknown>;
}

export interface DetectedBurst {
  timeMs: number;
  pulses: number;
}

const exists = (p: string) => access(p).then(() => true, () => false);

export async function findTruthFile(sourcePath: string): Promise<string | undefined> {
  const base = sourcePath.replace(/[\\/]+$/, '').replace(/\.zip$/i, '');
  for (const candidate of [`${base}.truth.json`, path.join(path.dirname(base), `${path.basename(base)}.truth.json`)]) {
    if (await exists(candidate)) return candidate;
  }
  return undefined;
}

export async function loadTruth(file: string): Promise<MockTruth> {
  const truth = JSON.parse(await readFile(file, 'utf8')) as MockTruth;
  if (truth.schema !== 'ssb-mock-truth/1') throw new Error(`Gabarito com schema desconhecido: ${file}`);
  return truth;
}

/** Groups pulse onsets (seconds) into bursts; pulses closer than `maxGapMs` belong together. */
export function groupBursts(onsetsMs: number[], maxGapMs: number): DetectedBurst[] {
  const bursts: DetectedBurst[] = [];
  let last = -Infinity;
  for (const t of [...onsetsMs].sort((a, b) => a - b)) {
    const current = bursts[bursts.length - 1];
    if (current && t - last <= maxGapMs) current.pulses++;
    else bursts.push({ timeMs: t, pulses: 1 });
    last = t;
  }
  return bursts;
}

export async function videoOnsets(file: string): Promise<number[]> {
  const { stdout } = await ffmpeg(['-v', 'error', '-i', file, '-an', '-vf', 'signalstats,metadata=mode=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-']);
  const onsets: number[] = [];
  let pts: number | undefined;
  let lit = false;
  for (const line of stdout.split('\n')) {
    const frame = /pts_time:([-\d.e]+)/.exec(line);
    if (frame) {
      pts = Number(frame[1]);
      continue;
    }
    const y = /YAVG=([\d.]+)/.exec(line);
    if (y && pts !== undefined) {
      const bright = Number(y[1]) > 140;
      if (bright && !lit) onsets.push(pts * 1000);
      lit = bright;
    }
  }
  return onsets;
}

export async function audioOnsets(file: string, hz: number): Promise<number[]> {
  const band = `bandpass=f=${hz}:width_type=q:w=3`;
  const { stderr } = await ffmpeg(['-v', 'info', '-i', file, '-vn', '-af', `${band},${band},silencedetect=n=-30dB:d=0.04`, '-f', 'null', '-']);
  const durationMs = ((await probe(file)).durationSec || Infinity) * 1000;
  const onsets: number[] = [];
  // silencedetect closes an open silence at EOF with a synthetic silence_end: that is not a tone onset.
  for (const m of stderr.matchAll(/silence_end: ([-\d.e]+)/g)) {
    const t = Number(m[1]) * 1000;
    if (t < durationMs - 30) onsets.push(t);
  }
  // A file that starts with a tone has no leading silence_end; detect it from the first silence_start.
  const firstStart = /silence_start: ([-\d.e]+)/.exec(stderr);
  if (firstStart && Number(firstStart[1]) > 0.02 && (onsets.length === 0 || Number(firstStart[1]) * 1000 < (onsets[0] ?? Infinity))) onsets.unshift(0);
  return onsets;
}

interface TrackDetection {
  kind: MediaKind;
  bursts: DetectedBurst[];
}

export async function checkMarkers(report: Report, truth: MockTruth, layout: OutputLayout, tol: number): Promise<void> {
  const period = truth.pulse.onMs + truth.pulse.offMs;
  const groupGap = period * 1.5;
  const detections: TrackDetection[] = [];

  for (const kind of truth.tracks) {
    const file = layout.media[kind]?.path;
    if (!file) continue;
    const label = KIND_LABEL[kind];
    if (kind === 'display' || kind === 'webcam') {
      const v = videoStream(await probe(file));
      const [w, h] = truth.resolution[kind];
      const [ow, oh] = kind === 'display' ? truth.resolution.webcam : truth.resolution.display;
      if (v && v.width === ow && v.height === oh && (ow !== w || oh !== h)) {
        report.fail(`swapped-${kind}`, label, `${OUTPUT_FILE[kind]} tem a resolução da OUTRA câmera (${ow}x${oh}): Tela e Câmera trocadas.`);
      }
      detections.push({ kind, bursts: groupBursts(await videoOnsets(file), groupGap) });
    } else {
      const own = truth.beepHz[kind];
      const other = kind === 'microphone' ? truth.beepHz.systemAudio : truth.beepHz.microphone;
      const ownBursts = groupBursts(await audioOnsets(file, own), groupGap);
      if (ownBursts.length === 0) {
        const foreign = groupBursts(await audioOnsets(file, other), groupGap);
        if (foreign.length > 0) report.fail(`swapped-${kind}`, label, `${OUTPUT_FILE[kind]} contém o tom da outra faixa (${other} Hz): Microfone e Áudio do sistema trocados.`);
      }
      detections.push({ kind, bursts: ownBursts });
    }
  }

  const header = ['sessão', 'marcador', 'esperado', ...detections.map((d) => OUTPUT_FILE[d.kind])];
  const rows: string[][] = [];
  let worstAbs = 0;
  let worstSpread = 0;
  const problems: string[] = [];
  const missingBySession = new Map<number, Set<MediaKind>>();

  for (const m of truth.markers) {
    const row = [String(m.session), m.kind === 'burst' ? `início ×${m.pulses}` : 'final', fmtMs(m.timeMs)];
    const measured: number[] = [];
    for (const d of detections) {
      const hit = d.bursts.find((b) => Math.abs(b.timeMs - m.timeMs) <= Math.max(500, tol * 3));
      if (!hit) {
        row.push('AUSENTE');
        problems.push(`sessão ${m.session} (${m.kind}) esperado em ${fmtMs(m.timeMs)} não encontrado em ${OUTPUT_FILE[d.kind]}`);
        if (!missingBySession.has(m.session)) missingBySession.set(m.session, new Set());
        missingBySession.get(m.session)?.add(d.kind);
        continue;
      }
      const dev = hit.timeMs - m.timeMs;
      measured.push(hit.timeMs);
      worstAbs = Math.max(worstAbs, Math.abs(dev));
      const countNote = m.kind === 'burst' && hit.pulses !== m.pulses ? ` (×${hit.pulses}≠×${m.pulses})` : '';
      if (countNote) problems.push(`sessão ${m.session}: ${OUTPUT_FILE[d.kind]} tem rajada ×${hit.pulses} onde o gabarito tem ×${m.pulses} (sessão errada nesta posição)`);
      row.push(`${signedMs(dev, 1)}${countNote}`);
    }
    if (measured.length > 1) worstSpread = Math.max(worstSpread, Math.max(...measured) - Math.min(...measured));
    rows.push(row);
  }
  report.table('Marcadores de conteúdo (flash/bip): desvio medido − esperado por faixa', header, rows);

  // Unexpected bursts = content that should not be in the export (orphan session, duplicated session…).
  for (const d of detections) {
    const extras = d.bursts.filter((b) => !truth.markers.some((m) => Math.abs(b.timeMs - m.timeMs) <= Math.max(500, tol * 3)));
    if (extras.length) {
      report.fail(`markers-extra-${d.kind}`, 'sincronismo', `${OUTPUT_FILE[d.kind]} tem ${extras.length} rajada(s) fora do gabarito em ${extras.map((b) => `${fmtMs(b.timeMs)} (×${b.pulses})`).join(', ')}: conteúdo extra (sessão órfã/duplicada ou pausa incluída).`);
    }
  }
  for (const [session, kinds] of missingBySession) {
    report.fail(`markers-missing-${session}`, 'sincronismo', `Conteúdo da sessão ${session} ausente em: ${[...kinds].map((k) => OUTPUT_FILE[k]).join(', ')}.`);
  }
  const countProblems = problems.filter((p) => p.includes('rajada'));
  if (countProblems.length) report.fail('markers-order', 'sincronismo', 'Sessões fora de ordem ou trocadas (contagem de pulsos não confere).', { detail: countProblems.join('\n') });

  report.facts.markers = { worstAbsMs: worstAbs, worstSpreadMs: worstSpread };
  const frameWarn = 45;
  if (worstAbs > tol || worstSpread > tol) {
    report.fail('marker-sync', 'sincronismo', `Sincronismo perceptual reprovado: pior desvio absoluto ${ms(worstAbs)}, pior desvio entre faixas ${ms(worstSpread)} (limite ${tol}ms).`, {
      detail: 'Cada marcador ocorre no mesmo instante em todas as faixas da fonte; desvios crescentes por sessão indicam drift acumulado por não aparar/preencher sessões.',
      fixHint: 'Aparar/preencher cada sessão exatamente em durationMs; alinhar câmera pelo 1º frame apresentado (não pelo pts cru do HLS).',
    });
  } else if (worstAbs > frameWarn || worstSpread > frameWarn) {
    report.warn('marker-sync', 'sincronismo', `Sincronismo perceptual dentro do limite, mas acima de 1 frame de câmera: pior ${ms(worstAbs)} absoluto, ${ms(worstSpread)} entre faixas.`);
  } else if (truth.markers.length > 0 && detections.length > 0) {
    report.pass('marker-sync', 'sincronismo', `Flash/bip alinhados em todas as faixas: pior desvio ${ms(worstAbs)} absoluto, ${ms(worstSpread)} entre faixas (${truth.markers.length} marcadores).`);
  }
}
