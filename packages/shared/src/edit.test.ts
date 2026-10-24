import { describe, expect, it } from 'vitest';
import { type EditCommand, type EditContext, type EditResult, applyEdit } from './edit';
import { beatRange } from './planner/beatRange';
import { beatTrack, uuid } from './planner/testTracks';
import type { PlannerMedia } from './planner/types';
import { suggestSection } from './section';
import type { Clip, Timeline } from './timeline';
import { computeTiming, framesToSec } from './timing';
import { validateTimeline } from './validate';

const track = beatTrack(120);

const PHOTO: PlannerMedia = {
  id: uuid(),
  kind: 'photo',
  capturedAt: '2026-01-08T10:00:00+08:00',
  durationSec: null,
  analysis: { usable: true, score: 6, moments: [{ t: 0, score: 6, focusX: 0.3, focusY: 0.7 }], duplicateOf: null },
};
const VIDEO: PlannerMedia = {
  id: uuid(),
  kind: 'video',
  capturedAt: '2026-01-09T23:30:00+08:00',
  durationSec: 6,
  analysis: {
    usable: true,
    score: 8,
    moments: [
      { t: 1, score: 5, focusX: 0.5, focusY: 0.5 },
      { t: 4, score: 9, focusX: 0.2, focusY: 0.4 },
    ],
    duplicateOf: null,
  },
};
const SHORT: PlannerMedia = {
  id: uuid(),
  kind: 'video',
  capturedAt: '2026-01-10T08:00:00+08:00',
  durationSec: 0.8,
  analysis: { usable: true, score: 4, moments: [{ t: 0.4, score: 4, focusX: 0.6, focusY: 0.5 }], duplicateOf: null },
};
const UNANALYZED: PlannerMedia = { id: uuid(), kind: 'photo', capturedAt: null, durationSec: null, analysis: null };

const media = Object.fromEntries([PHOTO, VIDEO, SHORT, UNANALYZED].map((m) => [m.id, m]));
const ctx: EditContext = { beats: track.beats, downbeatIndices: track.downbeatIndices, media };

function clip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: uuid(),
    mediaId: PHOTO.id,
    beats: 2,
    sourceInSec: 0,
    crop: { focusX: 0.5, focusY: 0.5, zoom: 1 },
    kenBurns: { endZoom: 1.08 },
    date: '2026.01.08',
    originalVolume: 0.35,
    ...overrides,
  };
}

const videoClip = (overrides: Partial<Clip> = {}) => clip({ mediaId: VIDEO.id, kenBurns: null, sourceInSec: 1, ...overrides });

function timeline(clips: Clip[], startBeat = 8): Timeline {
  return { schemaVersion: 1, music: { trackId: track.id, startBeat, volume: 1, fadeOutSec: 1.5 }, overlayEnabled: true, clips };
}

function edited(result: EditResult): Timeline {
  if (!result.ok) throw new Error(`edit refused: ${result.message}`);
  return result.timeline;
}

const run = (t: Timeline, command: EditCommand, context = ctx) => edited(applyEdit(t, command, context));
const ids = (t: Timeline) => t.clips.map((c) => c.id);

