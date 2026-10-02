import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { MEDIA_KINDS, OUTPUT_FILE, type MediaKind } from './screenstudio.ts';

/** Output layout mandated by SPEC.md §4. */
export const SPEC_DIRS = { media: '01_MEDIA', davinci: '02_DAVINCI', data: '03_DATA', logs: 'logs' } as const;

export interface LocatedFile {
  path: string;
  /** false when found outside the SPEC location (e.g. output root). */
  specCompliant: boolean;
}

export interface OutputLayout {
  root: string;
  media: Partial<Record<MediaKind, LocatedFile>>;
  fcpxml: LocatedFile[];
  syncReport?: LocatedFile;
  manifest?: LocatedFile;
  exportLog?: LocatedFile;
  missingDirs: string[];
}

const exists = (p: string) => access(p).then(() => true, () => false);

async function locate(root: string, preferredDir: string, file: string): Promise<LocatedFile | undefined> {
  const preferred = path.join(root, preferredDir, file);
  if (await exists(preferred)) return { path: preferred, specCompliant: true };
  const fallback = path.join(root, file);
  if (await exists(fallback)) return { path: fallback, specCompliant: false };
  return undefined;
}

export async function locateOutput(root: string): Promise<OutputLayout> {
  const media: OutputLayout['media'] = {};
  for (const kind of MEDIA_KINDS) {
    const found = await locate(root, SPEC_DIRS.media, OUTPUT_FILE[kind]);
    if (found) media[kind] = found;
  }
  const fcpxml: LocatedFile[] = [];
  for (const [dir, compliant] of [[path.join(root, SPEC_DIRS.davinci), true], [root, false]] as const) {
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const n of names) if (/\.fcpxml$/i.test(n)) fcpxml.push({ path: path.join(dir, n), specCompliant: compliant });
  }
  const missingDirs: string[] = [];
  for (const d of Object.values(SPEC_DIRS)) if (!(await exists(path.join(root, d)))) missingDirs.push(d);
  return {
    root,
    media,
    fcpxml,
    syncReport: await locate(root, SPEC_DIRS.data, 'sync_report.json'),
    manifest: await locate(root, SPEC_DIRS.data, 'project_manifest.json'),
    exportLog: await locate(root, SPEC_DIRS.logs, 'export.log'),
    missingDirs,
  };
}

export async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T;
}
