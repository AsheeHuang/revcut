import { describe, expect, it } from 'vitest';
import { computeTiming, framesToSec, sliceWindow } from './timing';

const HALF_FRAME = 1 / 60;

function beatGrid(bpm: number, count: number, offset = 0.37) {
  return Array.from({ length: count }, (_, i) => offset + (i * 60) / bpm);
}

describe('computeTiming', () => {
  it('keeps every one of 100 cuts within half a frame of its beat, with no drift', () => {
    const beats = beatGrid(123.71, 400);
    const startBeat = 8;
    const clips = Array.from({ length: 100 }, (_, i) => ({ beats: 1 + ((i * 7) % 4) }));
    const timing = computeTiming(beats, startBeat, clips)!;

    let beat = startBeat;
    let expectedStart = 0;
    timing.clips.forEach((clip, k) => {
      expect(clip.startFrame).toBe(expectedStart);
      const songSec = (timing.f0 + clip.startFrame) / 30;
      expect(Math.abs(songSec - beats[beat]!)).toBeLessThanOrEqual(HALF_FRAME);
      beat += clips[k]!.beats;
      expectedStart += clip.frames;
    });
    expect(timing.totalFrames).toBe(expectedStart);
    expect(Math.abs((timing.f0 + timing.totalFrames) / 30 - beats[beat]!)).toBeLessThanOrEqual(HALF_FRAME);
  });

  it('starts the music on the frame of the start beat and the first clip at frame 0', () => {
    const beats = [0.46, 0.94, 1.42, 1.9, 2.38];
    const timing = computeTiming(beats, 1, [{ beats: 2 }, { beats: 1 }])!;
    expect(timing.f0).toBe(28);
    expect(timing.clips).toEqual([
      { startFrame: 0, frames: 29 },
      { startFrame: 29, frames: 14 },
    ]);
    expect(timing.totalFrames).toBe(43);
  });

  it('answers null when the clips run past the last beat', () => {
    const beats = [0.5, 1, 1.5, 2];
    expect(computeTiming(beats, 1, [{ beats: 2 }])).not.toBeNull();
    expect(computeTiming(beats, 1, [{ beats: 2 }, { beats: 1 }])).toBeNull();
    expect(computeTiming(beats, 4, [{ beats: 1 }])).toBeNull();
  });

  it('turns frames into seconds at 30 fps', () => {
    expect(framesToSec(45)).toBe(1.5);
  });
});

describe('sliceWindow', () => {
  it('starts the slice at 0 when the clip starts at 0', () => {
    expect(sliceWindow(0, 1.5, 10)).toEqual({ startSec: 0, endSec: 2, startFromSec: 0 });
  });

  it('keeps less than 0.5 s of lead when the clip starts 0.2 s in', () => {
    const window = sliceWindow(0.2, 1.5, 10);
    expect(window.startSec).toBe(0);
    expect(window.startFromSec).toBeCloseTo(0.2, 9);
    expect(window.endSec).toBeCloseTo(2.2, 9);
  });

  it('pads half a second on both sides in the middle of a video', () => {
    const window = sliceWindow(3, 1.5, 10);
    expect(window.startSec).toBeCloseTo(2.5, 9);
    expect(window.startFromSec).toBeCloseTo(0.5, 9);
    expect(window.endSec).toBeCloseTo(5, 9);
  });

  it('stops at the end of a video when the clip ends near it', () => {
    const window = sliceWindow(4.4, 1.5, 6);
    expect(window.startSec).toBeCloseTo(3.9, 9);
    expect(window.startFromSec).toBeCloseTo(0.5, 9);
    expect(window.endSec).toBe(6);
  });
});
