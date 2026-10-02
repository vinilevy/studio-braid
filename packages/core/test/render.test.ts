import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { analyzeProject, BridgeError, estimateDiskSpace, exportProject, resolveRenderOptions, runProcess,
  type CameraResolution, type ProjectMetadata, type RenderOptions, type RenderQuality, type TrackKind } from '../src/index.js';

const project = (durationMs: number, kinds: TrackKind[] = ['display', 'webcam', 'microphone', 'systemAudio']): ProjectMetadata => ({
  name: 'Estimate', inputPath: '/source', bundlePath: '/source', durationMs, sessionCount: 1, warnings: [],
  tracks: kinds.map(kind => ({ kind, durationMs, sessions: [] })),
});
test('render defaults and strict core enum validation; no silent fallback for invalid presets', () => {
  assert.deepEqual(resolveRenderOptions(), { cameraResolution: '4k', quality: 'maximum', screenResolution: 'native' });
  assert.deepEqual(resolveRenderOptions({ cameraResolution: 'native', quality: 'fast', screenResolution: '4k' }), { cameraResolution: 'native', quality: 'fast', screenResolution: '4k' });
  for (const options of [{ cameraResolution: '8k' }, { cameraResolution: null }, { quality: 'studio' }, { quality: null }, { screenResolution: '1080p' }])
    assert.throws(() => resolveRenderOptions(options as RenderOptions), BridgeError);
});
test('disk estimate uses duration, present tracks and resolutions; single 1.5x margin, no 90Mbps/x2/fixed overhead', async () => {
  const seconds = 1800, audioBitrate = 48_000 * 24 * 2;
  const estimated = await estimateDiskSpace(project(seconds * 1000), tmpdir());
  assert.equal(estimated.estimatedRequiredBytes, Math.ceil(seconds * (3_000_000 + 10_000_000 + 2 * audioBitrate) / 8 * 1.5));
  assert.equal(estimated.estimatedRequiredBytes, 5_942_700_000);
  const longer = await estimateDiskSpace(project(2400_000), tmpdir());
  assert.equal(longer.estimatedRequiredBytes, 7_923_600_000);
  assert.equal((await estimateDiskSpace(project(1800_000, ['display']), tmpdir())).estimatedRequiredBytes, 1_012_500_000);
  const hd = await estimateDiskSpace(project(1800_000), tmpdir(), { cameraResolution: '1080p' });
  const upscaledScreen = await estimateDiskSpace(project(1800_000), tmpdir(), { screenResolution: '4k' });
  assert.ok(hd.estimatedRequiredBytes < estimated.estimatedRequiredBytes);
  assert.ok(upscaledScreen.estimatedRequiredBytes > estimated.estimatedRequiredBytes);
  assert.equal((await estimateDiskSpace(project(0, []), tmpdir())).estimatedRequiredBytes, 0);
});

