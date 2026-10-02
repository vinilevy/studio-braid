import { createWriteStream } from 'node:fs';
import { mkdir, statfs } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyRequest } from 'fastify';
import { BridgeError, isWithin, locateBundle, safeRelativePath, TempManager, ZIP_LIMITS } from '@screen-studio-bridge/core';

interface Upload { inputPath: string; temp: TempManager; createdAt: number; leased: number }
export class UploadManager {
  private readonly uploads = new Map<string, Upload>();
  private readonly timer = setInterval(() => { void this.expire(); }, 60_000).unref();
  async receive(request: FastifyRequest): Promise<{ inputPath: string; outputPath?: string }> {
    if (this.uploads.size >= 5) throw new BridgeError('UPLOAD_LIMIT', 'Limite de 5 projetos temporários. Use o seletor nativo.', 429);
    const temp = new TempManager(), root = await temp.create(), seen = new Set<string>();
    let currentPath: string | undefined, outputPath: string | undefined, fileCount = 0, total = 0, zipPath: string | undefined;
    const available = await statfs(root, { bigint: true }).then(s => Number(s.bavail * s.bsize)).catch(() => ZIP_LIMITS.bytes);
    const abort = new AbortController(); const onAbort = () => abort.abort(); request.raw.once('aborted', onAbort);
    try {
      for await (const part of request.parts({ limits: { fileSize: ZIP_LIMITS.bytes, files: ZIP_LIMITS.entries, fields: ZIP_LIMITS.entries + 2, parts: ZIP_LIMITS.entries * 2 + 2, fieldSize: 16 * 1024 } })) {
        if (part.type === 'field') {
          if (part.fieldname === 'path') {
            if (currentPath) throw new BridgeError('UPLOAD_PATH_ORDER', 'Cada campo path precisa de um único arquivo file logo depois.');
            currentPath = safeRelativePath(String(part.value));
          } else if (part.fieldname === 'outputPath' && !currentPath) outputPath = String(part.value);
          else throw new BridgeError('UPLOAD_FIELD', 'Campo multipart inválido ou fora de ordem.');
          continue;
        }
        if (part.fieldname !== 'file' || !currentPath) { part.file.resume(); throw new BridgeError('UPLOAD_PATH_REQUIRED', 'Envie campo path relativo antes de cada file.'); }
        const path = currentPath; currentPath = undefined;
        const normalized = path.normalize('NFC').toLowerCase();
        if (seen.has(normalized)) throw new BridgeError('UPLOAD_DUPLICATE', 'Paths de upload duplicados.'); seen.add(normalized);
        fileCount++; const target = join(root, path); await mkdir(dirname(target), { recursive: true });
        const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
          total += chunk.length;
          callback(total > Math.min(ZIP_LIMITS.bytes, available - 64 * 1024 ** 2) ? new BridgeError('UPLOAD_SIZE', 'Upload excede limite ou espaço disponível.', 413) : null, chunk);
        } });
        await pipeline(part.file, meter, createWriteStream(target, { flags: 'wx', mode: 0o600 }), { signal: abort.signal });
        if (part.file.truncated) throw new BridgeError('UPLOAD_SIZE', 'Arquivo de upload excede limite.', 413);
        if (/\.zip$/iu.test(path)) {
          if (zipPath) throw new BridgeError('UPLOAD_LAYOUT', 'Envie um único ZIP ou a pasta, não ambos.'); zipPath = target;
        }
      }
      if (!fileCount || currentPath || (zipPath && fileCount !== 1)) throw new BridgeError('UPLOAD_LAYOUT', 'Upload incompleto ou ambíguo.');
      const inputPath = zipPath ?? await locateBundle(root);
      this.uploads.set(inputPath, { inputPath, temp, createdAt: Date.now(), leased: 0 });
      return { inputPath, outputPath };
    } catch (error) { await temp.dispose(); throw error; }
    finally { request.raw.removeListener('aborted', onAbort); }
  }
  lease(path: string): void { const upload = this.uploads.get(path); if (upload) upload.leased++; }
  async release(path: string): Promise<void> {
    const upload = this.uploads.get(path); if (!upload) return;
    upload.leased = Math.max(0, upload.leased - 1);
    if (!upload.leased) { this.uploads.delete(path); await upload.temp.dispose(); }
  }
  async discard(path: string): Promise<void> { const u = this.uploads.get(path); if (u && !u.leased) await this.release(path); }
  private async expire(): Promise<void> {
    for (const [path, u] of this.uploads) if (!u.leased && Date.now() - u.createdAt > 3600_000) await this.release(path);
  }
  async close(): Promise<void> { clearInterval(this.timer); for (const u of this.uploads.values()) await u.temp.dispose(); this.uploads.clear(); }
}
