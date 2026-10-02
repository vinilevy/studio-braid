/**
 * Frame-level reconciliation between source session packets and the exported stream.
 *
 * For every session k, a source frame presented at p (seconds) must appear in the export at
 *   (p − p0_k) + timelineStart_k
 * where p0_k is the first presented frame of that session. With packet copy (no re-encode) the
 * match is exact to the tick, which proves "original frames preserved, at the right place".
 *
 * Caveat handled here: when the export is denser than the source (CFR re-encode duplicates
 * frames), nearest-neighbour matching always succeeds and proves nothing — such sessions are
 * reported as not reconcilable instead of passing silently.
 */

export interface SessionSource {
  index: number;
  timelineStartMs: number;
  durationMs: number;
  /** Source packet presentation times in seconds (any order). */
  sourcePtsSec: number[];
}

export interface SessionReconciliation {
  index: number;
  timelineStartMs: number;
  sourcePackets: number;
  inWindowPackets: number;
  /** Source frames presented at or after durationMs (legitimately trimmable tail). */
  tailPackets: number;
  outputPacketsInWindow: number;
  exactMatched: number;
  exactRatio: number;
  /** Most frequent (output − expected) offset; undefined when not determinable. */
  bestOffsetMs?: number;
  bestOffsetRatio?: number;
  reconcilable: boolean;
  /** Whole-frame shifts on a regular (CFR-like) grid cannot be told apart by timestamps. */
  ambiguous?: boolean;
  /** Non-exact frames that sit in the last second of the session (tail retiming). */
  nonExactInLastSecond?: number;
  note?: string;
}

const lowerBound = (arr: number[], x: number): number => {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((arr[mid] as number) < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

export function reconcile(outputPtsSec: number[], sessions: SessionSource[], exactTolMs = 1.0): SessionReconciliation[] {
  const out = outputPtsSec.filter(Number.isFinite).sort((a, b) => a - b);
  const base = out[0] ?? 0;
  const outMs = out.map((t) => (t - base) * 1000);

  return sessions.map((s) => {
    const src = s.sourcePtsSec.filter(Number.isFinite).sort((a, b) => a - b);
    const p0 = src[0] ?? 0;
    const rel = src.map((p) => (p - p0) * 1000);
    const inWindow = rel.filter((r) => r < s.durationMs - 0.5);
    const expected = inWindow.map((r) => r + s.timelineStartMs);
    const winStart = s.timelineStartMs;
    const winEnd = s.timelineStartMs + s.durationMs;
    const outputInWindow = lowerBound(outMs, winEnd) - lowerBound(outMs, winStart);

    let exact = 0;
    let nonExactLastSecond = 0;
    for (const e of expected) {
      const i = lowerBound(outMs, e - exactTolMs);
      if (i < outMs.length && Math.abs((outMs[i] as number) - e) <= exactTolMs) exact++;
      else if (e >= winEnd - 1000) nonExactLastSecond++;
    }
    const result: SessionReconciliation = {
      index: s.index,
      timelineStartMs: s.timelineStartMs,
      sourcePackets: src.length,
      inWindowPackets: inWindow.length,
      tailPackets: src.length - inWindow.length,
      outputPacketsInWindow: outputInWindow,
      exactMatched: exact,
      exactRatio: inWindow.length ? exact / inWindow.length : 1,
      reconcilable: false,
    };

    if (inWindow.length === 0) {
      result.note = 'sessão sem frames na fonte';
      return result;
    }
    // Dense export (≥ 1.5× the source frames in the same window) ⇒ timestamp matching is meaningless.
    if (outputInWindow > inWindow.length * 1.5) {
      result.note = `saída densificada (${outputInWindow} frames vs ${inWindow.length} na fonte): posição só verificável por marcadores de conteúdo`;
      return result;
    }
    result.reconcilable = true;
    result.nonExactInLastSecond = nonExactLastSecond;
    if (result.exactRatio >= 0.5) {
      // Most frames sit exactly where they belong: the session is in place.
      result.bestOffsetMs = 0;
      result.bestOffsetRatio = result.exactRatio;
      const nonExact = inWindow.length - exact;
      if (nonExact > 0) {
        result.note =
          nonExact === nonExactLastSecond
            ? `${nonExact} frame(s) retemporizado(s), todos no último 1 s da sessão`
            : `${nonExact} frame(s) fora da posição exata (${nonExactLastSecond} no último 1 s)`;
      }
      return result;
    }
    // Is the source on a regular grid? Then whole-frame shifts are indistinguishable by timestamps.
    const gaps = rel.slice(1).map((r, i) => r - (rel[i] as number)).sort((a, b) => a - b);
    const medianGap = gaps[Math.floor(gaps.length / 2)] ?? 0;
    const irregular = gaps.filter((g) => Math.abs(g - medianGap) > medianGap * 0.1).length / Math.max(1, gaps.length);

    // Estimate a session-wide shift: histogram of (output − expected) within ±2s, 1ms bins.
    const step = Math.max(1, Math.floor(expected.length / 2000));
    const hist = new Map<number, number>();
    for (let k = 0; k < expected.length; k += step) {
      const e = expected[k] as number;
      for (let i = lowerBound(outMs, e - 2000); i < outMs.length && (outMs[i] as number) <= e + 2000; i++) {
        const bin = Math.round((outMs[i] as number) - e);
        hist.set(bin, (hist.get(bin) ?? 0) + 1);
      }
    }
    let bestBin = 0;
    let bestCount = -1;
    for (const [bin, count] of hist) {
      if (count > bestCount || (count === bestCount && Math.abs(bin) < Math.abs(bestBin))) {
        bestBin = bin;
        bestCount = count;
      }
    }
    let atBest = 0;
    for (const e of expected) {
      const target = e + bestBin;
      const i = lowerBound(outMs, target - 1);
      if (i < outMs.length && Math.abs((outMs[i] as number) - target) <= 1) atBest++;
    }
    result.bestOffsetMs = bestBin;
    result.bestOffsetRatio = atBest / expected.length;
    const wholeFrames = medianGap > 0 ? bestBin / medianGap : 0;
    if (irregular < 0.05 && Math.abs(wholeFrames - Math.round(wholeFrames)) < 0.1) {
      result.ambiguous = true;
      result.note = `deslocamento ${Math.round(wholeFrames)} frame(s) ambíguo em grade regular — só marcadores de conteúdo decidem`;
    } else if (result.bestOffsetRatio < 0.5) {
      result.note = 'frames não reconciliáveis por timestamp (provável recompressão com retemporização)';
    }
    return result;
  });
}
