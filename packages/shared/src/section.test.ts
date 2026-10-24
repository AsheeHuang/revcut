import { describe, expect, it } from 'vitest';
import { type Energy, suggestSection } from './section';

const HOP = 0.5;

function grid({ bpm, seconds, beatsPerBar = 4, offset = 0.3, jitter = 0, seed = 1 }: {
  bpm: number;
  seconds: number;
  beatsPerBar?: number;
  offset?: number;
  jitter?: number;
  seed?: number;
}) {
  let state = seed;
  const noise = () => {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    return (state / 2 ** 31 - 0.5) * 2 * jitter;
  };
  const beats: number[] = [];
  for (let t = offset; t < seconds; t += 60 / bpm) beats.push(Number((t + noise()).toFixed(3)));
  const downbeatIndices = beats.map((_, i) => i).filter((i) => i % beatsPerBar === 0);
  return { beats, downbeatIndices };
}

function energy(seconds: number, level: (t: number) => number): Energy {
  return { hopSec: HOP, values: Array.from({ length: Math.ceil(seconds / HOP) }, (_, i) => level(i * HOP)) };
}

const flat = (seconds: number) => energy(seconds, () => 0.5);

function section(result: ReturnType<typeof suggestSection>) {
  if (!result.ok) throw new Error(`expected a section, got ${result.error}`);
  return result.section;
}

describe('suggestSection', () => {
  const tempos = Array.from({ length: 241 }, (_, i) => 60 + i * 0.5);

  it.each(tempos)('at %s BPM picks whole bars of 20–25 s closest to 22.5 s, starting on a downbeat', (bpm) => {
    const { beats, downbeatIndices } = grid({ bpm, seconds: 180, jitter: 0.01, seed: bpm });
    const s = section(suggestSection(beats, downbeatIndices, flat(180)));
    const barSec = (4 * 60) / bpm;

    expect(downbeatIndices).toContain(s.startBeat);
    expect(s.beatsPerBar).toBe(4);
    expect(s.totalBeats).toBe(s.bars * 4);
    expect(s.startBeat + s.totalBeats).toBeLessThan(beats.length);
    expect(s.startSec).toBe(beats[s.startBeat]);
    expect(s.durationSec).toBeCloseTo(beats[s.startBeat + s.totalBeats]! - beats[s.startBeat]!, 9);
    expect(s.durationSec).toBeGreaterThanOrEqual(20);
    expect(s.durationSec).toBeLessThanOrEqual(25);
    for (const other of [s.bars - 1, s.bars + 1]) {
      const otherSec = other * barSec;
      if (otherSec >= 20 && otherSec <= 25) {
        expect(Math.abs(otherSec - 22.5)).toBeGreaterThanOrEqual(Math.abs(s.bars * barSec - 22.5) - 0.05);
      }
    }
  });

  it.each([60, 97, 133, 180])('at %s BPM in 3/4 counts three beats per bar', (bpm) => {
    const { beats, downbeatIndices } = grid({ bpm, seconds: 180, beatsPerBar: 3 });
    const s = section(suggestSection(beats, downbeatIndices, flat(180)));
    expect(s.beatsPerBar).toBe(3);
    expect(s.totalBeats).toBe(s.bars * 3);
    expect(s.durationSec).toBeGreaterThanOrEqual(20);
    expect(s.durationSec).toBeLessThanOrEqual(25);
  });

  it.each(tempos.filter((_, i) => i % 10 === 0))('at %s BPM starts inside the loud stretch', (bpm) => {
    const { beats, downbeatIndices } = grid({ bpm, seconds: 200 });
    const loud = energy(200, (t) => (t >= 100 && t < 140 ? 1 : 0.3));
    const s = section(suggestSection(beats, downbeatIndices, loud));
    expect(s.startSec).toBeGreaterThanOrEqual(100);
    expect(s.startSec + s.durationSec).toBeLessThanOrEqual(140);
  });

  it('prefers the louder of two loud stretches', () => {
    const { beats, downbeatIndices } = grid({ bpm: 120, seconds: 200 });
    const twoPeaks = energy(200, (t) => (t >= 20 && t < 50 ? 0.8 : t >= 120 && t < 150 ? 0.9 : 0.1));
    const s = section(suggestSection(beats, downbeatIndices, twoPeaks));
    expect(s.startSec).toBeGreaterThanOrEqual(120);
    expect(s.startSec + s.durationSec).toBeLessThanOrEqual(150);
  });

  it('takes the earliest section when the energy is flat', () => {
    const { beats, downbeatIndices } = grid({ bpm: 120, seconds: 120 });
    expect(section(suggestSection(beats, downbeatIndices, flat(120))).startBeat).toBe(0);
  });

  it('keeps four beats per bar when the tracker misses a downbeat', () => {
    const { beats, downbeatIndices } = grid({ bpm: 120, seconds: 120 });
    const s = section(suggestSection(beats, downbeatIndices.filter((i) => i !== 40), flat(120)));
    expect(s.beatsPerBar).toBe(4);
    expect(s.bars).toBe(11);
  });

  it('skips downbeats whose bars are not 20–25 s long when the tempo changes', () => {
    const fast = grid({ bpm: 230, seconds: 30, beatsPerBar: 6, offset: 0 });
    const slowStart = fast.beats.at(-1)! + 60 / 76;
    const slow = grid({ bpm: 76, seconds: 120, offset: slowStart });
    const beats = [...fast.beats, ...slow.beats];
    const downbeatIndices = [...fast.downbeatIndices, ...slow.downbeatIndices.map((i) => i + fast.beats.length)];
    const s = section(suggestSection(beats, downbeatIndices, flat(120)));
    expect(s.durationSec).toBeGreaterThanOrEqual(20);
    expect(s.durationSec).toBeLessThanOrEqual(25);
  });

  it('answers SONG_TOO_SHORT when no downbeat has a full section after it', () => {
    const { beats, downbeatIndices } = grid({ bpm: 120, seconds: 19 });
    expect(suggestSection(beats, downbeatIndices, flat(19))).toEqual({ ok: false, error: 'SONG_TOO_SHORT' });
  });

  it('answers NO_DOWNBEATS with fewer than two downbeats', () => {
    const { beats } = grid({ bpm: 120, seconds: 60 });
    expect(suggestSection(beats, [], flat(60))).toEqual({ ok: false, error: 'NO_DOWNBEATS' });
    expect(suggestSection(beats, [4], flat(60))).toEqual({ ok: false, error: 'NO_DOWNBEATS' });
  });
});
