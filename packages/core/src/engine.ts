import { mkdir, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { CameraResolution, ExportOptions, ExportResult, MediaProbe, ProjectManifest, RenderQuality, SessionReport, SyncReport, TrackFile, TrackKind, TrackReport, VideoRenderSettings } from './types/index.js';
import { BridgeError, checkAbort } from './errors.js';
import { prepareInput } from './bundle.js';
import { parseProject, TRACK_KINDS } from './parser.js';
import { estimateDiskSpace, resolveRenderOptions } from './analyze.js';
import { isWithin } from './paths.js';
import { TempManager } from './temp.js';
import { runFFmpeg, toolVersion } from './process.js';
import { localInputArgs, probeMedia, scanVideoPackets, type PacketStats } from './probe.js';
import { generateFcpxml } from './fcpxml.js';

const FILES: Record<TrackKind, TrackFile> = { display: 'SCREEN.mp4', webcam: 'CAMERA.mp4', microphone: 'MICROPHONE.wav', systemAudio: 'SYSTEM_AUDIO.wav' };
const QUALITY: Record<RenderQuality, { preset: string; crf: number }> = {
  maximum: { preset: 'slow', crf: 14 }, high: { preset: 'medium', crf: 17 }, fast: { preset: 'veryfast', crf: 18 },
};
const SIZES = { '4k': { width: 3840, height: 2160 }, '1080p': { width: 1920, height: 1080 } } as const;
function scaleFilters(resolution: CameraResolution): string[] {
  if (resolution === 'native') return [];
  const { width, height } = SIZES[resolution];
  // Fit + pad, never stretch/crop a 4:3 face or a non-16:9 display. Output is square-pixel.
  return [`scale=${width}:${height}:flags=lanczos:force_original_aspect_ratio=decrease:force_divisible_by=2`, `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`, 'setsar=1'];
}
const seconds = (ms: number) => (ms / 1000).toFixed(9);
const quoteConcat = (path: string) => `'${path.replace(/'/gu, "'\\''")}'`;
async function concatFile(paths: string[], folder: string, name: string): Promise<string> {
  const path = join(folder, `${name}.ffconcat`);
  await writeFile(path, `ffconcat version 1.0\n${paths.map(p => `file ${quoteConcat(p.replace(/\\/gu, '/'))}`).join('\n')}\n`);
  return path;
}
function assertCompatible(a: MediaProbe, b: MediaProbe, kind: TrackKind): void {
  if (a.codec !== b.codec || a.width !== b.width || a.height !== b.height || a.pixelFormat !== b.pixelFormat || a.channels !== b.channels)
    throw new BridgeError('INCOMPATIBLE_SESSIONS', `Codec/resolução/canais mudaram entre sessões ${kind}; nenhuma sessão será descartada implicitamente.`);
}
/** Clamp only the final sample's HOLD duration. Screen Studio often copies the previous
 * variable-frame duration to its terminal sample, extending it beyond the recorder stop.
 * Payloads and every original screen PTS remain unchanged. No -t/-shortest on video. */
function tailFilter(stats: PacketStats, targetMs: number): string {
  const last = stats.lastPresentationIndex, end = `${seconds(targetMs)}/TB`;
  // Prescale BEFORE evaluating at 60k ticks/s; the native 1/600 time base otherwise
  // adds a 1.67ms minimum sample to every pause. Only the terminal PTS/DTS may move,
  // when capture quantization puts that sample just past the exact recorder end.
  return `setts=time_base=1/60000:prescale=1:pts='if(eq(N,${last}),min(PTS,${end}-1),PTS)':dts='if(eq(N,${last}),DTS-max(0,PTS-(${end}-1)),DTS)':duration='if(eq(N,${last}),max(1,${end}-PTS),DURATION)'`;
}
export async function exportProject(options: ExportOptions): Promise<ExportResult> {
  const renderOptions = resolveRenderOptions(options), encoder = QUALITY[renderOptions.quality];
  const temp = new TempManager(), outputPath = resolve(options.outputPath);
  const signal = options.signal, ffmpeg = options.ffmpegPath ?? 'ffmpeg', ffprobe = options.ffprobePath ?? 'ffprobe';
  const tolerance = options.syncToleranceMs ?? 100;
  if (!Number.isFinite(tolerance) || tolerance <= 0 || tolerance > 100) throw new BridgeError('INVALID_TOLERANCE', 'Tolerância deve estar entre 0 e 100 ms.');
  let lock: string | undefined;
  const emit = (stage: string, percent: number, currentTrack: string, message: string) => options.onProgress?.({ stage, percent: Math.min(99.9, percent), currentTrack, message });
  try {
    checkAbort(signal); emit('analyze', 0, '', 'Validando pacote e todas as sessões.');
    const [ffmpegVersion, ffprobeVersion] = await Promise.all([toolVersion(ffmpeg), toolVersion(ffprobe)]);
    const bundlePath = await prepareInput(options.inputPath, temp, signal);
    const project = await parseProject(bundlePath, options.inputPath, signal);
    // Resolve ancestors BEFORE any writes, including symlinked output parents.
    let ancestor = outputPath, suffix: string[] = [];
    while (!await stat(ancestor).then(() => true).catch(() => false)) { suffix.unshift(basename(ancestor)); ancestor = dirname(ancestor); }
    const canonicalOutput = join(await realpath(ancestor), ...suffix);
    const canonicalInput = await realpath(bundlePath);
    if (isWithin(canonicalInput, canonicalOutput) || isWithin(canonicalOutput, canonicalInput))
      throw new BridgeError('OUTPUT_IN_INPUT', 'Saída não pode conter ou estar dentro do projeto original.');
    if (await stat(outputPath).then(s => !s.isDirectory()).catch(() => false) || (await readdir(outputPath).catch(() => [])).length)
      throw new BridgeError('OUTPUT_EXISTS', 'Pasta de saída não vazia; nenhum arquivo será sobrescrito.', 409);
    const space = await estimateDiskSpace(project, outputPath, renderOptions);
    if (space.sufficient === false) throw new BridgeError('INSUFFICIENT_SPACE', 'Espaço em disco insuficiente para a estimativa com margem de 1,5x.', 409);
    const parent = dirname(outputPath); await mkdir(parent, { recursive: true });
    lock = join(parent, `.bridge-lock-${createHash('sha256').update(canonicalOutput).digest('hex').slice(0, 20)}`);
    await mkdir(lock).catch(() => { lock = undefined; throw new BridgeError('OUTPUT_BUSY', 'Outra exportação reservou esta pasta.', 409); });
    const work = await temp.create(lock, 'work-'), staged = join(work, 'result'), sessionsDir = join(work, 'sessions');
    await mkdir(join(staged, '01_MEDIA'), { recursive: true }); await mkdir(join(staged, '02_DAVINCI')); await mkdir(sessionsDir);
    await mkdir(join(staged, '03_DATA')); await mkdir(join(staged, 'logs'));
    const display = project.tracks.find(t => t.kind === 'display')!;
    // Pair by chronological recording sessions, not filesystem glob or matching filenames.
    for (const track of project.tracks) {
      if (track.sessions.length !== display.sessions.length)
        throw new BridgeError('UNSUPPORTED_SESSION_LAYOUT', `${track.kind}: ${track.sessions.length} sessões contra ${display.sessions.length} da tela. Reconstrução ambígua bloqueada, não truncada.`);
      track.sessions.forEach((s, i) => {
        const master = display.sessions[i];
        if (Math.abs(s.unixStartMs - master.unixStartMs) > tolerance || Math.abs(s.unixEndMs - master.unixEndMs) > tolerance)
          throw new BridgeError('SESSION_ALIGNMENT', `${track.kind}, sessão ${i}: relógios divergem mais de ${tolerance}ms; exige mapeamento explícito.`);
      });
    }
    const tracks: TrackReport[] = [], screenDurations: number[] = [];
    const videoSettings: Partial<Record<'display' | 'webcam', VideoRenderSettings>> = {};
    let cumulativeMetadataMs = 0, cumulativeTicks = 0;
    const canonicalDurations = display.sessions.map(s => {
      cumulativeMetadataMs += s.durationMs;
      const next = Math.round(cumulativeMetadataMs * 60), duration = (next - cumulativeTicks) / 60;
      cumulativeTicks = next; return duration;
    });
    const totalWork = project.tracks.length * (display.sessions.length + 2);
    let workDone = 0;
    const progressFor = (stage: string, kind: TrackKind, message: string) => (percent: number) => emit(stage, 5 + (workDone + percent / 100) / totalWork * 83, kind, message);
    for (const track of project.tracks.sort((a, b) => TRACK_KINDS.indexOf(a.kind) - TRACK_KINDS.indexOf(b.kind))) {
      const video = track.kind === 'display' || track.kind === 'webcam';
      const resolution = track.kind === 'display' ? renderOptions.screenResolution : renderOptions.cameraResolution;
      const transcode = track.kind === 'webcam' || (track.kind === 'display' && resolution !== 'native');
      const sessionPaths: string[] = [], reports: SessionReport[] = [];
      let firstProbe: MediaProbe | undefined, timeline = 0;
      for (const [i, s] of track.sessions.entries()) {
        checkAbort(signal);
        const targetMs = track.kind === 'display' ? canonicalDurations[i] : screenDurations[i];
        const source = await probeMedia(s.sourcePath, { binary: ffprobe, signal, type: video ? 'video' : 'audio' });
        if (firstProbe) assertCompatible(firstProbe, source, track.kind); else firstProbe = source;
        if (track.kind === 'display' && source.codec !== 'h264') throw new BridgeError('SCREEN_CODEC', 'Tela deve ser H.264 para remux sem perda.');
        if (track.kind === 'webcam' && !['hevc', 'h264'].includes(source.codec)) throw new BridgeError('CAMERA_CODEC', 'Câmera deve ser HEVC ou H.264.');
        const stats = video ? await scanVideoPackets(s.sourcePath, ffprobe, signal) : undefined;
        const startOffsetMs = s.unixStartMs - display.sessions[i].unixStartMs;
        const path = join(sessionsDir, `${track.kind}-${i}${video ? '.mp4' : '.wav'}`);
        const opts = { binary: ffmpeg, signal, onPercent: progressFor('reconstruct', track.kind, `Reconstruindo sessão ${i + 1}/${track.sessions.length}.`) };
        let paddingMs = 0, tailAdjustmentMs = 0;
        if (track.kind === 'display' && !transcode) {
          const endPts = stats!.lastPtsMs - stats!.firstPtsMs;
          if (endPts - targetMs >= tolerance) throw new BridgeError('SOURCE_TIMING', `Tela sessão ${i}: frames posteriores ao fim declarado (> ${tolerance}ms).`);
          tailAdjustmentMs = targetMs - stats!.durationMs;
          await runFFmpeg([...localInputArgs(s.sourcePath), '-map', '0:v:0', '-an', '-c:v', 'copy', '-bsf:v', tailFilter(stats!, targetMs), '-video_track_timescale', '60000', '-movflags', '+faststart', path], targetMs, opts);
        } else if (video) {
          const endPts = stats!.lastPtsMs - stats!.firstPtsMs;
          const fps = source.frameRate?.split('/').map(Number) ?? [track.kind === 'display' ? 60 : 25, 1];
          const frameMs = fps[0] > 0 ? 1000 * fps[1] / fps[0] : 40;
          const desiredLastPts = Math.max(0, targetMs - Math.min(frameMs, 1));
          if (endPts - targetMs > tolerance) throw new BridgeError('SOURCE_TIMING', `${track.kind} sessão ${i}: cauda excede ${tolerance}ms.`);
          // Preserve every frame: compress ONLY the final <=1 second if a B-frame's
          // presentation timestamp outlives the recorder stop. Never force CFR/drop frames.
          const tailStart = Math.max(0, desiredLastPts - 1000);
          const scale = endPts > desiredLastPts ? (desiredLastPts - tailStart) / Math.max(1, endPts - tailStart) : 1;
          const relative = `(PTS-STARTPTS)*TB*1000`;
          const setpts = scale < 1 ? `if(lte(${relative}\\,${tailStart})\\,${relative}\\,${tailStart}+(${relative}-${tailStart})*${scale})/1000/TB` : 'PTS-STARTPTS';
          tailAdjustmentMs = Math.min(0, desiredLastPts - endPts);
          if (startOffsetMs > 0.5) paddingMs = startOffsetMs;
          const rawVideo = join(sessionsDir, `${track.kind}-${i}-encoded.mp4`);
          const filters = ['settb=1/60000', `setpts=${setpts}`, ...scaleFilters(resolution),
            ...(paddingMs ? [`tpad=start_mode=add:start_duration=${seconds(paddingMs)}:color=black`] : [])];
          await runFFmpeg([...localInputArgs(s.sourcePath), '-map', '0:v:0', '-an', '-vf', filters.join(','),
            '-c:v', 'libx264', '-profile:v', 'high', '-preset', encoder.preset, '-crf', String(encoder.crf), '-pix_fmt', 'yuv420p', '-bf', '0', '-fps_mode', 'passthrough', '-enc_time_base', '1/60000', '-video_track_timescale', '60000', rawVideo], targetMs, opts);
          const encodedStats = await scanVideoPackets(rawVideo, ffprobe, signal);
          if ((!paddingMs && encodedStats.count !== stats!.count) || encodedStats.count < stats!.count)
            throw new BridgeError('FRAME_LOSS', `${track.kind} sessão ${i}: ${stats!.count} frames de origem, ${encodedStats.count} codificados.`);
          await runFFmpeg(['-i', rawVideo, '-map', '0:v:0', '-an', '-c:v', 'copy', '-bsf:v', tailFilter(encodedStats, targetMs), '-video_track_timescale', '60000', '-movflags', '+faststart', path], targetMs, { binary: ffmpeg, signal });
          await rm(rawVideo);
        } else {
          const sampleCount = Math.round(targetMs * 48);
          const earlySamples = Math.round(Math.max(0, -startOffsetMs) * 48);
          const delaySamples = Math.round(Math.max(0, startOffsetMs) * 48);
          paddingMs = Math.max(0, targetMs - source.durationMs + startOffsetMs);
          const filters = ['aresample=48000', 'asetpts=PTS-STARTPTS', ...(earlySamples ? [`atrim=start_sample=${earlySamples}`, 'asetpts=PTS-STARTPTS'] : []),
            ...(delaySamples ? [`adelay=${delaySamples}S:all=1`] : []), `apad=whole_len=${sampleCount}`, `atrim=end_sample=${sampleCount}`, 'asetpts=N/SR/TB'];
          await runFFmpeg([...localInputArgs(s.sourcePath), '-map', '0:a:0', '-vn', '-af', filters.join(','), '-c:a', 'pcm_s24le', '-ar', '48000', '-rf64', 'auto', path], targetMs, opts);
        }
        const sessionProbe = await probeMedia(path, { binary: ffprobe, signal, type: video ? 'video' : 'audio' });
        if (track.kind === 'display') screenDurations.push(sessionProbe.durationMs);
        const boundaryDeviationMs = Math.abs(sessionProbe.durationMs - targetMs);
        if (boundaryDeviationMs >= tolerance) throw new BridgeError('SESSION_DRIFT', `${track.kind}, sessão ${i}: desvio ${boundaryDeviationMs.toFixed(3)}ms.`);
        reports.push({ index: s.index, source: s.outputFilename, metadataDurationMs: s.durationMs, sourceDurationMs: stats?.durationMs ?? source.durationMs,
          sourceFirstPtsMs: stats?.firstPtsMs ?? source.startTimeMs, timelineStartMs: timeline, timelineEndMs: timeline + sessionProbe.durationMs,
          sourceFrames: stats?.count, outputFrames: sessionProbe.frameCount, startOffsetMs, paddingMs, tailAdjustmentMs, boundaryDeviationMs });
        timeline += sessionProbe.durationMs; sessionPaths.push(path); workDone++;
      }
      const list = await concatFile(sessionPaths, sessionsDir, track.kind);
      const path = join(staged, '01_MEDIA', FILES[track.kind]);
      await runFFmpeg(['-protocol_whitelist', 'file', '-f', 'concat', '-safe', '0', '-i', list, '-map', video ? '0:v:0' : '0:a:0', ...(video ? ['-an', '-c:v', 'copy', '-video_track_timescale', '60000', '-movflags', '+faststart'] : ['-vn', '-c:a', 'pcm_s24le', '-ar', '48000', '-rf64', 'auto']), path], timeline,
        { binary: ffmpeg, signal, onPercent: progressFor('concat', track.kind, 'Unindo todas as sessões sem pausas de relógio.') });
      workDone++;
      emit('validate', 5 + workDone / totalWork * 83, track.kind, 'FFprobe: duração, codec e contagem de todos os frames decodificados.');
      const finalProbe = await probeMedia(path, { binary: ffprobe, signal, type: video ? 'video' : 'audio', countFrames: video });
      const expectedFrames = reports.reduce((n, r) => n + (r.outputFrames ?? 0), 0), sourceFrames = video ? reports.reduce((n, r) => n + (r.sourceFrames ?? 0), 0) : undefined;
      if (video && (finalProbe.frameCount !== expectedFrames || finalProbe.frameCount! < sourceFrames!))
        throw new BridgeError('FRAME_LOSS', `${track.kind}: ${expectedFrames} frames nas sessões, ${finalProbe.frameCount} no arquivo final.`);
      if (transcode && (finalProbe.codec !== 'h264' || finalProbe.profile !== 'High' || finalProbe.pixelFormat !== 'yuv420p'))
        throw new BridgeError('INVALID_VIDEO_OUTPUT', `${track.kind} fora do contrato H.264 High/yuv420p.`);
      if (track.kind === 'display' || track.kind === 'webcam') {
        const size = resolution === 'native' ? firstProbe! : SIZES[resolution];
        if (!finalProbe.width || !finalProbe.height || finalProbe.width !== size.width || finalProbe.height !== size.height)
          throw new BridgeError('INVALID_RESOLUTION', `${track.kind}: resolução final não corresponde a ${resolution}.`);
        videoSettings[track.kind] = { mode: transcode ? 'transcode' : 'remux', resolution, quality: renderOptions.quality,
          crf: transcode ? encoder.crf : null, x264Preset: transcode ? encoder.preset : null, width: finalProbe.width, height: finalProbe.height };
      }
      if (!video && (finalProbe.codec !== 'pcm_s24le' || finalProbe.sampleRate !== 48000)) throw new BridgeError('INVALID_AUDIO_OUTPUT', 'Áudio fora do contrato PCM 24-bit/48kHz.');
      tracks.push({ kind: track.kind, file: FILES[track.kind], sessionCount: track.sessions.length, expectedDurationMs: project.durationMs,
        actualDurationMs: finalProbe.durationMs, deviationMs: Math.abs(finalProbe.durationMs - project.durationMs), framesPreserved: video ? true : null,
        sourceFrames, outputFrames: video ? finalProbe.frameCount : undefined, nominalFrameRate: video ? firstProbe?.frameRate : undefined,
        sessions: reports, probe: { ...finalProbe, path: join(outputPath, '01_MEDIA', FILES[track.kind]) } });
      workDone++;
    }
    checkAbort(signal);
    const durations = tracks.map(t => t.actualDurationMs), interTrackDeviationMs = Math.max(...durations) - Math.min(...durations);
    const maxDeviationMs = Math.max(interTrackDeviationMs, ...tracks.map(t => t.deviationMs), ...tracks.flatMap(t => t.sessions.map(s => s.boundaryDeviationMs)), ...tracks.map(t => Math.abs(t.probe.startTimeMs)));
    const timelineDurationMs = tracks.find(t => t.kind === 'display')!.actualDurationMs;
    const generatedAt = new Date().toISOString();
    const syncReport: SyncReport = { schemaVersion: 1, generatedAt, status: maxDeviationMs < tolerance ? 'ok' : 'failed', toleranceMs: tolerance, maxDeviationMs,
      interTrackDeviationMs, timelineDurationMs, metadataDurationMs: project.durationMs, tracks, warnings: [...project.warnings,
        renderOptions.screenResolution === 'native' ? 'Tela preservada como H.264 VFR original, sem remoção de frames; validar importação na versão alvo do Resolve.' : 'Tela redimensionada em 4K/H.264 VFR preservando todos os frames; requer validação no Resolve alvo.',
        ...(renderOptions.cameraResolution !== 'native' || renderOptions.screenResolution !== 'native' ? ['Redimensionamento Lanczos preserva o aspecto com barras quando necessário; upscale não cria detalhes ausentes na fonte.'] : []),
        'Sincronismo é validado por relógios, fronteiras e frames. Não comprova sincronismo perceptual de fala/ação.',
        'Áudio aparado/preenchido em silêncio por sessão até o fim da tela; nunca normalizado ou misturado.'], scope: 'timestamp-and-frame-integrity' };
    if (syncReport.status !== 'ok') throw new BridgeError('SYNC_FAILED', `Validação falhou: desvio ${maxDeviationMs.toFixed(3)}ms (limite estrito < ${tolerance}ms).`);
    const fcpxmlFile = `${project.name}.fcpxml`;
    const manifest: ProjectManifest = { schemaVersion: 1, projectName: project.name, inputPath: resolve(options.inputPath), generatedAt, pausePolicy: 'remove-wall-clock-pauses',
      timelineDurationMs, metadataDurationMs: project.durationMs, sessionCount: project.sessionCount,
      media: tracks.map(t => ({ kind: t.kind, file: `01_MEDIA/${t.file}`, durationMs: t.actualDurationMs, codec: t.probe.codec })),
      fcpxml: `02_DAVINCI/${fcpxmlFile}`, missingTracks: TRACK_KINDS.filter(k => !tracks.some(t => t.kind === k)), ffmpegVersion, ffprobeVersion, renderOptions, videoSettings };
    emit('fcpxml', 95, 'fcpxml', 'Gerando timeline V1/V2/A1/A2 e relatórios.');
    await writeFile(join(staged, '02_DAVINCI', fcpxmlFile), generateFcpxml(project.name, outputPath, tracks, timelineDurationMs));
    await writeFile(join(staged, '03_DATA', 'sync_report.json'), JSON.stringify(syncReport, null, 2) + '\n');
    await writeFile(join(staged, '03_DATA', 'project_manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    await writeFile(join(staged, 'logs', 'export.log'), [generatedAt, ffmpegVersion, ffprobeVersion,
      `Render: ${JSON.stringify(renderOptions)}; effectiveVideo: ${JSON.stringify(videoSettings)}`,
      `Sessions: ${project.sessionCount}; metadata: ${project.durationMs}ms; max deviation: ${maxDeviationMs}ms`,
      ...tracks.flatMap(t => t.sessions.map(s => `${t.kind} session ${s.index}: source=${s.source} start=${s.timelineStartMs} end=${s.timelineEndMs} frames=${s.sourceFrames ?? '-'}->${s.outputFrames ?? '-'} tailAdjustment=${s.tailAdjustmentMs}ms`)), ...syncReport.warnings].join('\n') + '\n');
    checkAbort(signal);
    // Publish only a fully validated result. rename onto a missing output is atomic.
    if (!await stat(outputPath).then(() => true).catch(() => false)) await rename(staged, outputPath);
    else {
      if ((await readdir(outputPath)).length) throw new BridgeError('OUTPUT_EXISTS', 'Pasta foi alterada durante o processamento; publicação bloqueada.', 409);
      const moved: string[] = [];
      try { for (const name of await readdir(staged)) { await rename(join(staged, name), join(outputPath, name)); moved.push(name); } }
      catch (error) { for (const name of moved.reverse()) await rename(join(outputPath, name), join(staged, name)); throw error; }
    }
    const result: ExportResult = { outputPath, fcpxmlPath: join(outputPath, '02_DAVINCI', fcpxmlFile), manifestPath: join(outputPath, '03_DATA', 'project_manifest.json'), syncReportPath: join(outputPath, '03_DATA', 'sync_report.json'), manifest, syncReport };
    options.onProgress?.({ stage: 'complete', percent: 100, currentTrack: '', message: 'Mídias e timeline validadas.', state: 'completed', result });
    return result;
  } finally {
    await temp.dispose();
    if (lock) await rm(lock, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
}
