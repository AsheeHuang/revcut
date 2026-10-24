import { describe, expect, it } from 'vitest';
import { allocateBeats } from './allocateBeats';

const slot = (score: number, beats = 2, maxBeats = 4) => ({ beats, score, maxBeats });

describe('allocateBeats', () => {
  it('gives surplus beats to the highest score first, up to its limit', () => {
    expect(allocateBeats([slot(3), slot(9), slot(6)], 10, 2)).toEqual([2, 4, 4]);
  });

  it('takes missing beats from the lowest score first, down to the minimum', () => {
    expect(allocateBeats([slot(3, 3), slot(9, 3), slot(6, 3)], 7, 2)).toEqual([2, 3, 2]);
  });

  it('spreads beats evenly across equal scores', () => {
    expect(allocateBeats([slot(5), slot(5), slot(5), slot(5)], 13, 2)).toEqual([4, 3, 3, 3]);
    expect(allocateBeats([slot(5, 4), slot(5, 4), slot(5, 4)], 9, 2)).toEqual([3, 3, 3]);
  });

  it('never gives a slot more than its own limit', () => {
    expect(allocateBeats([slot(9, 2, 3), slot(1)], 7, 2)).toEqual([3, 4]);
  });

  it('starts a slot inside its limits', () => {
    expect(allocateBeats([slot(5, 2, 1), slot(5, 0)], 3, 1)).toEqual([1, 2]);
  });

  it('answers null when the total is out of reach', () => {
    expect(allocateBeats([slot(5), slot(5)], 9, 2)).toBeNull();
    expect(allocateBeats([slot(5), slot(5)], 3, 2)).toBeNull();
  });
});
