/**
 * Minimal ISO-BMFF patcher used by the mock generator to reproduce Apple's HLS layout:
 * fragments whose decode time starts at the host clock (e.g. 24539.17s) with no edit list.
 * FFmpeg's fMP4 muxer always rebases the first DTS to 0 when edit lists are disabled, so the
 * host offset is added afterwards to every `tfdt` (and `sidx`, when present).
 */
import { readFile, writeFile } from 'node:fs/promises';

const CONTAINERS = new Set(['moof', 'traf', 'moov', 'trak', 'mdia', 'minf', 'stbl', 'mvex', 'edts', 'dinf']);

function walk(buf: Buffer, start: number, end: number, visit: (type: string, pos: number, header: number, size: number) => void): void {
  let pos = start;
  while (pos + 8 <= end) {
    let size = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    let header = 8;
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(pos + 8));
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < header || pos + size > end) throw new Error(`Caixa ${type} corrompida em ${pos}`);
    visit(type, pos, header, size);
    if (CONTAINERS.has(type)) walk(buf, pos + header, pos + size, visit);
    pos += size;
  }
}

/** Adds `ticks` (track timescale units) to every tfdt/sidx timestamp. Returns how many boxes changed. */
export function shiftFragmentTimes(buf: Buffer, ticks: bigint): number {
  let patched = 0;
  walk(buf, 0, buf.length, (type, pos, header) => {
    const body = pos + header;
    const version = buf.readUInt8(body);
    if (type === 'tfdt') {
      if (version === 1) buf.writeBigUInt64BE(buf.readBigUInt64BE(body + 4) + ticks, body + 4);
      else {
        const v = BigInt(buf.readUInt32BE(body + 4)) + ticks;
        if (v > 0xffffffffn) throw new Error('tfdt v0 estoura 32 bits; use timescale menor');
        buf.writeUInt32BE(Number(v), body + 4);
      }
      patched++;
    } else if (type === 'sidx') {
      // version(1) flags(3) reference_ID(4) timescale(4) earliest_presentation_time(4|8)
      const ept = body + 12;
      if (version === 1) buf.writeBigUInt64BE(buf.readBigUInt64BE(ept) + ticks, ept);
      else buf.writeUInt32BE(Number(BigInt(buf.readUInt32BE(ept)) + ticks), ept);
      patched++;
    }
  });
  return patched;
}

export async function shiftFragmentFile(file: string, ticks: bigint): Promise<number> {
  const buf = await readFile(file);
  const n = shiftFragmentTimes(buf, ticks);
  if (n > 0) await writeFile(file, buf);
  return n;
}

/** Reads the media timescale of the first track (mdhd) from an init segment. */
export async function initTimescale(file: string): Promise<number> {
  const buf = await readFile(file);
  let timescale = 0;
  walk(buf, 0, buf.length, (type, pos, header) => {
    if (type !== 'mdhd' || timescale) return;
    const body = pos + header;
    const version = buf.readUInt8(body);
    timescale = buf.readUInt32BE(body + (version === 1 ? 20 : 12));
  });
  if (!timescale) throw new Error(`mdhd não encontrado em ${file}`);
  return timescale;
}

/** True when the init segment carries an edit list (Apple's HLS init segments do not). */
export async function hasEditList(file: string): Promise<boolean> {
  const buf = await readFile(file);
  let found = false;
  walk(buf, 0, buf.length, (type) => {
    if (type === 'elst') found = true;
  });
  return found;
}
