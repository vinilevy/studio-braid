#!/usr/bin/env tsx
/**
 * verify-export — auditoria adversária das mídias geradas pela IA 1.
 *
 *   npx tsx tests/verify-export.ts "<saida> - DaVinci" --source "<projeto>.screenstudio" [--json relatorio.json]
 *
 * O oráculo é SEMPRE o recording/metadata.json original (lido por um parser independente do motor).
 * Saída: 0 = aprovado (com ou sem ressalvas), 1 = reprovado, 2 = erro de uso/execução.
 */
import { access, open } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import type { ProjectManifest, SyncReport, TrackReport } from '../packages/core/src/types/index.ts';
import { measurePlacement, type PlacementProbe } from './lib/audiosync.ts';
import { ffmpeg, ffprobeBin, run } from './lib/exec.ts';
import { audioStream, frameRateStats, packetTimes, parseRate, probe, videoStream, type ProbeResult } from './lib/ffprobe.ts';
import { locateOutput, readJson, SPEC_DIRS, type OutputLayout } from './lib/layout.ts';
import { checkMarkers, findTruthFile, loadTruth } from './lib/markers.ts';
import { ms, Report, signedMs } from './lib/report.ts';
import { fmtMs, KIND_LABEL, loadSource, MEDIA_KINDS, OUTPUT_FILE, type ExpectedTrack, type MediaKind, type SourceProject } from './lib/screenstudio.ts';
import { reconcile, type SessionSource } from './lib/timeline.ts';

export interface VerifyExportOptions {
  outputDir: string;
  source?: string;
  truth?: string;
  toleranceMs?: number;
  strict?: boolean;
  skipFrames?: boolean;
  jsonPath?: string;
  quiet?: boolean;
}

/** PROMPT_IA2: reprovar se qualquer mídia tiver menos de 90% da soma das sessões. */
const COVERAGE_MIN = 0.9;
const exists = (p: string) => access(p).then(() => true, () => false);
const clock = (unixMs: number) => (Number.isFinite(unixMs) ? new Date(unixMs).toLocaleTimeString('pt-BR') : '—');

export async function verifyExport(opts: VerifyExportOptions): Promise<Report> {
  const tol = opts.toleranceMs ?? 100;
  const outputDir = path.resolve(opts.outputDir);
  const report = new Report('verify-export', outputDir, opts.strict);
  report.facts.toleranceMs = tol;

  if (!(await exists(outputDir))) {
    report.fail('output-missing', 'saída', `Pasta de saída não existe: ${outputDir}`);
    return report;
  }
  const layout = await locateOutput(outputDir);
  const manifest = await readOptionalJson<ProjectManifest>(report, layout.manifest?.path, 'project_manifest.json');
  const syncReport = await readOptionalJson<SyncReport>(report, layout.syncReport?.path, 'sync_report.json');

  // ── Oráculo ───────────────────────────────────────────────────────────────
  let sourcePath = opts.source;
  if (!sourcePath && manifest?.inputPath && (await exists(manifest.inputPath))) {
    sourcePath = manifest.inputPath;
    report.info('oracle-from-manifest', 'oráculo', `Fonte não informada; usando manifest.inputPath (${sourcePath}). Prefira --source para independência total.`);
  }
  let src: SourceProject | undefined;
  if (!sourcePath) {
    report.fail('oracle-missing', 'oráculo', 'Sem projeto de origem: impossível conferir durações contra o metadata.json.', {
      fixHint: 'Rode com --source "<projeto>.screenstudio" (ou o .zip).',
    });
  } else {
    try {
      src = await loadSource(sourcePath);
    } catch (e) {
      report.fail('oracle-unreadable', 'oráculo', (e as Error).message);
    }
  }
  if (src) describeOracle(report, src);

  // ── Presença + probe ──────────────────────────────────────────────────────
  const probes = new Map<MediaKind, ProbeResult>();
  for (const kind of MEDIA_KINDS) {
    const expected = src?.tracks.find((t) => t.kind === kind);
    const file = layout.media[kind];
    if (!file) {
      if (expected) {
        report.fail(`missing-${kind}`, KIND_LABEL[kind], `${OUTPUT_FILE[kind]} ausente, mas o metadata tem ${expected.sessions.length} sessão(ões) de ${kind} (${fmtMs(expected.totalMs)}).`);
      }
      continue;
    }
    if (!file.specCompliant) report.warn(`layout-${kind}`, 'layout', `${OUTPUT_FILE[kind]} fora de ${SPEC_DIRS.media}/ (SPEC §4).`);
    if (src && !expected) report.warn(`unexpected-${kind}`, KIND_LABEL[kind], `${OUTPUT_FILE[kind]} existe, mas o metadata não tem gravador "${kind}" com sessões.`);
    try {
      probes.set(kind, await probe(file.path));
    } catch (e) {
      report.fail(`unprobeable-${kind}`, KIND_LABEL[kind], `ffprobe não conseguiu ler ${OUTPUT_FILE[kind]}: ${(e as Error).message.split('\n')[0]}`);
    }
  }

  checkCodecs(report, probes, src);
  await checkVideoGeometry(report, probes, src, manifest, 'webcam');
  await checkVideoGeometry(report, probes, src, manifest, 'display');
  const measured = measureDurations(probes);
  if (src) checkDurations(report, src, measured, tol);
  checkInterTrack(report, measured, tol);
  checkStartTimes(report, probes);
  if (!opts.skipFrames) {
    const videoOffsets = await checkFrames(report, probes, src, tol);
    if (src?.kind === 'folder') await checkAudioPlacement(report, probes, src, videoOffsets.get('display'), tol);
  } else report.info('frames-skipped', 'frames', 'Análise quadro a quadro pulada (--skip-frames).');
  checkEngineReports(report, src, measured, manifest, syncReport, tol);
  checkLayout(report, layout, outputDir);

  // ── Marcadores de conteúdo (somente mocks com gabarito) ───────────────────
  const truthPath = opts.truth ?? (sourcePath ? await findTruthFile(sourcePath) : undefined);
  if (truthPath) {
    const truth = await loadTruth(truthPath);
    await checkMarkers(report, truth, layout, tol);
  } else {
    report.info('markers-unavailable', 'sincronismo', 'Sem gabarito de marcadores (projeto real): sincronismo perceptual por flash/bip só é medido nos mocks.');
  }

  if (!opts.quiet) report.print();
  if (opts.jsonPath) await report.writeJson(opts.jsonPath);
  return report;
}

async function readOptionalJson<T>(report: Report, file: string | undefined, label: string): Promise<T | undefined> {
  if (!file) return undefined;
  try {
    return await readJson<T>(file);
  } catch (e) {
    report.fail(`json-${label}`, 'relatórios', `${label} não é JSON válido: ${(e as Error).message}`);
    return undefined;
  }
}

