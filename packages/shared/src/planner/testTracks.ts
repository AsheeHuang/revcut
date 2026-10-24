import type { PlannerTrack } from './types';

let next = 0;
export const uuid = () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`;

// beat_this reports beats on a 20 ms grid.
export function beatTrack(bpm: number, seconds = 200, id = uuid()): PlannerTrack {
  const beats: number[] = [];
  for (let i = 0; 0.3 + (i * 60) / bpm < seconds; i++) beats.push(Math.round((0.3 + (i * 60) / bpm) * 50) / 50);
  return {
    id,
    beats,
    downbeatIndices: beats.map((_, i) => i).filter((i) => i % 4 === 0),
    energy: { hopSec: 0.5, values: Array(Math.ceil(seconds * 2)).fill(0.5) },
  };
}
