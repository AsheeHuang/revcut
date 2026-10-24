import { describe, expect, it } from 'vitest';
import { buildClip } from './buildClip';

const ID = '00000000-0000-4000-8000-000000000001';
const video = { id: '00000000-0000-4000-8000-0000000000aa', kind: 'video', capturedAt: '2026-01-08T23:31:36+08:00', durationSec: 6 } as const;
const photo = { ...video, kind: 'photo', durationSec: null } as const;
const moment = (t: number) => ({ t, score: 7, focusX: 0.3, focusY: 0.6 });

describe('buildClip', () => {
  it('centers a video clip on its moment', () => {
    const clip = buildClip({ id: ID, media: video, moment: moment(3), beats: 2, clipSec: 1 });
    expect(clip).toEqual({
      id: ID,
      mediaId: video.id,
      beats: 2,
      sourceInSec: 2.5,
      crop: { focusX: 0.3, focusY: 0.6, zoom: 1 },
      kenBurns: null,
      date: '2026.01.08',
      originalVolume: 0.35,
    });
  });

  it('keeps a video clip inside the video near either end', () => {
    expect(buildClip({ id: ID, media: video, moment: moment(0.2), beats: 4, clipSec: 2 }).sourceInSec).toBe(0);
    expect(buildClip({ id: ID, media: video, moment: moment(5.9), beats: 4, clipSec: 2 }).sourceInSec).toBe(4);
  });

  it('starts a video clip on a whole frame, never later than the moment allows', () => {
    const { sourceInSec } = buildClip({ id: ID, media: video, moment: moment(1.2345), beats: 2, clipSec: 29 / 30 });
    expect(sourceInSec * 30).toBeCloseTo(Math.round(sourceInSec * 30), 9);
    expect(sourceInSec).toBeLessThanOrEqual(1.2345 - 29 / 60);
    expect(sourceInSec).toBeGreaterThan(1.2345 - 29 / 60 - 1 / 30);
  });

  it('zooms a photo slowly and starts it at 0', () => {
    const clip = buildClip({ id: ID, media: photo, moment: moment(0), beats: 2, clipSec: 1 });
    expect(clip).toMatchObject({ sourceInSec: 0, kenBurns: { endZoom: 1.08 }, crop: { zoom: 1 } });
  });

  it('shows the local capture date, or nothing when it is unknown', () => {
    expect(buildClip({ id: ID, media: { ...photo, capturedAt: null }, moment: moment(0), beats: 2, clipSec: 1 }).date).toBeNull();
  });
});