function describeOracle(report: Report, src: SourceProject): void {
  report.facts.source = { path: src.path, kind: src.kind, projectName: src.projectName, polyrecorderVersion: src.polyrecorderVersion, sessionCount: src.sessionCount };
  report.table(
    `Oráculo: "${src.projectName}" (${src.kind}, polyrecorder ${src.polyrecorderVersion ?? '?'})`,
    ['faixa', 'sessões', 'soma durationMs', 'relógio de parede', 'pausas removidas'],
    src.tracks.map((t) => [KIND_LABEL[t.kind], String(t.sessions.length), fmtMs(t.totalMs), fmtMs(src.wallClockSpanMs), fmtMs(src.pausesMs)]),
  );
  const display = src.tracks.find((t) => t.kind === 'display') ?? src.tracks[0];
  if (display && display.sessions.length > 1) {
    report.table(
      'Fronteiras esperadas na timeline exportada (sem pausas)',
      ['sessão', 'arquivo', 'gravada às', 'duração', 'início na timeline', 'fim na timeline'],
      display.sessions.map((s) => [String(s.index), s.outputFilename ?? '—', clock(s.unixStartMs), fmtMs(s.durationMs), fmtMs(s.timelineStartMs), fmtMs(s.timelineEndMs)]),
    );
  }
  for (const w of src.warnings) report.warn('oracle-warning', 'oráculo', w);
  if (src.orphanFiles.length > 0) {
    report.info('orphans', 'oráculo', `Arquivos de sessão fora do metadata no disco (devem ser IGNORADOS pela exportação): ${src.orphanFiles.join(', ')}`);
  }
}

function checkCodecs(report: Report, probes: Map<MediaKind, ProbeResult>, src?: SourceProject): void {
  const screen = probes.get('display');
  if (screen) {
    const v = videoStream(screen);
    if (!v) report.fail('screen-no-video', 'Tela', 'SCREEN.mp4 não tem stream de vídeo.');
    else {
      if (v.codecName !== 'h264') report.fail('screen-codec', 'Tela', `SCREEN.mp4 em ${v.codecName}; SPEC exige H.264.`, { fixHint: 'Manter/gerar H.264 (cópia de pacotes da fonte H.264 é válida).' });
      else report.pass('screen-codec', 'Tela', `SCREEN.mp4 H.264 ${v.profile ?? ''} ${v.width}x${v.height} ${v.pixFmt ?? ''}`.trim());
      if (v.pixFmt && v.pixFmt !== 'yuv420p') report.warn('screen-pixfmt', 'Tela', `SCREEN.mp4 em ${v.pixFmt}; yuv420p é o mais seguro para decodificação no DaVinci Free.`);
    }
    if (audioStream(screen)) report.warn('screen-has-audio', 'Tela', 'SCREEN.mp4 tem trilha de áudio embutida — o DaVinci criará uma faixa de áudio extra além de A1/A2.');
  }
  const cam = probes.get('webcam');
  if (cam) {
    const v = videoStream(cam);
    if (!v) report.fail('camera-no-video', 'Câmera', 'CAMERA.mp4 não tem stream de vídeo.');
    else {
      if (v.codecName === 'hevc') {
        report.fail('camera-hevc', 'Câmera', 'CAMERA.mp4 continua em HEVC/H.265: tela preta no DaVinci Resolve Free no Windows sem a extensão paga da Microsoft.', {
          fixHint: 'Transcodificar: -c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p (SPEC §3).',
        });
      } else if (v.codecName !== 'h264') {
        report.fail('camera-codec', 'Câmera', `CAMERA.mp4 em ${v.codecName}; SPEC exige H.264 High Profile.`);
      } else if (v.profile !== 'High') {
        report.fail('camera-profile', 'Câmera', `CAMERA.mp4 é H.264 perfil "${v.profile}"; SPEC exige High Profile.`, { fixHint: 'libx264 com -profile:v high (padrão do libx264 com yuv420p).' });
      } else {
        report.pass('camera-codec', 'Câmera', `CAMERA.mp4 H.264 High ${v.width}x${v.height} ${v.pixFmt ?? ''} @ ${v.rFrameRate ?? '?'}`.trim());
      }
      if (v.pixFmt !== 'yuv420p') report.fail('camera-pixfmt', 'Câmera', `CAMERA.mp4 em ${v.pixFmt}; SPEC exige yuv420p.`);
      const webcam = src?.metadata.recorders.find((r) => r.type === 'webcam');
      const fps = Number(webcam?.sessions?.[0]?.deviceFrameRate);
      const outFps = parseRate(v.rFrameRate);
      if (Number.isFinite(fps) && outFps && Math.abs(outFps - fps) > 0.01) {
        report.warn('camera-fps', 'Câmera', `CAMERA.mp4 a ${outFps.toFixed(3)} fps; a câmera gravou a ${fps} fps (deviceFrameRate).`);
      }
    }
  }
  for (const kind of ['microphone', 'systemAudio'] as const) {
    const p = probes.get(kind);
    if (!p) continue;
    const a = audioStream(p);
    const label = KIND_LABEL[kind];
    if (!a) {
      report.fail(`${kind}-no-audio`, label, `${OUTPUT_FILE[kind]} não tem stream de áudio.`);
      continue;
    }
    const problems: string[] = [];
    if (!p.formatName.split(',').includes('wav')) problems.push(`contêiner "${p.formatName}" (esperado WAV)`);
    if (a.codecName !== 'pcm_s24le' && a.codecName !== 'pcm_s16le') problems.push(`codec ${a.codecName} (esperado pcm_s24le ou pcm_s16le)`);
    if (a.sampleRate !== 48000) problems.push(`${a.sampleRate} Hz (esperado 48000 Hz)`);
    if (problems.length) {
      report.fail(`${kind}-format`, label, `${OUTPUT_FILE[kind]} fora do padrão: ${problems.join('; ')}.`, { fixHint: '-c:a pcm_s24le -ar 48000 (SPEC §3).' });
    } else {
      report.pass(`${kind}-format`, label, `${OUTPUT_FILE[kind]} WAV ${a.codecName} ${a.sampleRate} Hz ${a.channels}ch`);
    }
  }
}

const ratio = (v: string | undefined): number | undefined => {
  if (!v) return undefined;
  const [a, b] = v.split(':').map(Number);
  return a && b ? a / b : undefined;
};

/** Active picture area (crop=w:h:x:y) found by cropdetect — tells letter/pillarbox apart from distortion. */
async function activeArea(file: string): Promise<{ w: number; h: number } | undefined> {
  const { stderr } = await ffmpeg(['-v', 'info', '-t', '10', '-i', file, '-an', '-vf', 'cropdetect=limit=24:round=2:reset=0', '-f', 'null', '-'], { allowFail: true });
  const all = [...stderr.matchAll(/crop=(\d+):(\d+):\d+:\d+/g)];
  const last = all[all.length - 1];
  return last ? { w: Number(last[1]), h: Number(last[2]) } : undefined;
}

