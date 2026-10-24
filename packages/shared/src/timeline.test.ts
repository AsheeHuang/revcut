import { describe, expect, it } from 'vitest';
import { Timeline } from './timeline';

const clip = {
  id: '6f1d3c1e-8b4a-4c55-9a0e-1d2f3a4b5c6d',
  mediaId: '0b6a1f2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b',
  beats: 2,
  sourceInSec: 1.5,
  crop: { focusX: 0.5, focusY: 0.4, zoom: 1 },
  kenBurns: null,
  date: '2026.01.08',
  originalVolume: 0.35,
};

const timeline = {
  schemaVersion: 1,
  music: { trackId: '2265ce80-9035-4afb-9b6d-49ebf99f9f09', startBeat: 8, volume: 1, fadeOutSec: 1.5 },
  overlayEnabled: true,
  clips: [clip, { ...clip, id: '7a2e4d2f-9c5b-4d66-8b1f-2e3a4b5c6d7e', kenBurns: { endZoom: 1.08 }, date: null }],
};

describe('Timeline', () => {
  it('accepts the SPEC §3.2 shape', () => {
    expect(Timeline.parse(timeline)).toEqual(timeline);
  });

  it.each([
    ['a clip of zero beats', { clips: [{ ...clip, beats: 0 }] }],
    ['a fractional beat count', { clips: [{ ...clip, beats: 1.5 }] }],
    ['a negative in-point', { clips: [{ ...clip, sourceInSec: -0.1 }] }],
    ['a focus outside the frame', { clips: [{ ...clip, crop: { ...clip.crop, focusX: 1.2 } }] }],
    ['a zoom below cover', { clips: [{ ...clip, crop: { ...clip.crop, zoom: 0.9 } }] }],
    ['a zoom past 3', { clips: [{ ...clip, kenBurns: { endZoom: 3.5 } }] }],
    ['an original volume above 1', { clips: [{ ...clip, originalVolume: 1.2 }] }],
    ['no clips', { clips: [] }],
    ['a fade longer than 5 s', { music: { ...timeline.music, fadeOutSec: 6 } }],
    ['a fractional start beat', { music: { ...timeline.music, startBeat: 2.5 } }],
    ['another schema version', { schemaVersion: 2 }],
  ])('rejects %s', (_, patch) => {
    expect(Timeline.safeParse({ ...timeline, ...patch }).success).toBe(false);
  });
});