async function sourceBundle(dir: string) {
  const bundle = join(dir, 'Presets.screenstudio'), recording = join(bundle, 'recording');
  await mkdir(recording, { recursive: true }); await writeFile(join(bundle, 'meta.json'), '{}'); await writeFile(join(bundle, 'project.json'), '{}');
  for (const [kind, size, rate, color] of [['display', '320x180', '60', 'blue'], ['webcam', '192x144', '25', 'red']]) {
    await runProcess('ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', `color=c=${color}:size=${size}:rate=${rate}`, '-t', '0.12', '-an',
      '-c:v', 'libx264', '-profile:v', 'high', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-bf', kind === 'webcam' ? '2' : '0', '-output_ts_offset', '123.456', join(recording, `${kind}.mp4`)]);
  }
  await writeFile(join(recording, 'metadata.json'), JSON.stringify({ recorders: ['display', 'webcam'].map(type => ({ type,
    sessions: [{ durationMs: 120, unixStartMs: 100_000, unixEndMs: 100_120, outputFilename: `${type}.mp4` }] })) }));
  return bundle;
}
test('real FFmpeg: all 9 camera resolution/quality combinations, 4:3 fit+pad, exact native size, frames/timing and explicit screen 4K', { timeout: 180_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-render-test-'));
  try {
    const bundle = await sourceBundle(dir);
    const expected = { maximum: { crf: 14, preset: 'slow' }, high: { crf: 17, preset: 'medium' }, fast: { crf: 18, preset: 'veryfast' } };
    const analysis4k = await analyzeProject(bundle, join(dir, 'analysis4k'), undefined, { cameraResolution: '4k', quality: 'maximum' });
    const analysisHD = await analyzeProject(bundle, join(dir, 'analysisHD'), undefined, { cameraResolution: '1080p', quality: 'high' });
    assert.ok(analysisHD.diskSpace.estimatedRequiredBytes < analysis4k.diskSpace.estimatedRequiredBytes);
    assert.equal(analysis4k.renderOptions?.quality, 'maximum');
    for (const cameraResolution of ['native', '1080p', '4k'] as CameraResolution[]) {
      for (const quality of ['maximum', 'high', 'fast'] as RenderQuality[]) {
        const result = await exportProject({ inputPath: bundle, outputPath: join(dir, `${cameraResolution}-${quality}`), cameraResolution, quality });
        const camera = result.syncReport.tracks.find(t => t.kind === 'webcam')!, screen = result.syncReport.tracks.find(t => t.kind === 'display')!;
        const [width, height] = cameraResolution === 'native' ? [192, 144] : cameraResolution === '1080p' ? [1920, 1080] : [3840, 2160];
        assert.equal(camera.probe.width, width); assert.equal(camera.probe.height, height);
        assert.equal(camera.probe.codec, 'h264'); assert.equal(camera.probe.profile, 'High'); assert.equal(camera.probe.pixelFormat, 'yuv420p');
        assert.equal(camera.outputFrames, camera.sourceFrames); assert.equal(screen.outputFrames, screen.sourceFrames);
        assert.equal(screen.probe.width, 320); assert.equal(screen.probe.height, 180); assert.ok(result.syncReport.maxDeviationMs < 0.1);
        const settings = result.manifest.videoSettings?.webcam;
        assert.equal(settings?.crf, expected[quality].crf); assert.equal(settings?.x264Preset, expected[quality].preset);
        assert.equal(result.manifest.videoSettings?.display?.mode, 'remux');
        assert.equal(result.manifest.videoSettings?.display?.crf, null);
        const path = join(result.outputPath, '01_MEDIA', 'CAMERA.mp4');
        // x264 stores its effective CRF in the unregistered SEI payload.
        assert.ok((await readFile(path)).includes(Buffer.from(`crf=${expected[quality].crf.toFixed(1)}`)));
        const { stdout } = await runProcess('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=sample_aspect_ratio', '-of', 'json', path]);
        assert.equal(JSON.parse(stdout).streams[0].sample_aspect_ratio, '1:1');
        const xml = await readFile(result.fcpxmlPath, 'utf8'); assert.match(xml, new RegExp(`width="${width}" height="${height}"`));
        if (cameraResolution === '4k' && quality === 'fast') {
          // 4:3 source fills 2880x2160 centered in 3840x2160, so left pad is black, not stretched red.
          const corner = await runProcess('ffmpeg', ['-i', path, '-vf', 'crop=16:16:0:0,signalstats,metadata=mode=print', '-frames:v', '1', '-f', 'null', '-'], { allowStderr: true });
          const center = await runProcess('ffmpeg', ['-i', path, '-vf', 'crop=16:16:1920:1080,signalstats,metadata=mode=print', '-frames:v', '1', '-f', 'null', '-'], { allowStderr: true });
          assert.match(corner.stderr, /lavfi.signalstats.YAVG=16(?:\s|$)/u);
          assert.match(center.stderr, /lavfi.signalstats.YAVG=81(?:\s|$)/u);
        }
      }
    }
    const result = await exportProject({ inputPath: bundle, outputPath: join(dir, 'screen-4k'), cameraResolution: 'native', screenResolution: '4k', quality: 'fast' });
    const screen = result.syncReport.tracks.find(t => t.kind === 'display')!;
    assert.equal(screen.probe.width, 3840); assert.equal(screen.probe.height, 2160); assert.equal(screen.probe.profile, 'High');
    assert.equal(screen.outputFrames, screen.sourceFrames); assert.equal(result.manifest.videoSettings?.display?.mode, 'transcode');
    assert.ok(result.syncReport.maxDeviationMs < 0.1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