interface DeclaredVideo {
  mode?: string;
  resolution?: string;
  quality?: string;
  crf?: number | null;
  x264Preset?: string | null;
  width?: number;
  height?: number;
}

/** Render settings the engine says it used (manifest.videoSettings, falling back to renderOptions). */
function declaredVideo(manifest: ProjectManifest | undefined, kind: 'display' | 'webcam'): DeclaredVideo {
  const m = (manifest ?? {}) as unknown as Record<string, unknown>;
  const settings = (m.videoSettings as Record<string, DeclaredVideo> | undefined)?.[kind];
  if (settings) return settings;
  const ro = m.renderOptions as Record<string, string> | undefined;
  return ro ? { resolution: kind === 'webcam' ? ro.cameraResolution : ro.screenResolution, quality: ro.quality } : {};
}

/** Source frame size: webcam videoSize; display bounds × recordingScale (matches the encoded stream). */
function sourceSize(src: SourceProject | undefined, kind: 'display' | 'webcam'): { width: number; height: number } | undefined {
  const s = src?.metadata.recorders.find((r) => r.type === kind)?.sessions?.[0];
  if (!s) return undefined;
  if (kind === 'webcam') {
    const vs = s.videoSize as { width?: number; height?: number } | undefined;
    return vs?.width && vs.height ? { width: vs.width, height: vs.height } : undefined;
  }
  const b = s.bounds as { width?: number; height?: number } | undefined;
  const scale = Number(s.recordingScale ?? 1) || 1;
  return b?.width && b.height ? { width: Math.round(b.width * scale), height: Math.round(b.height * scale) } : undefined;
}

/** Encoder settings libx264 writes in plain text into the stream (SEI "x264 - core … options: …"). */
async function x264Settings(file: string): Promise<string | undefined> {
  const fh = await open(file, 'r');
  try {
    const size = Math.min((await fh.stat()).size, 16 * 1024 * 1024);
    const buf = Buffer.alloc(size);
    await fh.read(buf, 0, size, 0);
    const i = buf.indexOf('x264 - core');
    if (i < 0) return undefined;
    const end = buf.indexOf(0, i);
    return buf.toString('latin1', i, end > i ? Math.min(end, i + 4000) : i + 4000);
  } finally {
    await fh.close();
  }
}

const PRESET_BOX: Record<string, [number, number]> = { '4k': [3840, 2160], '1080p': [1920, 1080] };

