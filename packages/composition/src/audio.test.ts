import { describe, expect, it } from 'vitest';
import { edgeFade, tailFade } from './audio';

describe('edgeFade', () => {
  it('ramps 0.05 s in and out at 30 fps, silent on the cut frames', () => {
    const gains = Array.from({ length: 10 }, (_, frame) => edgeFade(frame, 10, 0.05));
    expect(gains.map((g) => Number(g.toFixed(3)))).toEqual([0, 0.667, 1, 1, 1, 1, 1, 1, 0.667, 0]);
  });
});

describe('tailFade', () => {
  it('fades the last 1.5 s linearly to silence on the last frame', () => {
    expect(tailFade(0, 600, 1.5)).toBe(1);
    expect(tailFade(554, 600, 1.5)).toBe(1);
    expect(tailFade(576.5, 600, 1.5)).toBeCloseTo(0.5, 9);
    expect(tailFade(599, 600, 1.5)).toBe(0);
  });

  it('leaves the mix alone with no fade', () => {
    expect(tailFade(599, 600, 0)).toBe(1);
  });
});
