export type BeatSlot = { beats: number; score: number; maxBeats: number };

function first(indices: number[], compare: (a: number, b: number) => number): number | undefined {
  return indices.sort(compare)[0];
}

// SPEC §8.2 step 5. Surplus beats go one at a time to the best clip with room, and missing
// beats come from the worst clip above the minimum; equal scores take turns so lengths stay even.
// Null when the total cannot be reached inside every slot's limits.
export function allocateBeats(slots: readonly BeatSlot[], totalBeats: number, minBeats: number): number[] | null {
  const beats = slots.map((slot) => Math.min(Math.max(slot.beats, minBeats), slot.maxBeats));
  const indices = slots.map((_, i) => i);
  let diff = totalBeats - beats.reduce((sum, b) => sum + b, 0);
  while (diff !== 0) {
    const k =
      diff > 0
        ? first(
            indices.filter((i) => beats[i]! < slots[i]!.maxBeats),
            (a, b) => slots[b]!.score - slots[a]!.score || beats[a]! - beats[b]! || a - b,
          )
        : first(
            indices.filter((i) => beats[i]! > minBeats),
            (a, b) => slots[a]!.score - slots[b]!.score || beats[b]! - beats[a]! || b - a,
          );
    if (k === undefined) return null;
    beats[k]! += Math.sign(diff);
    diff -= Math.sign(diff);
  }
  return beats;
}
