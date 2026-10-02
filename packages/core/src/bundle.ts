import yauzl, { type Entry, type ZipFile } from 'yauzl';
import iconv from 'iconv-lite';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, stat, statfs } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { BridgeError, checkAbort } from './errors.js';
import { safeRelativePath } from './paths.js';
import { TempManager } from './temp.js';

export const ZIP_LIMITS = { entries: 50_000, bytes: 200 * 1024 ** 3 };
export async function extractZip(input: string, destination: string, signal?: AbortSignal): Promise<void> {
  checkAbort(signal);
  const zip = await new Promise<ZipFile>((ok, fail) => yauzl.open(input, { lazyEntries: true, autoClose: true, validateEntrySizes: true, decodeStrings: false }, (e, z) => e || !z ? fail(new BridgeError('INVALID_ZIP', 'Arquivo ZIP inválido.')) : ok(z)));
  const available = await statfs(destination, { bigint: true }).then(s => Number(s.bavail * s.bsize)).catch(() => Infinity);
  let total = 0, count = 0;
  const seen = new Set<string>();
  await new Promise<void>((ok, fail) => {
    let settled = false, active = false;
    const finish = (error?: unknown) => {
      if (settled) return; settled = true; signal?.removeEventListener('abort', abort);
      if (error) { zip.close(); fail(error); } else ok();
    };
    const abort = () => { zip.close(); if (!active) finish(new BridgeError('CANCELLED', 'Extração cancelada.', 409)); };
    signal?.addEventListener('abort', abort, { once: true });
    zip.on('error', error => finish(new BridgeError('INVALID_ZIP', error.message))); zip.on('end', () => finish());
    zip.on('entry', (entry: Entry) => { active = true; void (async () => {
      checkAbort(signal);
      if (++count > ZIP_LIMITS.entries) throw new BridgeError('ZIP_LIMIT', 'ZIP excede limite de arquivos.');
      const rawName = entry.fileName as unknown as Buffer;
      let decoded: string;
      try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(rawName); }
      catch {
        if (entry.generalPurposeBitFlag & 0x800) throw new BridgeError('INVALID_ZIP', 'Nome ZIP marcado como UTF-8 contém bytes inválidos.');
        decoded = iconv.decode(rawName, 'cp437');
      }
      const directory = decoded.endsWith('/');
      const name = safeRelativePath(directory ? decoded.slice(0, -1) : decoded);
      const normalized = name.normalize('NFC').toLowerCase();
      if (seen.has(normalized)) throw new BridgeError('ZIP_DUPLICATE', 'ZIP contém caminhos duplicados/ambíguos.');
      seen.add(normalized);
      const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
      if (mode === 0xa000 || (mode && mode !== 0x4000 && mode !== 0x8000))
        throw new BridgeError('ZIP_SYMLINK', 'Links e arquivos especiais não são permitidos no ZIP.');
      if (entry.generalPurposeBitFlag & 1) throw new BridgeError('ZIP_ENCRYPTED', 'ZIP criptografado não é suportado.');
      if (name.split('/').some(part => part === '__MACOSX' || part.startsWith('._')) || name.endsWith('/.DS_Store') || name === '.DS_Store') {
        active = false; checkAbort(signal); if (!settled) zip.readEntry(); return;
      }
      total += entry.uncompressedSize;
      if (!Number.isSafeInteger(total) || total > ZIP_LIMITS.bytes) throw new BridgeError('ZIP_LIMIT', 'ZIP excede 200 GiB descompactados.');
      if (total > available - 64 * 1024 ** 2) throw new BridgeError('INSUFFICIENT_SPACE', 'Espaço insuficiente para extrair o ZIP.', 409);
      const output = join(destination, name);
      if (directory) await mkdir(output, { recursive: true });
      else {
        await mkdir(dirname(output), { recursive: true });
        const stream = await new Promise<NodeJS.ReadableStream>((yes, no) => zip.openReadStream(entry, (e, s) => e || !s ? no(e) : yes(s)));
        let actual = 0;
        const meter = new Transform({ transform(chunk: Buffer, _enc, cb) {
          actual += chunk.length;
          cb(actual > entry.uncompressedSize ? new BridgeError('ZIP_LIMIT', 'Tamanho real do ZIP excede o declarado.') : null, chunk);
        } });
        await pipeline(stream, meter, createWriteStream(output, { flags: 'wx', mode: 0o600 }), { signal });
      }
      checkAbort(signal); active = false; if (!settled) zip.readEntry();
    })().catch(error => { active = false; finish(error); }); });
    if (signal?.aborted) abort(); else zip.readEntry();
  });
}

/** ZIP may contain one top-level bundle, or the bundle contents directly. No recursive guesses. */
export async function locateBundle(directory: string): Promise<string> {
  const exists = async (p: string) => stat(p).then(s => s.isFile()).catch(() => false);
  if (await exists(join(directory, 'recording', 'metadata.json'))) return directory;
  const entries = await readdir(directory, { withFileTypes: true });
  const candidates: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.endsWith('.screenstudio') && await exists(join(directory, entry.name, 'recording', 'metadata.json')))
      candidates.push(join(directory, entry.name));
  }
  if (candidates.length !== 1) throw new BridgeError('INVALID_BUNDLE', 'Esperado um único projeto .screenstudio com recording/metadata.json.');
  return candidates[0];
}
export async function prepareInput(inputPath: string, temp: TempManager, signal?: AbortSignal): Promise<string> {
  const input = resolve(inputPath);
  const info = await stat(input).catch(() => { throw new BridgeError('INPUT_NOT_FOUND', 'Projeto não encontrado.'); });
  if (info.isDirectory()) return locateBundle(input);
  if (!info.isFile() || !/\.zip$/iu.test(input)) throw new BridgeError('INVALID_INPUT', 'Informe uma pasta .screenstudio ou arquivo .zip.');
  const folder = await temp.create();
  await extractZip(input, folder, signal);
  return locateBundle(folder);
}
