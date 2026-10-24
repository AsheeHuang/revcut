import { describe, expect, it } from 'vitest';
import type { Clip, Timeline } from './timeline';
import { type ValidationContext, validateTimeline } from './validate';

let next = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`;

const VIDEO = uuid();
const PHOTO = uuid();

function grid(bpm: number, count = 200) {
  const beats = Array.from({ length: count }, (_, i) => (i * 60) / bpm);
  return { beats, downbeatIndices: beats.map((_, i) => i).filter((i) => i % 4 === 0) };
}

function clip(beats: number, overrides: Partial<Clip> = {}): Clip {
  return {
    id: uuid(),
    mediaId: PHOTO,
    beats,
    sourceInSec: 0,
    crop: { focusX: 0.5, focusY: 0.5, zoom: 1 },
    kenBurns: { endZoom: 1.08 },
    date: '2026.01.08',
    originalVolume: 0.35,
    ...overrides,
  };
}

function timeline(clips: Clip[], startBeat = 0): Timeline {
  return {
    schemaVersion: 1,
    music: { trackId: uuid(), startBeat, volume: 1, fadeOutSec: 1.5 },
    overlayEnabled: true,
    clips,
  };
}

function context(bpm = 120, overrides: Partial<ValidationContext> = {}): ValidationContext {
  return {
    track: { status: 'ready', ...grid(bpm) },
    media: {
      [VIDEO]: { kind: 'video', status: 'ready', excluded: false, durationSec: 3 },
      [PHOTO]: { kind: 'photo', status: 'ready', excluded: false, durationSec: null },
    },
    ...overrides,
  };
}

const twentyTwoSeconds = () => Array.from({ length: 22 }, () => clip(2));
const codes = (issues: { code: string }[]) => issues.map((issue) => issue.code);

describe('validateTimeline', () => {
  it('passes 11 whole bars of 1 s clips at 120 BPM', () => {
    expect(validateTimeline(timeline(twentyTwoSeconds()), context())).toEqual({ errors: [], warnings: [] });
  });

  it('warns about a clip shorter than 0.5 s or longer than 2 s, naming the clip', () => {
    const short = clip(1);
    const long = clip(5);
    const clips = [short, ...twentyTwoSeconds().slice(3), long];
    const { errors, warnings } = validateTimeline(timeline(clips, 0), context(140));
    expect(errors).toEqual([]);
    expect(warnings.filter((w) => w.clipId)).toEqual([
      expect.objectContaining({ code: 'CLIP_TOO_SHORT', clipId: short.id }),
      expect.objectContaining({ code: 'CLIP_TOO_LONG', clipId: long.id, message: '片段 2.17 秒，超過 2 秒' }),
    ]);
  });

  it('accepts clips of exactly 0.5 s and 2 s', () => {
    const clips = [clip(1), clip(4), ...twentyTwoSeconds().slice(3), clip(1)];
    expect(validateTimeline(timeline(clips), context()).warnings).toEqual([]);
  });

  it('warns when the total is outside 20–25 s', () => {
    expect(codes(validateTimeline(timeline([clip(4), clip(4), clip(4), clip(4)]), context()).warnings)).toEqual([
      'TOTAL_TOO_SHORT',
    ]);
    const long = Array.from({ length: 26 }, () => clip(2));
    expect(codes(validateTimeline(timeline(long), context()).warnings)).toEqual(['TOTAL_TOO_LONG']);
  });

  it('warns when the total is not a whole number of bars', () => {
    const clips = [...twentyTwoSeconds().slice(1), clip(1)];
    expect(codes(validateTimeline(timeline(clips), context()).warnings)).toEqual(['NOT_WHOLE_BARS']);
  });

  it('fails a video clip that runs past the end of its video, measured in frames', () => {
    const fits = clip(2, { mediaId: VIDEO, sourceInSec: 2, kenBurns: null });
    const overruns = clip(2, { mediaId: VIDEO, sourceInSec: 2.1, kenBurns: null });
    const rest = twentyTwoSeconds().slice(2);
    expect(validateTimeline(timeline([fits, overruns, ...rest]), context()).errors).toEqual([
      expect.objectContaining({ code: 'SOURCE_OVERRUN', clipId: overruns.id }),
    ]);
  });

  it('ignores the in-point of a photo', () => {
    const clips = [clip(2, { sourceInSec: 99 }), ...twentyTwoSeconds().slice(1)];
    expect(validateTimeline(timeline(clips), context()).errors).toEqual([]);
  });

  it('fails a music start that is not a downbeat', () => {
    expect(codes(validateTimeline(timeline(twentyTwoSeconds(), 2), context()).errors)).toEqual(['START_NOT_DOWNBEAT']);
  });

  it('fails a deleted or unanalyzed song without checking anything that needs its beats', () => {
    expect(validateTimeline(timeline(twentyTwoSeconds()), context(120, { track: null }))).toEqual({
      errors: [expect.objectContaining({ code: 'TRACK_MISSING', message: '歌曲已刪除' })],
      warnings: [],
    });
    const analyzing = context(120, { track: { status: 'analyzing', beats: null, downbeatIndices: null } });
    expect(codes(validateTimeline(timeline(twentyTwoSeconds()), analyzing).errors)).toEqual(['TRACK_NOT_READY']);
  });

  it('fails clips that run past the last beat of the song', () => {
    const { errors, warnings } = validateTimeline(timeline(twentyTwoSeconds(), 160), context());
    expect(codes(errors)).toEqual(['BEATS_EXHAUSTED']);
    expect(warnings).toEqual([]);
  });

  it('fails clips whose media was deleted, excluded, or is not ready', () => {
    const excluded = uuid();
    const processing = uuid();
    const clips = [
      clip(2, { mediaId: uuid() }),
      clip(2, { mediaId: excluded }),
      clip(2, { mediaId: processing }),
      ...twentyTwoSeconds().slice(3),
    ];
    const media = {
      ...context().media,
      [excluded]: { kind: 'photo', status: 'ready', excluded: true, durationSec: null },
      [processing]: { kind: 'video', status: 'processing', excluded: false, durationSec: null },
    } as const;
    const { errors } = validateTimeline(timeline(clips), context(120, { media }));
    expect(errors.map((e) => [e.code, e.clipId])).toEqual([
      ['MEDIA_MISSING', clips[0]!.id],
      ['MEDIA_EXCLUDED', clips[1]!.id],
      ['MEDIA_NOT_READY', clips[2]!.id],
    ]);
  });
});
