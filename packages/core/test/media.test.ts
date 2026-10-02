import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { exportProject, runFFmpeg, runProcess, scanVideoPackets, TempManager } from '../src/index.js';

async function makeVideo(recording: string, kind: string, index: number, durationMs: number, fps: number) {
  const base = `${kind}-${index}`, path = join(recording, `${base}.m3u8`);
  await runProcess('ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', `testsrc2=size=160x96:rate=${fps}`, '-t', String(durationMs / 1000), '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p', '-bf', kind === 'webcam' ? '2' : '0', '-output_ts_offset', '123.456',
    '-f', 'hls', '-hls_time', '0.2', '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', `${base}-init.mp4`, '-hls_segment_filename', join(recording, `${base}-%03d.m4s`), path]);
  return `${base}.m3u8`;
}
test('real FFmpeg: three HLS sessions, B-frame clock offset, complete four tracks, frame proof and portable XML', { timeout: 90_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-media-test-')), bundle = join(dir, 'A & B.screenstudio'), recording = join(bundle, 'recording');
  await mkdir(recording, { recursive: true }); await writeFile(join(bundle, 'meta.json'), '{}'); await writeFile(join(bundle, 'project.json'), '{}');
  const recorders: { type: string; sessions: object[] }[] = [];
  try {
    for (const kind of ['display', 'webcam', 'microphone', 'systemAudio']) {
      const sessions: object[] = [];
      for (const [i, durationMs] of [360, 840, 560].entries()) {
        let outputFilename: string;
        if (kind === 'display' || kind === 'webcam') outputFilename = await makeVideo(recording, kind, i, durationMs, kind === 'display' ? 60 : 25);
        else {
          outputFilename = `${kind}-${i}.m4a`;
          await runProcess('ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=44100', '-t', String((durationMs + (i === 1 ? -100 : 80)) / 1000), '-c:a', 'aac', join(recording, outputFilename)]);
        }
        sessions.push({ durationMs, unixStartMs: 100_000 + i * 5000, unixEndMs: 100_000 + i * 5000 + durationMs, outputFilename });
      }
      recorders.push({ type: kind, sessions });
    }
    await writeFile(join(recording, 'metadata.json'), JSON.stringify({ recorders }));
    const output = join(dir, 'output'), events: number[] = [];
    const result = await exportProject({ inputPath: bundle, outputPath: output, onProgress: e => events.push(e.percent) });
    assert.equal(result.manifest.sessionCount, 3); assert.equal(result.syncReport.tracks.length, 4); assert.ok(result.syncReport.maxDeviationMs < 1);
    assert.ok(events.every((p, i) => i === 0 || p >= events[i - 1]));
    assert.deepEqual(result.manifest.renderOptions, { cameraResolution: '4k', quality: 'maximum', screenResolution: 'native' });
    assert.equal(result.manifest.videoSettings?.webcam?.x264Preset, 'slow'); assert.equal(result.manifest.videoSettings?.webcam?.crf, 14);
    const camera = result.syncReport.tracks.find(t => t.kind === 'webcam')!;
    assert.equal(camera.probe.width, 3840); assert.equal(camera.probe.height, 2160);
    for (const t of result.syncReport.tracks) {
      assert.equal(t.sessionCount, 3); assert.ok(Math.abs(t.actualDurationMs - 1760) < 1); assert.equal(t.probe.startTimeMs, 0);
      if (t.sourceFrames) assert.equal(t.outputFrames, t.sourceFrames);
    }
    const xml = await readFile(result.fcpxmlPath, 'utf8'); assert.match(xml, /version="1.10"/u); assert.match(xml, /A &amp; B/u); assert.match(xml, /src="\.\.\/01_MEDIA\/CAMERA.mp4"/u);
    for (const lane of ['1', '-1', '-2']) assert.match(xml, new RegExp(`lane="${lane}"`));
    await assert.rejects(exportProject({ inputPath: bundle, outputPath: output }), /não vazia/iu);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('60 pauses: no cumulative native-1/600 rounding drift and no frames dropped', { timeout: 120_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-many-pauses-')), bundle = join(dir, 'Many.screenstudio'), recording = join(bundle, 'recording'); await mkdir(recording, { recursive: true });
  try {
    await writeFile(join(bundle, 'meta.json'), '{}'); await writeFile(join(bundle, 'project.json'), '{}');
    const original = await makeVideo(recording, 'display', 0, 120, 60), content = await readFile(join(recording, original), 'utf8');
    const sourceCount = (await scanVideoPackets(join(recording, original))).count;
    const sessions: object[] = [], durationMs = 120.123;
    for (let i = 0; i < 60; i++) {
      const outputFilename = `session-${i}.m3u8`; await writeFile(join(recording, outputFilename), content);
      sessions.push({ durationMs, unixStartMs: 100_000 + i * 3000, unixEndMs: 100_000 + i * 3000 + durationMs, outputFilename });
    }
    await writeFile(join(recording, 'metadata.json'), JSON.stringify({ recorders: [{ type: 'display', sessions }] }));
    const result = await exportProject({ inputPath: bundle, outputPath: join(dir, 'output') });
    assert.equal(result.manifest.sessionCount, 60); assert.equal(result.syncReport.tracks[0].outputFrames, sourceCount * 60);
    assert.ok(result.syncReport.maxDeviationMs < 0.1, `drift: ${result.syncReport.maxDeviationMs} ms`);
    assert.equal(result.manifest.missingTracks.length, 3);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('actual FFmpeg SIGTERM: waits for close, deletes owned intermediates', { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-cancel-')), temp = new TempManager(), work = await temp.create(dir);
  try {
    const controller = new AbortController();
    const task = runFFmpeg(['-re', '-f', 'lavfi', '-i', 'testsrc2=size=160x96:rate=25', '-an', '-c:v', 'libx264', '-preset', 'veryfast', join(work, 'infinite.mp4')], 10000, {
      signal: controller.signal, onPercent: p => { if (p > 0) controller.abort(); },
    });
    await assert.rejects(task, /cancelado/iu); await temp.dispose(); assert.deepEqual(await readdir(dir), []);
  } finally { await temp.dispose(); await rm(dir, { recursive: true, force: true }); }
});
