import { describe, expect, it } from 'vitest';
import { type AnalysisResult, buildItems, buildParts, resolveVerdicts } from './contract';

const ID = {
  clip: '11111111-1111-4111-8111-111111111111',
  photo: '22222222-2222-4222-8222-222222222222',
  undated: '33333333-3333-4333-8333-333333333333',
};

const clip = { id: ID.clip, kind: 'video' as const, durationSec: 6, capturedAt: '2026-01-31T16:56:41+08:00' };
const photo = { id: ID.photo, kind: 'photo' as const, durationSec: null, capturedAt: '2026-01-18T20:07:19+08:00' };
const undated = { id: ID.undated, kind: 'photo' as const, durationSec: null, capturedAt: null };

const frame = (t: number) => ({ t, label: `frame@${t}` });

describe('buildItems', () => {
  it('orders media by capture time, undated last, and names them m1, m2, …', () => {
    const items = buildItems([undated, clip, photo], (media) => (media.kind === 'video' ? [frame(1), frame(3)] : [frame(0)]));
    expect(items.map((item) => [item.ref, item.mediaId])).toEqual([
      ['m1', ID.photo],
      ['m2', ID.clip],
      ['m3', ID.undated],
    ]);
    expect(items[1]!.frames).toEqual([frame(1), frame(3)]);
  });
});

describe('buildParts', () => {
  it('heads each media with its ref, labels every video frame before its image, and ends with the task', () => {
    const items = buildItems([clip, photo], (media) => (media.kind === 'video' ? [frame(1.5), frame(4.5)] : [frame(0)]));
    const parts = buildParts(items);
    expect(parts.slice(0, -1)).toEqual([
      { type: 'text', text: '素材 m1｜照片｜2026-01-18 20:07' },
      { type: 'image', frame: frame(0) },
      { type: 'text', text: '素材 m2｜影片｜6.0 秒｜2026-01-31 16:56' },
      { type: 'text', text: 't=1.5s' },
      { type: 'image', frame: frame(1.5) },
      { type: 'text', text: 't=4.5s' },
      { type: 'image', frame: frame(4.5) },
    ]);
    const task = parts.at(-1)!;
    expect(task.type).toBe('text');
    expect(task.type === 'text' && task.text).toMatch(/2026-01-18 到 2026-01-31.*2 個素材/s);
  });

  it('says when a capture time is unknown', () => {
    const parts = buildParts(buildItems([undated], () => [frame(0)]));
    expect(parts[0]).toEqual({ type: 'text', text: '素材 m1｜照片｜拍攝時間不明' });
  });
});

describe('resolveVerdicts', () => {
  const items = buildItems([clip, photo, undated], () => []);
  const verdict = (ref: string, extra: Partial<AnalysisResult['media'][number]> = {}) => ({
    ref,
    usable: true,
    score: 7,
    description: '海邊散步',
    moments: [{ t: 2, score: 8, focusX: 0.4, focusY: 0.6 }],
    duplicateOf: null,
    ...extra,
  });

  it('maps refs back to media ids and keeps in-range values as they are', () => {
    const analyses = resolveVerdicts({ media: [verdict('m2'), verdict('m1', { moments: [{ t: 0, score: 6, focusX: 0.5, focusY: 0.3 }] })] }, items);
    expect(analyses.get(ID.clip)).toEqual({
      usable: true,
      score: 7,
      description: '海邊散步',
      moments: [{ t: 2, score: 8, focusX: 0.4, focusY: 0.6 }],
      duplicateOf: null,
    });
    expect(analyses.get(ID.photo)!.moments).toEqual([{ t: 0, score: 6, focusX: 0.5, focusY: 0.3 }]);
  });

  it('clamps scores, moment times and focus points into range', () => {
    const analyses = resolveVerdicts(
      {
        media: [
          verdict('m2', {
            score: 14,
            moments: [
              { t: 9.5, score: 0, focusX: -0.2, focusY: 1.7 },
              { t: -1, score: 8, focusX: 0.5, focusY: 0.5 },
            ],
          }),
          verdict('m1', { score: -3, moments: [{ t: 3, score: 5, focusX: 0.5, focusY: 0.5 }] }),
        ],
      },
      items,
    );
    expect(analyses.get(ID.clip)).toMatchObject({
      score: 10,
      moments: [
        { t: 0, score: 8, focusX: 0.5, focusY: 0.5 },
        { t: 6, score: 1, focusX: 0, focusY: 1 },
      ],
    });
    expect(analyses.get(ID.photo)).toMatchObject({ score: 1, moments: [{ t: 0, score: 5, focusX: 0.5, focusY: 0.5 }] });
  });

  it('keeps the best three moments of a video and the best one of a photo', () => {
    const moment = (t: number, score: number) => ({ t, score, focusX: 0.5, focusY: 0.5 });
    const analyses = resolveVerdicts(
      {
        media: [
          verdict('m2', { moments: [moment(1, 4), moment(2, 9), moment(3, 6), moment(4, 8)] }),
          verdict('m1', { moments: [moment(0, 3), moment(0, 9)] }),
        ],
      },
      items,
    );
    expect(analyses.get(ID.clip)!.moments.map((m) => m.t)).toEqual([2, 4, 3]);
    expect(analyses.get(ID.photo)!.moments).toEqual([moment(0, 9)]);
  });

  it('gives a media the model left out a usable middle-of-frame default', () => {
    const analyses = resolveVerdicts({ media: [verdict('m1')] }, items);
    expect(analyses.get(ID.clip)).toEqual({
      usable: true,
      score: 5,
      description: 'AI 沒有回傳這個素材的分析',
      moments: [{ t: 3, score: 5, focusX: 0.5, focusY: 0.5 }],
      duplicateOf: null,
    });
    expect(analyses.get(ID.undated)!.moments).toEqual([{ t: 0, score: 5, focusX: 0.5, focusY: 0.5 }]);
  });

  it('frames a verdict without moments on the middle of the media', () => {
    const analyses = resolveVerdicts({ media: [verdict('m2', { score: 6, moments: [] })] }, items);
    expect(analyses.get(ID.clip)!.moments).toEqual([{ t: 3, score: 6, focusX: 0.5, focusY: 0.5 }]);
  });

  it('resolves duplicateOf to a media id, and drops it when it points outside the set or at itself', () => {
    const analyses = resolveVerdicts(
      { media: [verdict('m1', { duplicateOf: 'm3' }), verdict('m2', { duplicateOf: 'm9' }), verdict('m3', { duplicateOf: 'm3' })] },
      items,
    );
    expect(analyses.get(ID.photo)!.duplicateOf).toBe(ID.undated);
    expect(analyses.get(ID.clip)!.duplicateOf).toBeNull();
    expect(analyses.get(ID.undated)!.duplicateOf).toBeNull();
  });

  it('ignores verdicts for unknown refs and keeps the first of repeated ones', () => {
    const analyses = resolveVerdicts({ media: [verdict('m7'), verdict('m1', { score: 9 }), verdict('m1', { score: 2 })] }, items);
    expect([...analyses.keys()].sort()).toEqual([ID.clip, ID.photo, ID.undated].sort());
    expect(analyses.get(ID.photo)!.score).toBe(9);
  });
});
