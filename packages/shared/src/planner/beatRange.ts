import { CLIP_MAX_SEC, CLIP_MIN_SEC } from '../constants';
import type { MediaKind } from '../status';
import { computeTiming, framesToSec } from '../timing';

export type BeatRange = {
  beatSec: number;
  minBeats: number;
  maxBeats: number;
  baseBeats: number;
  capFor: (media: { kind: MediaKind; durationSec: number | null }) => number;
};

const DURATION_TOLERANCE_SEC = 1e-4;

// SPEC §8.2 step 2. The beat length is the section's mean, because beat_this rounds beats to
// 20 ms and the median gap can be 10 ms off. A video's cap is the most beats whose longest span
// anywhere in the section still fits it; below minBeats it cannot be used at all.
export function beatRange(beats: readonly number[], startBeat: number, totalBeats: number): BeatRange {
  const beatSec = (beats[startBeat + totalBeats]! - beats[startBeat]!) / totalBeats;
  const minBeats = Math.ceil(CLIP_MIN_SEC / beatSec - 1e-9);
  const maxBeats = Math.max(minBeats, Math.floor(CLIP_MAX_SEC / beatSec + 1e-9));
  let baseBeats = minBeats;
  for (let b = minBeats; b <= maxBeats; b++) if (Math.abs(b * beatSec - 1) < Math.abs(baseBeats * beatSec - 1)) baseBeats = b;

  const longestSec = new Map<number, number>();
  for (let b = minBeats; b <= maxBeats; b++) {
    let frames = 0;
    for (let j = startBeat; j + b <= startBeat + totalBeats; j++) {
      frames = Math.max(frames, computeTiming(beats, j, [{ beats: b }])!.totalFrames);
    }
    longestSec.set(b, framesToSec(frames));
  }

  return {
    beatSec,
    minBeats,
    maxBeats,
    baseBeats,
    capFor: (media) => {
      if (media.kind === 'photo') return maxBeats;
      let cap = minBeats - 1;
      for (let b = minBeats; b <= maxBeats; b++) {
        if (longestSec.get(b)! <= (media.durationSec ?? 0) + DURATION_TOLERANCE_SEC) cap = b;
      }
      return cap;
    },
  };
}
