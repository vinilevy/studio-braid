import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ExportOptions, ExportResult } from '@screen-studio-bridge/core';
import { createServer } from '../src/app.js';
import { JobManager, type ExportRunner } from '../src/jobs.js';

const headers = { host: '127.0.0.1:3847' };
const result = { outputPath: '/output', syncReport: { maxDeviationMs: 0 }, manifest: {} } as ExportResult;
const eventual = async (check: () => boolean) => { for (let i = 0; i < 100; i++) { if (check()) return; await sleep(10); } assert.fail('timed out'); };
test('HTTP jobs forward selected camera/quality/screen options; defaults persist in queued snapshots; invalid enums rejected', async () => {
  const received: ExportOptions[] = [];
  const { app, jobs } = await createServer({ runner: async options => { received.push(options); return result; } });
  try {
    for (const [i, options] of [{}, { cameraResolution: 'native', quality: 'fast' }, { cameraResolution: '1080p', quality: 'high', screenResolution: '4k' }].entries()) {
      const response = await app.inject({ method: 'POST', url: '/api/jobs', headers, payload: { inputPath: '/a', outputPath: `/out-${i}`, ...options } });
      assert.equal(response.statusCode, 202, response.body);
      const snapshot = response.json(); await eventual(() => jobs.get(snapshot.id).state === 'completed');
      assert.equal(snapshot.cameraResolution, options.cameraResolution ?? '4k'); assert.equal(snapshot.quality, options.quality ?? 'maximum');
      assert.equal(received[i].cameraResolution, snapshot.cameraResolution); assert.equal(received[i].quality, snapshot.quality);
      assert.equal(received[i].screenResolution, options.screenResolution ?? 'native');
    }
    for (const options of [{ quality: 'studio' }, { quality: null }, { cameraResolution: '8k' }, { screenResolution: '1080p' }, { surprise: 'field' }]) {
      const response = await app.inject({ method: 'POST', url: '/api/jobs', headers, payload: { inputPath: '/a', outputPath: '/b', ...options } });
      assert.equal(response.statusCode, 400); assert.equal(response.json().error.code, 'INVALID_REQUEST');
    }
    assert.equal(received.length, 3);
  } finally { await app.close(); }
});
test('HTTP analyze accepts profile options and estimates the same selected resolution', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-analysis-options-')), bundle = join(dir, 'Profile.screenstudio'), recording = join(bundle, 'recording');
  await mkdir(recording, { recursive: true }); await writeFile(join(bundle, 'meta.json'), '{}'); await writeFile(join(bundle, 'project.json'), '{}');
  for (const type of ['display', 'webcam']) await writeFile(join(recording, `${type}.mp4`), 'placeholder');
  await writeFile(join(recording, 'metadata.json'), JSON.stringify({ recorders: ['display', 'webcam'].map(type => ({ type,
    sessions: [{ durationMs: 1800_000, unixStartMs: 1000, unixEndMs: 1801_000, outputFilename: `${type}.mp4` }] })) }));
  const { app } = await createServer();
  try {
    const results = [];
    for (const cameraResolution of ['4k', '1080p']) {
      const response = await app.inject({ method: 'POST', url: '/api/projects/analyze', headers, payload: { inputPath: bundle, outputPath: join(dir, 'out'), cameraResolution, quality: 'high' } });
      assert.equal(response.statusCode, 200, response.body); const analysis = response.json(); results.push(analysis);
      assert.equal(analysis.renderOptions.cameraResolution, cameraResolution); assert.equal(analysis.renderOptions.quality, 'high');
    }
    assert.ok(results[1].diskSpace.estimatedRequiredBytes < results[0].diskSpace.estimatedRequiredBytes);
    assert.equal((await app.inject({ method: 'POST', url: '/api/projects/analyze', headers, payload: { inputPath: bundle, quality: 'studio' } })).statusCode, 400);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});
