import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Owns only directories it created. Never registers a user supplied path for deletion. */
export class TempManager {
  private readonly owned = new Set<string>();
  async create(parent = tmpdir(), prefix = 'screen-studio-bridge-'): Promise<string> {
    const path = await mkdtemp(join(parent, prefix)); this.owned.add(path); return path;
  }
  async dispose(): Promise<void> {
    for (const path of [...this.owned]) {
      await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
      this.owned.delete(path);
    }
  }
}