async function packetSizes(file: string, count: number): Promise<{ size: number; key: boolean }[]> {
  const { stdout } = await run(ffprobeBin(), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=size,flags', '-read_intervals', `%+#${count}`, '-of', 'csv=p=0', file]);
  return stdout
    .split('\n')
    .map((l) => l.trim().split(','))
    .filter(([size]) => Number(size) > 0)
    .map(([size, flags]) => ({ size: Number(size), key: (flags ?? '').startsWith('K') }));
}

async function checkVideoGeometry(report: Report, probes: Map<MediaKind, ProbeResult>, src: SourceProject | undefined, manifest: ProjectManifest | undefined, kind: 'display' | 'webcam'): Promise<void> {
  const p = probes.get(kind);
  const v = p && videoStream(p);
  if (!p || !v?.width || !v.height) return;
  const label = KIND_LABEL[kind];
  const file = OUTPUT_FILE[kind];
  const id = kind === 'webcam' ? 'camera' : 'screen';
  if (v.width % 2 || v.height % 2) report.fail(`${id}-odd-size`, label, `${file} com dimensão ímpar (${v.width}x${v.height}): yuv420p exige dimensões pares.`);
  const sar = ratio(v.sampleAspectRatio) ?? 1;
  if (Math.abs(sar - 1) > 0.001) report.warn(`${id}-sar`, label, `${file} com pixels não quadrados (SAR ${v.sampleAspectRatio}): o Resolve pode exibir esticado.`, { fixHint: 'Acrescentar setsar=1 após o scale.' });
  const outDar = (v.width * sar) / v.height;
  const size = sourceSize(src, kind);
  if (size) {
    const srcDar = size.width / size.height;
    if (Math.abs(outDar - srcDar) / srcDar <= 0.01) {
      report.pass(`${id}-aspect`, label, `Aspecto preservado: ${v.width}x${v.height} a partir de ${size.width}x${size.height}.`);
    } else {
      const active = await activeArea(p.path);
      const activeDar = active ? (active.w * sar) / active.h : undefined;
      if (activeDar && active && Math.abs(activeDar - srcDar) / srcDar <= 0.02 && (active.w < v.width || active.h < v.height)) {
        report.pass(`${id}-aspect`, label, `Aspecto preservado com barras: área ativa ${active.w}x${active.h} dentro de ${v.width}x${v.height} (fonte ${size.width}x${size.height}).`);
      } else {
        report.fail(`${id}-aspect`, label, `${label} DISTORCIDA: ${v.width}x${v.height} (DAR ${outDar.toFixed(3)}) a partir de ${size.width}x${size.height} (DAR ${srcDar.toFixed(3)}).`, {
          fixHint: 'scale=W:H:force_original_aspect_ratio=decrease (+ pad se exigir caixa fixa), depois setsar=1.',
        });
      }
    }
    if (v.width > size.width || v.height > size.height) {
      report.info(`${id}-upscale`, label, `${file} ampliado de ${size.width}x${size.height} para ${v.width}x${v.height}: não acrescenta detalhe; aumenta arquivo e tempo de exportação.`);
    }
  }

  const d = declaredVideo(manifest, kind);
  if (!d.mode && !d.resolution) return;
  report.facts[`${kind}VideoSettings`] = d;
  if (d.width && d.height && (d.width !== v.width || d.height !== v.height)) {
    report.fail(`${id}-manifest-size`, label, `Manifest declara ${d.width}x${d.height} para ${file}, mas o arquivo tem ${v.width}x${v.height}.`);
  }
  const keepsSource = d.mode === 'remux' || d.resolution === 'native';
  if (keepsSource && size && (v.width !== size.width || v.height !== size.height)) {
    report.fail(`${id}-preset`, label, `${d.mode === 'remux' ? 'Remux' : 'Resolução "native"'} declarado, mas ${file} está em ${v.width}x${v.height} (fonte ${size.width}x${size.height}).`);
  } else if (keepsSource) {
    report.pass(`${id}-preset`, label, `${d.mode === 'remux' ? 'Remux sem recompressão' : 'Resolução nativa'} respeitado (${v.width}x${v.height}).`);
  } else if (d.resolution && PRESET_BOX[d.resolution]) {
    const [bw, bh] = PRESET_BOX[d.resolution] as [number, number];
    if (v.width === bw && v.height === bh) report.pass(`${id}-preset`, label, `Preset "${d.resolution}" respeitado: canvas ${bw}x${bh}.`);
    else report.fail(`${id}-preset`, label, `Preset "${d.resolution}" declarado, mas ${file} está em ${v.width}x${v.height} (esperado canvas ${bw}x${bh}).`);
  }

  if (d.mode === 'remux') {
    // Packet copy keeps every compressed payload byte-identical: compare the first packet sizes.
    const first = src?.tracks.find((t) => t.kind === kind)?.sessions[0];
    const sourceFile = src?.kind === 'folder' && first?.outputFilename ? path.join(src.path, 'recording', first.outputFilename) : undefined;
    if (sourceFile && (await exists(sourceFile))) {
      const [a, b] = await Promise.all([packetSizes(sourceFile, 60), packetSizes(p.path, 60)]);
      const n = Math.min(a.length, b.length);
      // Non-key packets must be byte-identical; a keyframe may grow a little (SPS/PPS re-inserted in-band).
      let grown = 0;
      const mismatch = a.slice(0, n).findIndex((x, i) => {
        const y = b[i] as { size: number; key: boolean };
        if (x.size === y.size) return false;
        if (x.key && y.key && y.size > x.size && y.size - x.size <= 128) {
          grown++;
          return false;
        }
        return true;
      });
      if (n > 0 && mismatch < 0) {
        report.pass(`${id}-remux-exact`, label, `${file}: remux sem recompressão confirmado (${n} primeiros pacotes idênticos à fonte${grown ? `; ${grown} keyframe(s) com SPS/PPS reinseridos em banda` : ''}).`);
      } else {
        report.fail(`${id}-remux-exact`, label, `${file} declarado como remux, mas o pacote ${mismatch} difere da fonte (${a[mismatch]?.size} → ${b[mismatch]?.size} bytes): recomprimido.`, { evidence: { source: a.slice(0, 8), output: b.slice(0, 8) } });
      }
    }
    return;
  }
  const sei = await x264Settings(p.path);
  if (d.mode === 'transcode') {
    const crf = sei ? Number(/crf=([\d.]+)/.exec(sei)?.[1]) : NaN;
    if (!sei) report.warn(`${id}-x264-sei`, label, `${file} declarado como transcode, mas sem SEI do libx264: impossível confirmar CRF.`);
    else if (typeof d.crf === 'number' && Number.isFinite(crf) && Math.abs(crf - d.crf) > 0.01) {
      report.fail(`${id}-manifest-crf`, label, `Manifest declara CRF ${d.crf} para ${file}, mas o encoder gravou crf=${crf}.`);
    } else if (Number.isFinite(crf)) {
      report.pass(`${id}-crf`, label, `${file}: qualidade "${d.quality ?? '?'}" → CRF ${crf} confirmado no SEI do x264 (preset ${d.x264Preset ?? '?'}).`);
    }
  }
}

function measureDurations(probes: Map<MediaKind, ProbeResult>): Map<MediaKind, number> {
  const out = new Map<MediaKind, number>();
  for (const [kind, p] of probes) {
    const s = kind === 'display' || kind === 'webcam' ? videoStream(p) : audioStream(p);
    const sec = Number.isFinite(p.durationSec) ? p.durationSec : (s?.durationSec ?? NaN);
    out.set(kind, sec * 1000);
  }
  return out;
}

/** Explains a wrong total in terms of sessions, pauses or duplicates. */
function diagnose(track: ExpectedTrack, actualMs: number, src: SourceProject, tol: number): string[] {
  const lines: string[] = [];
  const n = track.sessions.length;
  const near = (a: number, b: number, rel: number) => Math.abs(a - b) <= Math.max(tol, rel * Math.max(a, b));
  let bestK = 0;
  let bestErr = Infinity;
  let cum = 0;
  const prefix: number[] = [0];
  for (const s of track.sessions) {
    cum += s.durationMs;
    prefix.push(cum);
  }
  prefix.forEach((p, k) => {
    if (k > 0 && Math.abs(p - actualMs) < bestErr) {
      bestErr = Math.abs(p - actualMs);
      bestK = k;
    }
  });
  if (bestK > 0 && bestK < n && near(prefix[bestK] as number, actualMs, 0.01)) {
    lines.push(`A mídia tem ${fmtMs(actualMs)} ≈ soma das sessões 0..${bestK - 1} (${fmtMs(prefix[bestK] as number)}). Sessões ${bestK}..${n - 1} foram IGNORADAS:`);
    for (const s of track.sessions.slice(bestK)) {
      lines.push(`  • sessão ${s.index}: ${s.outputFilename ?? '?'} gravada às ${clock(s.unixStartMs)} (unix ${Math.round(s.unixStartMs)}), ${fmtMs(s.durationMs)} → deveria ocupar ${fmtMs(s.timelineStartMs)}–${fmtMs(s.timelineEndMs)}`);
    }
  } else {
    const single = track.sessions.find((s) => near(s.durationMs, actualMs, 0.01));
    if (single && n > 1) lines.push(`A mídia tem a duração exata da sessão ${single.index} isolada (${fmtMs(single.durationMs)}): as outras ${n - 1} sessões não entraram.`);
  }
  if (src.pausesMs > tol && near(actualMs, src.wallClockSpanMs, 0.005)) {
    lines.push(`A mídia tem a duração do relógio de parede (${fmtMs(src.wallClockSpanMs)}): as ${fmtMs(src.pausesMs)} de PAUSA foram incluídas como tempo morto.`);
  }
  if (actualMs > track.totalMs + tol) {
    const dup = track.sessions.find((s) => near(actualMs - track.totalMs, s.durationMs, 0.01));
    if (dup) lines.push(`O excesso (${fmtMs(actualMs - track.totalMs)}) bate com a duração da sessão ${dup.index}: sessão duplicada?`);
    if (src.orphanFiles.length) lines.push(`Há sessões órfãs no disco (${src.orphanFiles.join(', ')}); se foram concatenadas, explicam excesso.`);
  }
  return lines;
}

function checkDurations(report: Report, src: SourceProject, measured: Map<MediaKind, number>, tol: number): void {
  const rows: string[][] = [];
  for (const track of src.tracks) {
    const actual = measured.get(track.kind);
    if (actual === undefined) continue;
    const dev = actual - track.totalMs;
    const ratio = actual / track.totalMs;
    rows.push([KIND_LABEL[track.kind], OUTPUT_FILE[track.kind], fmtMs(track.totalMs), fmtMs(actual), signedMs(dev), `${(ratio * 100).toFixed(2)}%`]);
    const why = diagnose(track, actual, src, tol);
    if (!Number.isFinite(actual)) {
      report.fail(`duration-unknown-${track.kind}`, KIND_LABEL[track.kind], `Duração ilegível em ${OUTPUT_FILE[track.kind]}.`);
    } else if (ratio < COVERAGE_MIN) {
      report.fail(`sessions-ignored-${track.kind}`, KIND_LABEL[track.kind], `${OUTPUT_FILE[track.kind]} tem só ${(ratio * 100).toFixed(1)}% da gravação (${fmtMs(actual)} de ${fmtMs(track.totalMs)}) — SESSÕES IGNORADAS.`, {
        detail: why.join('\n') || undefined,
        fixHint: 'Iterar TODAS as recorders[].sessions[] (SPEC §2) e concatenar na ordem do metadata.',
        evidence: { expectedMs: track.totalMs, actualMs: actual, sessions: track.sessions.map((s) => ({ index: s.index, file: s.outputFilename, durationMs: s.durationMs, unixStartMs: s.unixStartMs })) },
      });
    } else if (Math.abs(dev) > tol) {
      report.fail(`duration-${track.kind}`, KIND_LABEL[track.kind], `${OUTPUT_FILE[track.kind]} difere da soma das sessões em ${signedMs(dev)} (tolerância ±${tol}ms).`, {
        detail: why.join('\n') || undefined,
        fixHint: dev > 0 ? 'Aparar cada sessão em durationMs antes de concatenar; não incluir pausas nem sessões órfãs.' : 'Preencher (apad/tpad) cada sessão até durationMs antes de concatenar.',
        evidence: { expectedMs: track.totalMs, actualMs: actual, deviationMs: dev },
      });
    } else {
      report.pass(`duration-${track.kind}`, KIND_LABEL[track.kind], `${OUTPUT_FILE[track.kind]} cobre as ${track.sessions.length} sessões: ${fmtMs(actual)} (${signedMs(dev)} vs metadata).`);
    }
  }
  if (rows.length) report.table('Durações: medida (ffprobe) × esperada (soma de durationMs)', ['faixa', 'arquivo', 'esperada', 'medida', 'desvio', 'cobertura'], rows);
}

function checkInterTrack(report: Report, measured: Map<MediaKind, number>, tol: number): void {
  const entries = [...measured.entries()].filter(([, v]) => Number.isFinite(v));
  if (entries.length < 2) return;
  const values = entries.map(([, v]) => v);
  const spread = Math.max(...values) - Math.min(...values);
  report.facts.interTrackDeviationMs = spread;
  const ref = measured.get('display') ?? values[0] ?? 0;
  const detail = entries.map(([k, v]) => `${OUTPUT_FILE[k]}: ${fmtMs(v)} (${signedMs(v - ref)} vs tela)`).join('\n');
  const specClass = spread <= 100 ? 'OK' : spread <= 400 ? 'WARNING' : 'ERROR';
  if (spread > tol) {
    report.fail('inter-track', 'sincronismo', `Desvio entre faixas = ${ms(spread)} (> ${tol}ms). Classe SPEC §6: ${specClass}.`, {
      detail,
      fixHint: 'Todas as faixas devem ter exatamente a soma de durationMs; aparar/preencher por sessão.',
      evidence: Object.fromEntries(entries),
    });
  } else {
    report.pass('inter-track', 'sincronismo', `Desvio máximo entre faixas: ${ms(spread)} (≤ ${tol}ms). Classe SPEC §6: ${specClass}.`, detail);
  }
}

function checkStartTimes(report: Report, probes: Map<MediaKind, ProbeResult>): void {
  for (const [kind, p] of probes) {
    const s = kind === 'display' || kind === 'webcam' ? videoStream(p) : audioStream(p);
    const start = (s?.startTimeSec ?? p.startTimeSec ?? 0) * 1000;
    const frameMs = s?.rFrameRate ? 1000 / (parseRate(s.rFrameRate) ?? 60) : 5;
    if (Math.abs(start) > Math.max(frameMs, 5)) {
      report.warn(`start-${kind}`, KIND_LABEL[kind], `${OUTPUT_FILE[kind]} começa em ${ms(start)} (não em 0): o DaVinci pode posicionar o clipe com gap/deslocamento.`, {
        fixHint: 'Rebasear timestamps (setpts/asetpts=PTS-STARTPTS, -avoid_negative_ts make_zero).',
      });
    }
  }
}

/** Least-squares slope of offset (ms) per session index. */
function slope(points: [number, number][]): number {
  const n = points.length;
  const mx = points.reduce((a, [x]) => a + x, 0) / n;
  const my = points.reduce((a, [, y]) => a + y, 0) / n;
  const num = points.reduce((a, [x, y]) => a + (x - mx) * (y - my), 0);
  const den = points.reduce((a, [x]) => a + (x - mx) ** 2, 0);
  return den ? num / den : 0;
}

/** Returns, per video kind, the measured offset (ms) of each session that could be reconciled. */
async function checkFrames(report: Report, probes: Map<MediaKind, ProbeResult>, src: SourceProject | undefined, tol: number): Promise<Map<MediaKind, Map<number, number>>> {
  const offsetsByKind = new Map<MediaKind, Map<number, number>>();
  for (const kind of ['display', 'webcam'] as const) {
    const p = probes.get(kind);
    const v = p && videoStream(p);
    if (!p || !v) continue;
    const label = KIND_LABEL[kind];
    const packets = await packetTimes(p.path, 'v:0');
    const durationSec = Number.isFinite(p.durationSec) ? p.durationSec : packets.length / 60;
    const stats = frameRateStats(packets, parseRate(v.rFrameRate), durationSec);
    report.facts[`${kind}Frames`] = stats;

    let nonMonotonic = 0;
    for (let i = 1; i < packets.length; i++) if ((packets[i] as { dtsSec: number }).dtsSec <= (packets[i - 1] as { dtsSec: number }).dtsSec) nonMonotonic++;
    const ptsSet = new Set(packets.map((x) => x.ptsSec.toFixed(6)));
    const duplicatedPts = packets.length - ptsSet.size;
    if (nonMonotonic || duplicatedPts) {
      report.fail(`timestamps-${kind}`, label, `${OUTPUT_FILE[kind]} tem timestamps inválidos: ${nonMonotonic} DTS não crescentes, ${duplicatedPts} PTS duplicados.`, {
        fixHint: 'Concatenar com offsets de sessão corretos; nunca sobrepor a cauda de uma sessão ao início da próxima.',
      });
    }

    const statLine = `${stats.packets} frames · nominal ${stats.nominalFps?.toFixed(3) ?? '?'} fps · média ${stats.averageFps?.toFixed(3) ?? '?'} fps · maior intervalo ${ms(stats.maxGapMs)} · intervalos irregulares ${(stats.irregularGapRatio * 100).toFixed(1)}%`;
    if (stats.constantFrameRate) report.pass(`cfr-${kind}`, label, `${OUTPUT_FILE[kind]} é CFR.`, statLine);
    else {
      report.warn(`vfr-${kind}`, label, `${OUTPUT_FILE[kind]} é VFR (taxa variável). Pendente de smoke test no DaVinci/Windows: se o Resolve contar frames em vez de respeitar PTS, a faixa encolhe/dessincroniza.`, {
        detail: statLine,
        fixHint: 'Validar importação no Resolve; se falhar, oferecer perfil CFR (-fps_mode cfr -r <fps>) aprovado pelo usuário.',
      });
    }

    if (!src || src.kind !== 'folder') {
      report.info(`source-frames-${kind}`, label, 'Contagem de frames da fonte indisponível (fonte .zip ou ausente).');
      continue;
    }
    const track = src.tracks.find((t) => t.kind === kind);
    if (!track) continue;
    const sessions: SessionSource[] = [];
    for (const s of track.sessions) {
      const file = s.outputFilename ? path.join(src.path, 'recording', s.outputFilename) : undefined;
      if (!file || !(await exists(file))) {
        report.warn(`source-file-${kind}-${s.index}`, label, `Arquivo da sessão ${s.index} não encontrado na fonte: ${s.outputFilename ?? '(sem outputFilename)'}`);
        continue;
      }
      const srcPackets = await packetTimes(file, 'v:0');
      sessions.push({ index: s.index, timelineStartMs: s.timelineStartMs, durationMs: s.durationMs, sourcePtsSec: srcPackets.map((x) => x.ptsSec) });
    }
    const rec = reconcile(packets.map((x) => x.ptsSec), sessions);
    const total = rec.reduce((a, r) => a + r.sourcePackets, 0);
    const inWindow = rec.reduce((a, r) => a + r.inWindowPackets, 0);
    const tail = total - inWindow;
    report.facts[`${kind}Reconciliation`] = rec;
    report.table(
      `${label}: reconciliação quadro a quadro (fonte → ${OUTPUT_FILE[kind]})`,
      ['sessão', 'início timeline', 'frames fonte', 'cauda > durationMs', 'saída na janela', 'match exato', 'deslocamento'],
      rec.map((r) => [
        String(r.index),
        fmtMs(r.timelineStartMs),
        String(r.sourcePackets),
        String(r.tailPackets),
        String(r.outputPacketsInWindow),
        r.reconcilable ? `${(r.exactRatio * 100).toFixed(1)}%` : '—',
        r.reconcilable && r.bestOffsetMs !== undefined && !r.ambiguous
          ? `${signedMs(r.bestOffsetMs, 0)} (${((r.bestOffsetRatio ?? 0) * 100).toFixed(0)}%)${r.note ? ` · ${r.note}` : ''}`
          : (r.note ?? '—'),
      ]),
    );

    const outCount = stats.packets;
    if (outCount < inWindow - track.sessions.length) {
      report.fail(`frames-lost-${kind}`, label, `${OUTPUT_FILE[kind]} tem ${outCount} frames, mas a fonte tem ${inWindow} dentro das janelas de sessão: ${inWindow - outCount} frames PERDIDOS.`, {
        fixHint: 'Não usar -t/-shortest/trim que cortem frames válidos; conferir concatenação de todas as sessões.',
      });
    } else if (outCount > total * 1.05) {
      report.info(`frames-dup-${kind}`, label, `Duplicação sintética: ${outCount} frames na saída vs ${total} originais (+${outCount - total}). Esperado se a faixa foi convertida para CFR.`);
    } else if (outCount >= total) {
      report.pass(`frames-kept-${kind}`, label, `Todos os ${total} frames originais preservados (${outCount} na saída).`);
    } else {
      report.pass(`frames-kept-${kind}`, label, `Frames originais preservados: ${outCount} na saída; fonte ${total} (${tail} além de durationMs, aparáveis).`);
    }

    for (const r of rec) {
      if (!r.reconcilable) continue;
      if (r.ambiguous) {
        report.info(`session-ambiguous-${kind}-${r.index}`, label, `Sessão ${r.index}: posição não determinável por timestamps (grade regular); conferir por marcadores.`);
        continue;
      }
      const off = r.bestOffsetMs ?? 0;
      const frame = 1000 / (stats.nominalFps ?? 60);
      if ((r.bestOffsetRatio ?? 0) >= 0.9 && Math.abs(off) > tol) {
        report.fail(`session-shift-${kind}-${r.index}`, label, `Sessão ${r.index} da ${label.toLowerCase()} está deslocada ${signedMs(off, 0)} na timeline (esperado início em ${fmtMs(r.timelineStartMs)}).`, {
          fixHint: 'Offset de cada sessão = soma das durationMs anteriores; a cauda da sessão anterior não pode empurrar a seguinte.',
          evidence: r,
        });
      } else if ((r.bestOffsetRatio ?? 0) >= 0.9 && Math.abs(off) > frame) {
        report.warn(`session-shift-${kind}-${r.index}`, label, `Sessão ${r.index} deslocada ${signedMs(off, 0)} (> 1 frame).`, { evidence: r });
      } else if ((r.bestOffsetRatio ?? 0) < 0.5 && kind === 'display') {
        report.warn(`session-unmatched-${kind}-${r.index}`, label, `Sessão ${r.index}: só ${((r.bestOffsetRatio ?? 0) * 100).toFixed(0)}% dos frames da fonte reaparecem na saída — recompressão ou frames trocados.`, { evidence: r });
      }
    }

    const offsets = new Map<number, number>();
    for (const r of rec) if (r.reconcilable && !r.ambiguous && (r.bestOffsetRatio ?? 0) >= 0.5 && r.bestOffsetMs !== undefined) offsets.set(r.index, r.bestOffsetMs);
    offsetsByKind.set(kind, offsets);
    const points = [...offsets.entries()];
    if (points.length >= 3) {
      const perSession = slope(points);
      const last = points[points.length - 1]?.[1] ?? 0;
      if (perSession >= 0.5 && Math.abs(last) >= 3) {
        report.warn(`drift-accumulation-${kind}`, label, `Drift acumulado na ${label.toLowerCase()}: ${signedMs(perSession, 2)} por fronteira de sessão (última sessão em ${signedMs(last, 0)}). Projeção: 60 sessões ≈ ${signedMs(perSession * 59, 0)}.`, {
          detail: points.map(([i, off]) => `sessão ${i}: ${signedMs(off, 0)}`).join(' · '),
          fixHint: 'Início da sessão k = round(Σ durationMs anteriores) na timebase de saída (arredondar o acumulado, não cada parcela).',
        });
      }
    }
  }
  return offsetsByKind;
}

/** Cross-correlates loud excerpts of each source audio session against the export (real projects). */
async function checkAudioPlacement(report: Report, probes: Map<MediaKind, ProbeResult>, src: SourceProject, videoOffsets: Map<number, number> | undefined, tol: number): Promise<void> {
  const kinds = (['microphone', 'systemAudio'] as const).filter((k) => probes.has(k) && src.tracks.some((t) => t.kind === k));
  if (kinds.length === 0) return;
  const display = src.tracks.find((t) => t.kind === 'display') ?? src.tracks[0];
  const sessionIndexes = display?.sessions.map((s) => s.index) ?? [];
  const results = new Map<string, PlacementProbe>();
  for (const kind of kinds) {
    const track = src.tracks.find((t) => t.kind === kind) as ExpectedTrack;
    const exportFile = (probes.get(kind) as ProbeResult).path;
    for (const s of track.sessions) {
      const sourceFile = s.outputFilename ? path.join(src.path, 'recording', s.outputFilename) : undefined;
      if (!sourceFile || !(await exists(sourceFile))) continue;
      const dur = s.durationMs / 1000;
      const windows: [string, number, number][] = [['início', 0.3, Math.min(15, dur - 1.3)]];
      if (dur > 8) windows.push(['fim', Math.max(0.3, dur - 15), dur - 1.3]);
      for (const [label, from, to] of windows) {
        if (to <= from) continue;
        try {
          // ±1 s search: wide enough to measure (not just miss) drifts several times the tolerance.
          const probeResult = await measurePlacement(sourceFile, exportFile, s.timelineStartMs, from, to, { marginSec: 1.0 });
          results.set(`${kind}:${s.index}:${label}`, probeResult);
          if (!probeResult.silent && probeResult.score < 0.5) {
            report.warn(`audio-unmatched-${kind}-${s.index}-${label}`, KIND_LABEL[kind], `Sessão ${s.index} (${label}): trecho da fonte não localizado no ${OUTPUT_FILE[kind]} em ±1 s da posição esperada (correlação ${probeResult.score.toFixed(2)}) — deslocamento grande, faixa trocada ou conteúdo alterado.`, { evidence: probeResult });
          }
        } catch (e) {
          report.warn(`audio-corr-error-${kind}-${s.index}`, KIND_LABEL[kind], `Correlação falhou na sessão ${s.index} (${label}): ${(e as Error).message.split('\n')[0]}`);
        }
      }
    }
  }
  const cell = (p: PlacementProbe | undefined) => (!p ? '—' : p.silent ? 'silêncio' : p.score < 0.5 ? `? (${p.score.toFixed(2)})` : signedMs(p.offsetMs, 1));
  const header = ['sessão', 'tela (frames)', ...kinds.flatMap((k) => [`${OUTPUT_FILE[k]} início`, `${OUTPUT_FILE[k]} fim`]), 'A/V pior'];
  const rows: string[][] = [];
  let worstAv = 0;
  for (const i of sessionIndexes) {
    const v = videoOffsets?.get(i);
    const row = [String(i), v === undefined ? '—' : signedMs(v, 0)];
    let rowWorst: number | undefined;
    for (const kind of kinds) {
      for (const label of ['início', 'fim']) {
        const p = results.get(`${kind}:${i}:${label}`);
        row.push(cell(p));
        if (!p || p.silent || p.score < 0.5 || p.offsetMs === undefined) continue;
        if (Math.abs(p.offsetMs) > tol) {
          report.fail(`audio-placement-${kind}-${i}-${label}`, KIND_LABEL[kind], `Sessão ${i} (${label}) do ${OUTPUT_FILE[kind]} está em ${signedMs(p.offsetMs, 1)} da posição esperada (${fmtMs(display?.sessions[i]?.timelineStartMs ?? 0)} + ${p.sourceOffsetSec.toFixed(2)}s).`, {
            fixHint: 'Aparar/preencher cada sessão de áudio exatamente em durationMs antes de concatenar.',
            evidence: p,
          });
        }
        if (v !== undefined) {
          const av = p.offsetMs - v;
          rowWorst = rowWorst === undefined || Math.abs(av) > Math.abs(rowWorst) ? av : rowWorst;
        }
      }
      const a = results.get(`${kind}:${i}:início`);
      const b = results.get(`${kind}:${i}:fim`);
      if (a?.offsetMs !== undefined && b?.offsetMs !== undefined && a.score >= 0.5 && b.score >= 0.5 && Math.abs(b.offsetMs - a.offsetMs) > 20) {
        report.warn(`audio-intra-drift-${kind}-${i}`, KIND_LABEL[kind], `Sessão ${i}: o ${OUTPUT_FILE[kind]} deriva ${signedMs(b.offsetMs - a.offsetMs, 1)} entre o início e o fim da sessão (taxa de amostragem/resample?).`);
      }
    }
    if (rowWorst !== undefined) worstAv = Math.max(worstAv, Math.abs(rowWorst));
    row.push(rowWorst === undefined ? '—' : signedMs(rowWorst, 1));
    rows.push(row);
  }
  report.table('Áudio por sessão: posição medida por correlação com a fonte (− esperado)', header, rows);
  report.facts.audioVideoWorstMs = worstAv;
  if (worstAv > tol) {
    report.fail('av-sync-real', 'sincronismo', `A/V por sessão: pior diferença entre áudio e frames da tela = ${ms(worstAv)} (> ${tol}ms).`);
  } else if (worstAv > 45) {
    report.warn('av-sync-real', 'sincronismo', `A/V por sessão: pior diferença áudio × tela = ${ms(worstAv)} (> 1 frame de câmera, ≤ ${tol}ms).`);
  } else if (videoOffsets && videoOffsets.size > 0) {
    report.pass('av-sync-real', 'sincronismo', `A/V por sessão (correlação com a fonte): pior diferença áudio × frames da tela = ${ms(worstAv)}.`);
  }
}

function checkEngineReports(report: Report, src: SourceProject | undefined, measured: Map<MediaKind, number>, manifest: ProjectManifest | undefined, sync: SyncReport | undefined, tol: number): void {
  if (!sync) report.fail('sync-report-missing', 'relatórios', 'sync_report.json não encontrado (SPEC §4: 03_DATA/sync_report.json).');
  if (!manifest) report.fail('manifest-missing', 'relatórios', 'project_manifest.json não encontrado (SPEC §4: 03_DATA/project_manifest.json).');

  if (sync) {
    const tracks: Partial<TrackReport>[] = Array.isArray(sync.tracks) ? sync.tracks : [];
    for (const kind of MEDIA_KINDS) {
      const t = tracks.find((x) => x.kind === kind);
      const actual = measured.get(kind);
      const oracle = src?.tracks.find((x) => x.kind === kind);
      if (!t) {
        if (actual !== undefined) report.fail(`sync-track-missing-${kind}`, 'relatórios', `sync_report.json não descreve a faixa ${kind}.`);
        continue;
      }
      if (actual !== undefined && typeof t.actualDurationMs === 'number' && Math.abs(t.actualDurationMs - actual) > 2) {
        report.fail(`sync-lies-${kind}`, 'relatórios', `sync_report.json declara ${OUTPUT_FILE[kind]} com ${fmtMs(t.actualDurationMs)}, mas o ffprobe mede ${fmtMs(actual)} (${signedMs(t.actualDurationMs - actual)}).`);
      }
      if (oracle && typeof t.expectedDurationMs === 'number' && Math.abs(t.expectedDurationMs - oracle.totalMs) > 1) {
        report.fail(`sync-oracle-${kind}`, 'relatórios', `Motor espera ${fmtMs(t.expectedDurationMs)} para ${kind}; o metadata soma ${fmtMs(oracle.totalMs)}.`);
      }
      if (oracle && typeof t.sessionCount === 'number' && t.sessionCount !== oracle.sessions.length) {
        report.fail(`sync-sessions-${kind}`, 'relatórios', `sync_report.json diz ${t.sessionCount} sessões de ${kind}; o metadata tem ${oracle.sessions.length}.`);
      }
    }
    const spread = report.facts.interTrackDeviationMs as number | undefined;
    if (typeof sync.interTrackDeviationMs === 'number' && spread !== undefined && Math.abs(sync.interTrackDeviationMs - spread) > 2) {
      report.warn('sync-spread', 'relatórios', `sync_report.interTrackDeviationMs = ${ms(sync.interTrackDeviationMs)}; medido ${ms(spread)}.`);
    }
    if (typeof sync.toleranceMs === 'number' && sync.toleranceMs > tol) {
      report.warn('sync-tolerance', 'relatórios', `Motor validou com tolerância ${sync.toleranceMs}ms (> ${tol}ms do gate de QA).`);
    }
    const syncFailures = report.findings.filter((f) => f.severity === 'FAIL' && /^(sessions-ignored|duration-|inter-track|session-shift|frames-lost|marker)/.test(f.id));
    if (sync.status === 'ok' && syncFailures.length > 0) {
      report.fail('sync-false-ok', 'relatórios', `sync_report.json declara status "ok", mas a auditoria encontrou ${syncFailures.length} falha(s) de sincronismo/integridade.`, {
        fixHint: 'O SyncValidator do motor precisa medir as mídias finais com ffprobe, não confiar no plano de concatenação.',
      });
    } else if (sync.status) {
      report.info('sync-status', 'relatórios', `sync_report.status = "${sync.status}" (motor), maxDeviationMs = ${ms(sync.maxDeviationMs)}.`);
    }
  }

  if (manifest && src) {
    if (typeof manifest.sessionCount === 'number' && manifest.sessionCount !== src.sessionCount) {
      report.fail('manifest-sessions', 'relatórios', `project_manifest.sessionCount = ${manifest.sessionCount}; o metadata tem ${src.sessionCount} sessões.`);
    }
    const expectedMissing = MEDIA_KINDS.filter((k) => !src.tracks.some((t) => t.kind === k));
    const declared = Array.isArray(manifest.missingTracks) ? [...manifest.missingTracks].sort() : [];
    if (JSON.stringify(declared) !== JSON.stringify([...expectedMissing].sort())) {
      report.warn('manifest-missing-tracks', 'relatórios', `manifest.missingTracks = [${declared.join(', ')}]; esperado [${expectedMissing.join(', ')}].`);
    }
    if (typeof manifest.projectName === 'string') {
      if (manifest.projectName !== manifest.projectName.normalize('NFC')) {
        report.warn('manifest-name-nfd', 'relatórios', `projectName não está em NFC ("${manifest.projectName}") — acentos podem aparecer quebrados no Windows.`);
      } else if (manifest.projectName.normalize('NFC') !== src.projectName) {
        report.warn('manifest-name', 'relatórios', `projectName "${manifest.projectName}" difere do bundle "${src.projectName}".`);
      }
      if (/[╠╣║╗╝╚╔╩╦╬═]|Ã[\u0080-¿]/.test(manifest.projectName)) {
        report.fail('manifest-name-mojibake', 'relatórios', `projectName com mojibake ("${manifest.projectName}"): nome do ZIP decodificado como CP437.`, {
          fixHint: 'Nomes de ZIP sem flag UTF-8 que forem UTF-8 válido devem ser decodificados como UTF-8 + NFC.',
        });
      }
    }
  }
}

function checkLayout(report: Report, layout: OutputLayout, outputDir: string): void {
  for (const d of layout.missingDirs) report.warn(`layout-dir-${d}`, 'layout', `Pasta ${d}/ ausente (SPEC §4).`);
  if (layout.syncReport && !layout.syncReport.specCompliant) report.warn('layout-sync', 'layout', 'sync_report.json fora de 03_DATA/ (SPEC §4).');
  if (layout.manifest && !layout.manifest.specCompliant) report.warn('layout-manifest', 'layout', 'project_manifest.json fora de 03_DATA/ (SPEC §4).');
  if (!layout.exportLog) report.warn('layout-log', 'layout', 'logs/export.log ausente (SPEC §4).');
  if (layout.fcpxml.length === 0) report.warn('layout-fcpxml', 'layout', 'Nenhum .fcpxml em 02_DAVINCI/ (validado por verify-fcpxml).');
  if (!/ - DaVinci$/.test(path.basename(outputDir))) report.info('layout-name', 'layout', `Nome da pasta "${path.basename(outputDir)}" não segue "[Nome do Projeto] - DaVinci" (SPEC §4).`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      source: { type: 'string', short: 's' },
      truth: { type: 'string' },
      tolerance: { type: 'string', default: '100' },
      json: { type: 'string' },
      strict: { type: 'boolean', default: false },
      'skip-frames': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help || positionals.length !== 1) {
    console.log('Uso: tsx tests/verify-export.ts <pasta-de-saida> --source <projeto.screenstudio|.zip|metadata.json> [--json out.json] [--tolerance 100] [--strict] [--skip-frames] [--truth gabarito.json]');
    process.exit(values.help ? 0 : 2);
  }
  const report = await verifyExport({
    outputDir: positionals[0] as string,
    source: values.source,
    truth: values.truth,
    toleranceMs: Number(values.tolerance),
    strict: values.strict,
    skipFrames: values['skip-frames'],
    jsonPath: values.json,
  });
  process.exit(report.exitCode);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`verify-export: erro inesperado: ${(e as Error).stack ?? e}`);
    process.exit(2);
  });
}