describe('applyEdit', () => {
  const [a, b, c, d] = [clip(), videoClip(), clip({ beats: 3 }), clip({ beats: 1 })];
  const base = timeline([a, b, c, d]);

  it('moves a clip to a new position and keeps the others in order', () => {
    expect(ids(run(base, { type: 'reorder', clipId: c.id, toIndex: 0 }))).toEqual([c.id, a.id, b.id, d.id]);
    expect(ids(run(base, { type: 'reorder', clipId: a.id, toIndex: 3 }))).toEqual([b.id, c.id, d.id, a.id]);
  });

  it('deletes a clip, but never the last one', () => {
    expect(ids(run(base, { type: 'delete', clipId: b.id }))).toEqual([a.id, c.id, d.id]);
    expect(applyEdit(timeline([a]), { type: 'delete', clipId: a.id }, ctx).ok).toBe(false);
  });

  it('inserts media with the planner’s defaults for its best moment', () => {
    const id = uuid();
    const after = run(base, { type: 'insert', index: 1, mediaId: VIDEO.id, clipId: id });
    expect(ids(after)).toEqual([a.id, id, b.id, c.id, d.id]);
    expect(after.clips[1]).toEqual({
      id,
      mediaId: VIDEO.id,
      beats: 2,
      sourceInSec: 3.5,
      crop: { focusX: 0.2, focusY: 0.4, zoom: 1 },
      kenBurns: null,
      date: '2026.01.09',
      originalVolume: 0.35,
    });
  });

  it('inserts a short video no longer than it can play', () => {
    const after = run(base, { type: 'insert', index: 4, mediaId: SHORT.id, clipId: uuid() });
    expect(after.clips[4]).toMatchObject({ beats: 1, sourceInSec: 4 / 30 });
  });

  it('frames inserted media without an analysis on its center', () => {
    const after = run(base, { type: 'insert', index: 0, mediaId: UNANALYZED.id, clipId: uuid() });
    expect(after.clips[0]).toMatchObject({ crop: { focusX: 0.5, focusY: 0.5, zoom: 1 }, date: null, kenBurns: { endZoom: 1.08 } });
  });

  it('replaces a clip’s media in place, keeping its id and length', () => {
    const after = run(base, { type: 'replaceMedia', clipId: c.id, mediaId: VIDEO.id });
    expect(after.clips[2]).toEqual({
      id: c.id,
      mediaId: VIDEO.id,
      beats: 3,
      sourceInSec: 97 / 30,
      crop: { focusX: 0.2, focusY: 0.4, zoom: 1 },
      kenBurns: null,
      date: '2026.01.09',
      originalVolume: 0.35,
    });
  });

  describe('beats', () => {
    const range = beatRange(track.beats, 8, 8);

    it('adds and removes one beat inside the allowed range', () => {
      expect(run(base, { type: 'nudgeBeats', clipId: c.id, delta: 1 }).clips[2]!.beats).toBe(4);
      expect(run(base, { type: 'nudgeBeats', clipId: c.id, delta: -1 }).clips[2]!.beats).toBe(2);
    });

    it('stops at the range’s ends', () => {
      const atMax = timeline([clip({ beats: range.maxBeats }), clip({ beats: range.minBeats })]);
      expect(run(atMax, { type: 'nudgeBeats', clipId: atMax.clips[0]!.id, delta: 1 })).toBe(atMax);
      expect(run(atMax, { type: 'nudgeBeats', clipId: atMax.clips[1]!.id, delta: -1 })).toBe(atMax);
    });

    it('pulls a video’s in-point back so the longer clip still fits', () => {
      const late = videoClip({ sourceInSec: 5 });
      const after = run(timeline([a, late]), { type: 'nudgeBeats', clipId: late.id, delta: 1 });
      expect(after.clips[1]).toMatchObject({ beats: 3, sourceInSec: 4.5 });
    });

    it('never makes a clip longer than its video', () => {
      const short = clip({ mediaId: SHORT.id, kenBurns: null, beats: 1 });
      const t = timeline([a, short]);
      expect(run(t, { type: 'nudgeBeats', clipId: short.id, delta: 1 })).toBe(t);
    });

    it('never runs past the song’s last beat', () => {
      const last = track.beats.length - 1;
      const t = timeline([clip({ beats: 2 }), clip({ beats: 2 })], last - 4);
      expect(run(t, { type: 'nudgeBeats', clipId: t.clips[0]!.id, delta: 1 })).toBe(t);
    });
  });

  describe('in-point', () => {
    it('keeps the clip inside the video and on a whole frame', () => {
      const set = (sec: number) => run(base, { type: 'setSourceIn', clipId: b.id, sec }).clips[1]!.sourceInSec;
      expect(set(10)).toBe(5);
      expect(set(-1)).toBe(0);
      expect(set(2.345)).toBe(70 / 30);
    });

    it('leaves photos at 0', () => {
      expect(run(base, { type: 'setSourceIn', clipId: a.id, sec: 2 })).toBe(base);
    });
  });

  it('moves the crop focus and zoom within their ranges', () => {
    const crop = (patch: Partial<Clip['crop']>) => run(base, { type: 'setCrop', clipId: a.id, crop: patch }).clips[0]!.crop;
    expect(crop({ focusX: 0.25, focusY: 0.8 })).toEqual({ focusX: 0.25, focusY: 0.8, zoom: 1 });
    expect(crop({ focusX: 1.4, focusY: -0.2 })).toEqual({ focusX: 1, focusY: 0, zoom: 1 });
    expect(crop({ zoom: 5 }).zoom).toBe(3);
    expect(crop({ zoom: 0.5 }).zoom).toBe(1);
    expect(run(base, { type: 'setCrop', clipId: a.id, crop: { focusX: 0.5 } })).toBe(base);
  });

  it('edits or hides the date', () => {
    expect(run(base, { type: 'setDate', clipId: a.id, date: '2026.12.25' }).clips[0]!.date).toBe('2026.12.25');
    expect(run(base, { type: 'setDate', clipId: a.id, date: null }).clips[0]!.date).toBeNull();
  });

  it('sets a clip’s original volume between 0 and 1', () => {
    expect(run(base, { type: 'setOriginalVolume', clipId: b.id, volume: 0.6 }).clips[1]!.originalVolume).toBe(0.6);
    expect(run(base, { type: 'setOriginalVolume', clipId: b.id, volume: 2 }).clips[1]!.originalVolume).toBe(1);
  });

  describe('music', () => {
    it('changes the song into whole bars of the new song, each clip inside its limits', () => {
      const next = beatTrack(91.95);
      const section = suggestSection(next.beats, next.downbeatIndices, next.energy);
      if (!section.ok) throw new Error('fixture song has no section');
      const before = timeline(Array.from({ length: 22 }, (_, i) => (i % 3 === 0 ? videoClip({ sourceInSec: 4.9 }) : clip())));
      const after = run(before, { type: 'changeSong', track: next });
      expect(after.music).toMatchObject({ trackId: next.id, startBeat: section.section.startBeat });
      const issues = validateTimeline(after, {
        track: { status: 'ready', beats: next.beats, downbeatIndices: next.downbeatIndices },
        media: Object.fromEntries(Object.values(media).map((m) => [m.id, { ...m, status: 'ready' as const, excluded: false }])),
      });
      expect([...issues.errors, ...issues.warnings].map((issue) => issue.code)).toEqual([]);
    });

    it('moves the start one bar at a time, always onto a downbeat', () => {
      expect(run(base, { type: 'moveStart', bars: 1 }).music.startBeat).toBe(12);
      expect(run(base, { type: 'moveStart', bars: -1 }).music.startBeat).toBe(4);
      const offGrid = timeline([a], 9);
      expect(run(offGrid, { type: 'moveStart', bars: 1 }).music.startBeat).toBe(12);
      expect(run(offGrid, { type: 'moveStart', bars: -1 }).music.startBeat).toBe(8);
    });

    it('does not move the start before the song or past where the clips still fit', () => {
      const first = timeline([a], 0);
      expect(run(first, { type: 'moveStart', bars: -1 })).toBe(first);
      const lastDownbeat = track.downbeatIndices.filter((i) => i + 8 <= track.beats.length - 1).at(-1)!;
      const last = timeline([clip({ beats: 4 }), clip({ beats: 4 })], lastDownbeat);
      expect(run(last, { type: 'moveStart', bars: 1 })).toBe(last);
    });

    it('sets the fade-out, music volume, and date overlay', () => {
      expect(run(base, { type: 'setFadeOut', sec: 3 }).music.fadeOutSec).toBe(3);
      expect(run(base, { type: 'setFadeOut', sec: 9 }).music.fadeOutSec).toBe(5);
      expect(run(base, { type: 'setFadeOut', sec: -1 }).music.fadeOutSec).toBe(0);
      expect(run(base, { type: 'setMusicVolume', volume: 0.4 }).music.volume).toBe(0.4);
      expect(run(base, { type: 'setMusicVolume', volume: 3 }).music.volume).toBe(1);
      expect(run(base, { type: 'setOverlay', enabled: false }).overlayEnabled).toBe(false);
    });
  });

  it('keeps every video clip inside its video through any sequence of edits', () => {
    const uneven = beatTrack(123.71);
    const context: EditContext = { beats: uneven.beats, downbeatIndices: uneven.downbeatIndices, media };
    const validation = {
      track: { status: 'ready' as const, beats: uneven.beats, downbeatIndices: uneven.downbeatIndices },
      media: Object.fromEntries(Object.values(media).map((m) => [m.id, { ...m, status: 'ready' as const, excluded: false }])),
    };
    let state = 7;
    const random = () => (state = (state * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const pick = <T,>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;

    let t = timeline(Array.from({ length: 16 }, (_, i) => (i % 2 ? videoClip({ sourceInSec: 4.9 }) : clip())), 16);
    for (let step = 0; step < 400; step++) {
      const target = pick(t.clips).id;
      const command = pick<EditCommand>([
        { type: 'reorder', clipId: target, toIndex: Math.floor(random() * t.clips.length) },
        { type: 'nudgeBeats', clipId: target, delta: random() < 0.5 ? 1 : -1 },
        { type: 'moveStart', bars: random() < 0.5 ? 1 : -1 },
        { type: 'setSourceIn', clipId: target, sec: random() * 8 },
        { type: 'insert', index: Math.floor(random() * t.clips.length), mediaId: pick([PHOTO.id, VIDEO.id]), clipId: uuid() },
        { type: 'replaceMedia', clipId: target, mediaId: pick([PHOTO.id, VIDEO.id]) },
        { type: 'delete', clipId: target },
      ]);
      const result = applyEdit(t, command, context);
      if (result.ok) t = result.timeline;
      expect(validateTimeline(t, validation).errors).toEqual([]);
      const timing = computeTiming(uneven.beats, t.music.startBeat, t.clips)!;
      t.clips.forEach((each, k) => {
        if (each.mediaId === VIDEO.id) expect(each.sourceInSec + framesToSec(timing.clips[k]!.frames)).toBeLessThanOrEqual(6);
      });
    }
  });
});
