import { describe, expect, it } from 'vitest';
import { suggestSection } from '../section';
import type { Clip, Timeline } from '../timeline';
import { computeTiming, framesToSec } from '../timing';
import { validateTimeline } from '../validate';
import { changeSong } from './changeSong';
import { beatTrack, uuid } from './testTracks';

const from = beatTrack(123.71);
const to = beatTrack(91.95);
const PHOTO = uuid();
const VIDEO = uuid();
const media = { [PHOTO]: { kind: 'photo', durationSec: null }, [VIDEO]: { kind: 'video', durationSec: 3 } } as const;

function clip(beats: number, overrides: Partial<Clip> = {}): Clip {
  return {
    id: uuid(),
    mediaId: PHOTO,
    beats,
    sourceInSec: 0,
    crop: { focusX: 0.4, focusY: 0.6, zoom: 1.2 },
    kenBurns: { endZoom: 1.08 },
    date: '2026.01.08',
    originalVolume: 0.35,
    ...overrides,
  };
}

function timeline(clips: Clip[]): Timeline {
  return {
    schemaVersion: 1,
    music: { trackId: from.id, startBeat: 8, volume: 0.8, fadeOutSec: 2 },
    overlayEnabled: false,
    clips,
  };
}

function changed(result: ReturnType<typeof changeSong>) {
  if (!result.ok) throw new Error(`expected a timeline, got ${result.error}`);
  return result.timeline;
}

const total = (t: Timeline) => t.clips.reduce((sum, c) => sum + c.beats, 0);

describe('changeSong', () => {
  const section = suggestSection(to.beats, to.downbeatIndices, to.energy);
  if (!section.ok) throw new Error('fixture song has no section');

  it('moves to the new song’s suggested section and fills it in whole bars', () => {
    const before = timeline(Array.from({ length: 24 }, () => clip(2)));
    const after = changed(changeSong({ timeline: before, currentBeats: from.beats, next: to, media }));
    expect(after.music).toEqual({ trackId: to.id, startBeat: section.section.startBeat, volume: 0.8, fadeOutSec: 2 });
    expect(total(after)).toBe(section.section.totalBeats);
    expect(after.clips.map((c) => c.beats).every((b) => b >= 1 && b <= 3)).toBe(true);
    expect(after.clips.map(({ beats: _, ...rest }) => rest)).toEqual(before.clips.map(({ beats: _, ...rest }) => rest));
  });

  it('keeps each clip near its old length in seconds when the totals already match', () => {
    const slow = beatTrack(61.855);
    const before = timeline(Array.from({ length: 16 }, (_, i) => clip(i % 2 === 0 ? 2 : 4)));
    const after = changed(changeSong({ timeline: before, currentBeats: from.beats, next: slow, media }));
    expect(after.clips.map((c) => c.beats)).toEqual(before.clips.map((c) => c.beats / 2));
  });

  it('moves a video’s in-point earlier when its longer clip would run past the end', () => {
    const video = clip(2, { mediaId: VIDEO, sourceInSec: 2, kenBurns: null });
    const before = timeline([video, ...Array.from({ length: 11 }, () => clip(2))]);
    const after = changed(changeSong({ timeline: before, currentBeats: from.beats, next: to, media }));
    const timing = computeTiming(to.beats, after.music.startBeat, after.clips)!;
    const clipSec = framesToSec(timing.clips[0]!.frames);
    expect(after.clips[0]!.sourceInSec + clipSec).toBeLessThanOrEqual(3);
    expect(after.clips[0]!.sourceInSec).toBeGreaterThan(3 - clipSec - 1 / 30);
    const context = { track: { status: 'ready' as const, ...to }, media: Object.fromEntries(Object.entries(media).map(([id, m]) => [id, { ...m, status: 'ready' as const, excluded: false }])) };
    expect(validateTimeline(after, context).errors).toEqual([]);
  });

  it('settles on the nearest whole bars the clips can reach', () => {
    const after = changed(changeSong({ timeline: timeline([clip(2), clip(2)]), currentBeats: from.beats, next: to, media }));
    expect(total(after)).toBe(4);
  });

  it('refuses a song without a usable section', () => {
    const short = beatTrack(120, 15);
    expect(changeSong({ timeline: timeline([clip(2)]), currentBeats: from.beats, next: short, media })).toMatchObject({
      ok: false,
      error: 'SONG_TOO_SHORT',
    });
  });
});
