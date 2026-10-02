import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { analyzeProject, BridgeError, exportProject, extractZip, parseProject, runProcess, safeRelativePath, TempManager } from '../src/index.js';

const fixture = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-core-test-'));
  const bundle = join(dir, 'Teste.screenstudio'); await mkdir(join(bundle, 'recording'), { recursive: true });
  await writeFile(join(bundle, 'meta.json'), '{}'); await writeFile(join(bundle, 'project.json'), '{}');
  return { dir, bundle };
};
const crc32 = (buf: Buffer) => {
  let c = 0xffffffff;
  for (const b of buf) { c ^= b; for (let j = 0; j < 8; j++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); }
  return (c ^ 0xffffffff) >>> 0;
};
function zip(entries: { name: string; content?: string; mode?: number }[]): Buffer {
  let offset = 0; const locals: Buffer[] = [], centrals: Buffer[] = [];
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8'), data = Buffer.from(e.content ?? ''), crc = crc32(data);
    // Finder-compatible stored payload + data descriptor, UTF8 name but flag11 not set.
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 6); local.writeUInt16LE(name.length, 26);
    const dd = Buffer.alloc(16); dd.writeUInt32LE(0x08074b50); dd.writeUInt32LE(crc, 4); dd.writeUInt32LE(data.length, 8); dd.writeUInt32LE(data.length, 12);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 8);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((e.mode ?? 0o100644) << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, name, data, dd); centrals.push(central, name); offset += local.length + name.length + data.length + dd.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

test('paths block Zip Slip, Windows paths, ADS and devices', () => {
  for (const path of ['../x', '/etc/passwd', 'C:/x', 'a\\..\\x', 'a//b', 'a/./b', 'a/../b', 'CON.txt', 'a/secret:stream', 'a\0x'])
    assert.throws(() => safeRelativePath(path), BridgeError);
  assert.equal(safeRelativePath('projeto-co\u0301pia/file.m4s'), 'projeto-cópia/file.m4s');
});
test('ZIP decoder supports Finder UTF8 without flag, descriptor and ignores AppleDouble', async () => {
  const { dir } = await fixture();
  try {
    const input = join(dir, 'input.zip'), out = join(dir, 'out'); await mkdir(out);
    await writeFile(input, zip([{ name: 'co\u0301pia.screenstudio/recording/metadata.json', content: '{}' }, { name: '__MACOSX/co\u0301pia.screenstudio/recording/._metadata.json', content: 'not JSON' }]));
    await extractZip(input, out);
    assert.deepEqual(await readdir(out), ['cópia.screenstudio']);
    assert.equal(await readFile(join(out, 'cópia.screenstudio/recording/metadata.json'), 'utf8'), '{}');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('ZIP rejects traversal, symlink and NFC/case duplicates', async () => {
  const { dir } = await fixture();
  try {
    for (const [index, entries] of [[{ name: '../escape' }], [{ name: 'link', mode: 0o120777 }], [{ name: 'a' }, { name: 'A' }], [{ name: 'é' }, { name: 'e\u0301' }]].entries()) {
      const input = join(dir, `${index}.zip`), out = join(dir, `out${index}`); await mkdir(out); await writeFile(input, zip(entries));
      await assert.rejects(extractZip(input, out), BridgeError);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('metadata rigor: ignore cursor/input, decimals, all sessions, reject missing/duplicate/overlap', async () => {
  const { dir, bundle } = await fixture();
  const s = (n: number) => ({ durationMs: 1000.123, unixStartMs: 10000 + n * 2000, unixEndMs: 11000.123 + n * 2000, outputFilename: `${n}.mp4` });
  const metadata = { recorders: [{ type: 'cursor' }, { type: 'input', sessions: [{}] }, { type: 'display', sessions: [s(1), s(0), s(2)] }] };
  try {
    for (let i = 0; i < 3; i++) await writeFile(join(bundle, `recording/${i}.mp4`), 'placeholder');
    const file = join(bundle, 'recording/metadata.json'); await writeFile(file, JSON.stringify(metadata));
    const p = await parseProject(bundle); assert.equal(p.sessionCount, 3); assert.equal(p.durationMs, 3000.369); assert.equal(p.tracks[0].sessions[0].index, 1);
    await writeFile(file, JSON.stringify({ recorders: [{ type: 'display', sessions: [s(0), { ...s(1), outputFilename: '0.mp4' }] }] }));
    await assert.rejects(parseProject(bundle), /reutilizado|duplicad/iu);
    await writeFile(file, JSON.stringify({ recorders: [{ type: 'display', sessions: [{ ...s(0), outputFilename: '../meta.json' }] }] }));
    await assert.rejects(parseProject(bundle), /inseguro/iu);
    await writeFile(file, JSON.stringify({ recorders: [{ type: 'display', sessions: [{ ...s(0), durationMs: 5 }] }] }));
    await assert.rejects(parseProject(bundle), /inconsistente/iu);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('HLS remote URI and symlink references are blocked before ffmpeg', async () => {
  const { dir, bundle } = await fixture();
  try {
    const meta = { recorders: [{ type: 'display', sessions: [{ durationMs: 1000, unixStartMs: 10000, unixEndMs: 11000, outputFilename: 'x.m3u8' }] }] };
    await writeFile(join(bundle, 'recording/metadata.json'), JSON.stringify(meta));
    await writeFile(join(bundle, 'recording/x.m3u8'), '#EXTM3U\n#EXT-X-MAP:URI="http://evil.test/init.mp4"\nhttp://evil.test/chunk.m4s\n#EXT-X-ENDLIST\n');
    await assert.rejects(parseProject(bundle), /Caminho/iu);
    await writeFile(join(dir, 'secret.mp4'), 'outside'); await symlink(join(dir, 'secret.mp4'), join(bundle, 'recording/link.mp4'));
    meta.recorders[0].sessions[0].outputFilename = 'link.mp4'; await writeFile(join(bundle, 'recording/metadata.json'), JSON.stringify(meta));
    await assert.rejects(parseProject(bundle), /fora do pacote/iu);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('cancel waits for SIGTERM child closure before rejecting; temp manager cleans only owned data', async () => {
  const { dir } = await fixture();
  try {
    const controller = new AbortController(), marker = join(dir, 'closed');
    const promise = runProcess(process.execPath, ['-e', `const fs=require('fs');process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(marker)},'closed');process.exit(0)});console.log('ready');setInterval(()=>{},1000)`], {
      signal: controller.signal, onLine(line) { if (line === 'ready') controller.abort(); },
    });
    await assert.rejects(promise, /cancelado/iu); assert.equal(await readFile(marker, 'utf8'), 'closed');
    const manager = new TempManager(), owned = await manager.create(dir); await writeFile(join(owned, 'data'), 'temp'); await manager.dispose();
    assert.equal(await readFile(marker, 'utf8'), 'closed'); await assert.rejects(readdir(owned));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('incomplete package analyze fails clearly, cancellation is immediate', async () => {
  const { dir, bundle } = await fixture();
  try {
    await assert.rejects(analyzeProject(bundle), /metadata.json/iu);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(exportProject({ inputPath: bundle, outputPath: join(dir, 'output'), signal: controller.signal }), /cancelado/iu);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
