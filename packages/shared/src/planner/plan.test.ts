import { describe, expect, it } from 'vitest';
import { computeTiming, framesToSec } from '../timing';
import { plan } from './plan';
import { beatTrack, uuid } from './testTracks';
import type { MediaAnalysis, PlannerMedia } from './types';

const TRACK_ID = uuid();
const track = (bpm: number) => beatTrack(bpm, 200, TRACK_ID);

function lcg(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    return state / 2 ** 31;
  };
}

const at = (day: number, minute = 0) =>
  `2026-01-${String(day).padStart(2, '0')}T${String(10 + Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00+08:00`;

function photo(day: number, analysis?: MediaAnalysis, minute = 0): PlannerMedia {
  return { id: uuid(), kind: 'photo', capturedAt: at(day, minute), durationSec: null, analysis };
}

function video(day: number, durationSec: number, analysis?: MediaAnalysis, minute = 0): PlannerMedia {
  return { id: uuid(), kind: 'video', capturedAt: at(day, minute), durationSec, analysis };
}

const scored = (score: number, moments = [{ t: 0, score, focusX: 0.5, focusY: 0.5 }]): MediaAnalysis => ({
  usable: true,
  score,
  moments,
  duplicateOf: null,
});

function randomMedia(seed: number, count: number): PlannerMedia[] {
  const random = lcg(seed);
  const media: PlannerMedia[] = [];
  for (let i = 0; i < count; i++) {
    const day = 1 + Math.floor(random() * 10);
    const minute = Math.floor(random() * 600);
    const isVideo = random() < 0.6;
    const durationSec = isVideo ? 1.2 + random() * 25 : null;
    const moments = Array.from({ length: 1 + Math.floor(random() * 3) }, () => ({
      t: durationSec === null ? 0 : random() * durationSec,
      score: 1 + Math.floor(random() * 10),
      focusX: random(),
      focusY: random(),
    }));
    const analysis: MediaAnalysis | undefined =
      random() < 0.2
        ? undefined
        : {
            usable: random() > 0.1,
            score: 1 + Math.floor(random() * 10),
            moments,
            duplicateOf: i > 0 && random() < 0.05 ? media[i - 1]!.id : null,
          };
    media.push(isVideo ? video(day, durationSec!, analysis, minute) : photo(day, analysis, minute));
  }
  return media;
}

function planned(result: ReturnType<typeof plan>) {
  if (!result.ok) throw new Error(`expected a timeline, got ${result.error}`);
  return result;
}

describe('plan, across tempos', () => {
  const tempos = [60, 67, 75.95, 87.59, 91.95, 100, 113.21, 123.71, 133, 147, 160, 171, 180];
  const cases = tempos.flatMap((bpm) => [3, 9, 25, 60].flatMap((count) => [1, 2, 3].map((seed) => [bpm, count, seed] as const)));

  it.each(cases)('at %s BPM with %s media (seed %s) keeps every invariant', (bpm, count, seed) => {
    const song = track(bpm);
    const media = randomMedia(seed * 1000 + count, count);
    const result = plan({ media, track: song }, seed);
    const usable = media.filter((m) => m.analysis?.usable !== false && !(m.analysis?.duplicateOf && media.some((o) => o.id === m.analysis?.duplicateOf)));
    if (!result.ok) {
      expect(result.error).toBe('NOT_ENOUGH_MEDIA');
      expect(usable.length).toBeLessThan(4);
      return;
    }
    const { timeline } = planned(result);
    const beatSec = 60 / bpm;

    for (const clip of timeline.clips) {
      expect(clip.beats * beatSec).toBeGreaterThanOrEqual(0.5 - 0.01);
      expect(clip.beats * beatSec).toBeLessThanOrEqual(2 + 0.01);
      expect(usable.map((m) => m.id)).toContain(clip.mediaId);
    }

    const total = timeline.clips.reduce((sum, clip) => sum + clip.beats, 0);
    expect(total % 4).toBe(0);
    expect(song.downbeatIndices).toContain(timeline.music.startBeat);
    expect(song.beats[timeline.music.startBeat + total]).toBeDefined();

    const times = timeline.clips.map((clip) => Date.parse(media.find((m) => m.id === clip.mediaId)!.capturedAt!));
    expect(times).toEqual([...times].sort((a, b) => a - b));

    const timing = computeTiming(song.beats, timeline.music.startBeat, timeline.clips)!;
    timeline.clips.forEach((clip, k) => {
      const item = media.find((m) => m.id === clip.mediaId)!;
      if (item.kind === 'video') expect(clip.sourceInSec + framesToSec(timing.clips[k]!.frames)).toBeLessThanOrEqual(item.durationSec! + 1e-4);
    });

    expect(plan({ media, track: song }, seed)).toEqual(result);
  });

  it.each(tempos)('at %s BPM fills the whole suggested section when media are plentiful', (bpm) => {
    const song = track(bpm);
    const media = Array.from({ length: 60 }, (_, i) => photo(1 + (i % 20), scored(1 + (i % 10)), i));
    const { timeline, warnings } = planned(plan({ media, track: song }, 7));
    const total = timeline.clips.reduce((sum, clip) => sum + clip.beats, 0);
    const sectionSec = song.beats[timeline.music.startBeat + total]! - song.beats[timeline.music.startBeat]!;
    expect(sectionSec).toBeGreaterThanOrEqual(20);
    expect(sectionSec).toBeLessThanOrEqual(25);
    expect(warnings.map((w) => w.code)).not.toContain('TOTAL_TOO_SHORT');
  });
});

