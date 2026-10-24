import { z } from 'zod';
import { TARGET_MAX_SEC, TARGET_MIN_SEC, TARGET_SEC } from './constants';

export const ENERGY_HOP_SEC = 0.5;

export const Energy = z.object({ hopSec: z.literal(ENERGY_HOP_SEC), values: z.array(z.number()) });
export type Energy = z.infer<typeof Energy>;

export const SuggestedSection = z.object({
  startBeat: z.number().int(),
  bars: z.number().int(),
  beatsPerBar: z.number().int(),
  totalBeats: z.number().int(),
  startSec: z.number(),
  durationSec: z.number(),
});
export type SuggestedSection = z.infer<typeof SuggestedSection>;

export const SECTION_ERROR_MESSAGES = {
  NO_DOWNBEATS: '偵測不到重拍',
  SONG_TOO_SHORT: `歌曲太短，湊不出 ${TARGET_MIN_SEC} 秒`,
} as const;
export type SectionError = keyof typeof SECTION_ERROR_MESSAGES;

export type SectionResult = { ok: true; section: SuggestedSection } | { ok: false; error: SectionError };

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function mode(values: number[]): number {
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].reduce((best, entry) => (entry[1] > best[1] || (entry[1] === best[1] && entry[0] < best[0]) ? entry : best))[0];
}

function barCount(barSec: number): number {
  const fits: number[] = [];
  for (let bars = Math.max(1, Math.ceil(TARGET_MIN_SEC / barSec)); bars * barSec <= TARGET_MAX_SEC; bars++) fits.push(bars);
  const offTarget = (bars: number) => Math.abs(bars * barSec - TARGET_SEC);
  return fits.reduce((best, bars) => (offTarget(bars) < offTarget(best) ? bars : best), fits[0] ?? 1);
}

function meanEnergy({ hopSec, values }: Energy, fromSec: number, toSec: number): number {
  const window = values.slice(Math.floor(fromSec / hopSec), Math.ceil(toSec / hopSec));
  return window.length === 0 ? 0 : window.reduce((sum, v) => sum + v, 0) / window.length;
}

// SPEC §8.2 step 1. A candidate must also really last 20–25 s: the tracker can follow
// part of a song at double or triple time, where T beats would be far shorter.
export function suggestSection(beats: number[], downbeatIndices: number[], energy: Energy): SectionResult {
  if (downbeatIndices.length < 2) return { ok: false, error: 'NO_DOWNBEATS' };
  const pairs = downbeatIndices.slice(1).map((index, i) => [downbeatIndices[i]!, index] as const);
  const beatsPerBar = mode(pairs.map(([a, b]) => b - a));
  const bars = barCount(median(pairs.map(([a, b]) => beats[b]! - beats[a]!)));
  const totalBeats = bars * beatsPerBar;

  let best: { startBeat: number; energy: number } | null = null;
  for (const startBeat of downbeatIndices) {
    const end = beats[startBeat + totalBeats];
    if (end === undefined) continue;
    const durationSec = end - beats[startBeat]!;
    if (durationSec < TARGET_MIN_SEC || durationSec > TARGET_MAX_SEC) continue;
    const mean = meanEnergy(energy, beats[startBeat]!, end);
    if (!best || mean > best.energy) best = { startBeat, energy: mean };
  }
  if (!best) return { ok: false, error: 'SONG_TOO_SHORT' };

  const startSec = beats[best.startBeat]!;
  return {
    ok: true,
    section: {
      startBeat: best.startBeat,
      bars,
      beatsPerBar,
      totalBeats,
      startSec,
      durationSec: beats[best.startBeat + totalBeats]! - startSec,
    },
  };
}