test('job queue is serial; cancel queued and running; terminal replay has result; output reservations', async () => {
  let active = 0, peak = 0, started = 0; const cleaned: string[] = [];
  const runner: ExportRunner = async options => {
    active++; peak = Math.max(peak, active); started++;
    try {
      options.onProgress?.({ stage: 'reconstruct', percent: 40, currentTrack: 'display', message: 'test' });
      await sleep(100, undefined, { signal: options.signal }); return result;
    } finally { active--; }
  };
  const manager = new JobManager(runner, {}, async path => { cleaned.push(path); });
  const a = manager.create({ inputPath: '/a', outputPath: '/out-a' });
  await eventual(() => manager.get(a.id).state === 'running');
  const b = manager.create({ inputPath: '/b', outputPath: '/out-b' });
  assert.throws(() => manager.create({ inputPath: '/c', outputPath: '/out-b' }), /reservando/iu);
  manager.cancel(b.id); manager.cancel(a.id);
  assert.equal(manager.get(b.id).state, 'cancelled');
  await eventual(() => manager.get(a.id).state === 'cancelled');
  const c = manager.create({ inputPath: '/c', outputPath: '/out-c' });
  await eventual(() => manager.get(c.id).state === 'completed');
  assert.equal(peak, 1); assert.equal(started, 2); assert.equal(manager.get(c.id).progress.percent, 100);
  assert.equal(manager.history(c.id).at(-1)?.data.state, 'completed'); assert.equal(manager.history(c.id).at(-1)?.data.result?.outputPath, '/output');
  assert.deepEqual(cleaned.sort(), ['/a', '/b', '/c']); await manager.close();
});
test('HTTP: status, errors, Host/Origin/rebinding guard, real metadata analysis and static SPA', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-server-test-')); await writeFile(join(dir, 'index.html'), '<h1>local UI</h1>');
  const { app } = await createServer({ staticDir: dir, ffmpegPath: '/missing/ffmpeg', ffprobePath: '/missing/ffprobe' });
  try {
    assert.equal((await app.inject({ url: '/api/status', headers })).json().status, 'degraded');
    assert.equal((await app.inject({ url: '/api/status', headers: { host: 'evil.example' } })).statusCode, 403);
    assert.equal((await app.inject({ url: '/api/status', headers: { ...headers, origin: 'https://evil.example' } })).statusCode, 403);
    assert.equal((await app.inject({ url: '/api/status', headers: { ...headers, 'sec-fetch-site': 'cross-site' } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/jobs', headers, payload: { inputPath: '/a' } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/api/projects/analyze', headers, payload: { inputPath: 'relative' } })).statusCode, 400);
    const missing = await app.inject({ method: 'POST', url: '/api/projects/analyze', headers, payload: { inputPath: '/does-not-exist' } });
    assert.equal(missing.statusCode, 422); assert.equal(missing.json().error.code, 'INPUT_NOT_FOUND');
    assert.equal((await app.inject({ url: '/api/jobs/missing', headers })).statusCode, 404);
    const page = await app.inject({ url: '/deep/spa/path', headers }); assert.equal(page.statusCode, 200); assert.match(page.body, /local UI/u);
    assert.equal((await app.inject({ url: '/assets/missing.js', headers })).statusCode, 404);
    assert.equal((await app.inject({ url: '/api/unknown', headers })).statusCode, 404);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});
test('SSE wire contract, incremental ids, Last-Event-ID replay and graceful shutdown', async () => {
  const { app, jobs } = await createServer({ runner: async options => { options.onProgress?.({ stage: 'reconstruct', percent: 35, currentTrack: 'webcam', message: 'real progress' }); await sleep(150, undefined, { signal: options.signal }); return result; } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  try {
    const created = await app.inject({ method: 'POST', url: '/api/jobs', headers, payload: { inputPath: '/a', outputPath: '/b' } });
    assert.equal(created.statusCode, 202); const id = created.json().jobId; assert.equal(id, created.json().id);
    const stream = await fetch(`${url}/api/jobs/${id}/events`, { headers });
    assert.equal(stream.headers.get('content-type'), 'text/event-stream; charset=utf-8'); const body = await stream.text();
    const events = body.split('\n\n').filter(s => s.includes('data: ')).map(s => ({ id: Number(s.match(/id: (\d+)/u)?.[1]), data: JSON.parse(s.match(/data: (.*)/u)![1]) }));
    assert.ok(events.every(e => typeof e.data.stage === 'string' && typeof e.data.percent === 'number' && typeof e.data.currentTrack === 'string' && typeof e.data.message === 'string'));
    assert.equal(events.at(-1)!.data.state, 'completed'); assert.equal(events.at(-1)!.data.result.outputPath, '/output');
    const replay = await fetch(`${url}/api/jobs/${id}/events`, { headers: { ...headers, 'last-event-id': String(events.at(-2)!.id) } });
    const replayText = await replay.text(); assert.match(replayText, /"stage":"complete"/u); assert.doesNotMatch(replayText, /"stage":"queued"/u);
    assert.equal(jobs.get(id).state, 'completed');
    assert.equal((await app.inject({ method: 'POST', url: `/api/jobs/${id}/cancel`, headers })).json().state, 'completed');
    const pending = await app.inject({ method: 'POST', url: '/api/jobs', headers, payload: { inputPath: '/c', outputPath: '/d' } });
    assert.equal((await app.inject({ method: 'POST', url: `/api/jobs/${pending.json().id}/open-output`, headers })).statusCode, 409);
  } finally { await app.close(); }
});
test('multipart streams local folder paths, cleanup on server close and rejects Zip Slip', async () => {
  const { app } = await createServer(); const boundary = 'bridge-boundary';
  const body = (files: [string, string][]) => files.map(([path, content]) => `--${boundary}\r\nContent-Disposition: form-data; name="path"\r\n\r\n${path}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="ignored.bin"\r\nContent-Type: application/octet-stream\r\n\r\n${content}\r\n`).join('') + `--${boundary}--\r\n`;
  let uploaded: string | undefined;
  try {
    const unsafe = await app.inject({ method: 'POST', url: '/api/projects/analyze', headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body([['../escape', 'x']]) });
    assert.equal(unsafe.statusCode, 422);
    const metadata = { recorders: [{ type: 'display', sessions: [{ durationMs: 1000, unixStartMs: 1000, unixEndMs: 2000, outputFilename: 'x.mp4' }] }] };
    const analyzed = await app.inject({ method: 'POST', url: '/api/projects/analyze', headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body([['Mock.screenstudio/meta.json', '{}'], ['Mock.screenstudio/project.json', '{}'], ['Mock.screenstudio/recording/metadata.json', JSON.stringify(metadata)], ['Mock.screenstudio/recording/x.mp4', 'placeholder']]) });
    assert.equal(analyzed.statusCode, 200, analyzed.body); assert.equal(analyzed.json().name, 'Mock'); uploaded = analyzed.json().inputPath;
    assert.equal(await readFile(join(uploaded!, 'meta.json'), 'utf8'), '{}');
  } finally { await app.close(); if (uploaded) await assert.rejects(readdir(uploaded)); }
});