describe('plan', () => {
  it('cuts 2–4 beat clips over 12 bars at 123.71 BPM', () => {
    const media = Array.from({ length: 30 }, (_, i) => photo(1 + (i % 10), undefined, i));
    const { timeline } = planned(plan({ media, track: track(123.71) }, 1));
    const beats = timeline.clips.map((clip) => clip.beats);
    expect(Math.min(...beats)).toBeGreaterThanOrEqual(2);
    expect(Math.max(...beats)).toBeLessThanOrEqual(4);
    expect(beats.reduce((a, b) => a + b, 0)).toBe(48);
  });

  it('without analysis, centers each video on its middle and each crop on the frame', () => {
    const media = [video(1, 10), photo(2)];
    const { timeline } = planned(plan({ media, track: track(123.71) }, 1));
    const song = track(123.71);
    const timing = computeTiming(song.beats, timeline.music.startBeat, timeline.clips)!;
    const [videoClip, photoClip] = timeline.clips;
    const clipSec = framesToSec(timing.clips[0]!.frames);
    expect(videoClip!.sourceInSec).toBeLessThanOrEqual(5 - clipSec / 2);
    expect(videoClip!.sourceInSec).toBeGreaterThan(5 - clipSec / 2 - 1 / 30);
    expect(videoClip!.crop).toEqual({ focusX: 0.5, focusY: 0.5, zoom: 1 });
    expect(photoClip).toMatchObject({ sourceInSec: 0, kenBurns: { endZoom: 1.08 }, date: '2026.01.02' });
  });

  it('with too few media, drops whole bars until every clip fits in 2 s', () => {
    const { timeline, warnings } = planned(plan({ media: [photo(1), photo(2), photo(3)], track: track(123.71) }, 1));
    expect(timeline.clips.map((clip) => clip.beats)).toEqual([4, 4, 4]);
    expect(warnings.map((w) => w.code)).toEqual(['TOTAL_TOO_SHORT']);
  });

  it('answers NOT_ENOUGH_MEDIA when nothing is usable', () => {
    const unusable = { ...scored(9), usable: false };
    expect(plan({ media: [photo(1, unusable)], track: track(120) }, 1)).toEqual({
      ok: false,
      error: 'NOT_ENOUGH_MEDIA',
      message: '素材不足',
    });
    expect(plan({ media: [], track: track(120) }, 1)).toMatchObject({ error: 'NOT_ENOUGH_MEDIA' });
  });

  it('skips unusable media and media marked as a duplicate of another one', () => {
    const kept = photo(1, scored(5));
    const duplicate = photo(2, { ...scored(9), duplicateOf: kept.id });
    const blurry = photo(3, { ...scored(9), usable: false });
    const orphan = photo(4, { ...scored(9), duplicateOf: uuid() });
    const { timeline } = planned(plan({ media: [kept, duplicate, blurry, orphan], track: track(123.71) }, 1));
    expect(timeline.clips.map((clip) => clip.mediaId)).toEqual([kept.id, orphan.id]);
  });

  it('with too many media, takes the best scores, at most 3 a day', () => {
    const media = Array.from({ length: 100 }, (_, i) => photo(1 + (i % 10), scored(1 + ((i * 7) % 10)), i));
    const { timeline } = planned(plan({ media, track: track(123.71) }, 1));
    expect(timeline.clips).toHaveLength(24);
    const picked = timeline.clips.map((clip) => media.find((m) => m.id === clip.mediaId)!);
    expect(new Set(picked.map((m) => m.id)).size).toBe(24);
    const perDay = Map.groupBy(picked, (m) => m.capturedAt!.slice(0, 10));
    expect(Math.max(...[...perDay.values()].map((day) => day.length))).toBeLessThanOrEqual(3);
    const lowest = Math.min(...picked.map((m) => m.analysis!.score));
    const skippedBetter = media.filter((m) => m.analysis!.score > lowest && !picked.includes(m));
    expect(skippedBetter.every((m) => perDay.get(m.capturedAt!.slice(0, 10))?.length === 3)).toBe(true);
  });

  it('raises the per-day cap one at a time until the clips are filled', () => {
    const busyDay = Array.from({ length: 20 }, (_, i) => photo(1, scored(9), i));
    const quietDays = Array.from({ length: 20 }, (_, i) => photo(2 + (i % 10), scored(5), i));
    const { timeline } = planned(plan({ media: [...busyDay, ...quietDays], track: track(123.71) }, 1));
    expect(timeline.clips).toHaveLength(24);
    expect(timeline.clips.filter((clip) => busyDay.some((m) => m.id === clip.mediaId))).toHaveLength(4);
  });

  it('gives a video shorter than its slot fewer beats and the rest to other clips', () => {
    const shortVideos = [video(2, 1.9), video(5, 1.83)];
    const media = [...Array.from({ length: 7 }, (_, i) => photo(1 + i * 2)), ...shortVideos];
    const result = planned(plan({ media, track: track(123.71) }, 1));
    const short = result.timeline.clips.filter((clip) => shortVideos.some((m) => m.id === clip.mediaId));
    expect(short.map((clip) => clip.beats).every((beats) => beats <= 3)).toBe(true);
    expect(result.timeline.clips.reduce((sum, clip) => sum + clip.beats, 0)).toBe(32);
  });

  it('fills a short list with second moments at least 3 s from the first', () => {
    const moments = [
      { t: 5, score: 9, focusX: 0.5, focusY: 0.5 },
      { t: 6.5, score: 8, focusX: 0.5, focusY: 0.5 },
      { t: 20, score: 7, focusX: 0.5, focusY: 0.5 },
    ];
    const long = video(1, 30, scored(9, moments));
    const media = [long, ...Array.from({ length: 10 }, (_, i) => photo(2 + i, scored(5)))];
    const song = track(123.71);
    const { timeline } = planned(plan({ media, track: song }, 1));
    const timing = computeTiming(song.beats, timeline.music.startBeat, timeline.clips)!;
    const centers = timeline.clips
      .map((clip, k) => ({ clip, mid: clip.sourceInSec + framesToSec(timing.clips[k]!.frames) / 2 }))
      .filter(({ clip }) => clip.mediaId === long.id)
      .map(({ mid }) => Math.round(mid));
    expect(centers).toEqual([5, 20]);
  });

  it('starts on the given downbeat and refuses one that is not', () => {
    const song = track(123.71);
    const media = [photo(1), photo(2)];
    expect(planned(plan({ media, track: song, startBeat: 40 }, 1)).timeline.music.startBeat).toBe(40);
    expect(plan({ media, track: song, startBeat: 41 }, 1)).toMatchObject({ ok: false, error: 'START_NOT_DOWNBEAT' });
  });

  it('orders by capture time and lets the seed break ties between equal scores', () => {
    const media = Array.from({ length: 40 }, (_, i) => photo(1 + (i % 10), scored(5), i));
    const one = planned(plan({ media, track: track(123.71) }, 1)).timeline;
    const two = planned(plan({ media, track: track(123.71) }, 2)).timeline;
    expect(one.clips.map((clip) => clip.mediaId)).not.toEqual(two.clips.map((clip) => clip.mediaId));
  });
});
