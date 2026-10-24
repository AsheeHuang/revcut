import { SECTION_ERROR_MESSAGES, type SectionError, suggestSection } from '../section';
import type { MediaKind } from '../status';
import type { Timeline } from '../timeline';
import { computeTiming, floorToFrame, framesToSec } from '../timing';
import { allocateBeats } from './allocateBeats';
import { beatRange } from './beatRange';
import type { PlannerTrack } from './types';

export type ChangeSongInput = {
  timeline: Timeline;
  currentBeats: readonly number[];
  next: PlannerTrack;
  media: Readonly<Record<string, { kind: MediaKind; durationSec: number | null }>>;
  scores?: Readonly<Record<string, number>>;
};

export type ChangeSongResult = { ok: true; timeline: Timeline } | { ok: false; error: SectionError; message: string };

const DEFAULT_SCORE = 5;

// The whole bars closest to the target that the clips can fill; off the bar grid only if none can.
function reachableTotal(target: number, beatsPerBar: number, lo: number, hi: number): number {
  let best: number | null = null;
  for (let total = Math.ceil(lo / beatsPerBar) * beatsPerBar; total <= hi; total += beatsPerBar) {
    if (best === null || Math.abs(total - target) < Math.abs(best - target)) best = total;
  }
  return best ?? Math.max(lo, Math.min(target, hi));
}

// SPEC §3.5: start on the new song's suggested section, keep each clip near its old length
// in seconds, allocate to the new total, and pull video in-points back so clips still fit.
export function changeSong({ timeline, currentBeats, next, media, scores = {} }: ChangeSongInput): ChangeSongResult {
  const suggested = suggestSection(next.beats, next.downbeatIndices, next.energy);
  if (!suggested.ok) return { ok: false, error: suggested.error, message: SECTION_ERROR_MESSAGES[suggested.error] };
  const { startBeat, totalBeats, beatsPerBar } = suggested.section;
  const range = beatRange(next.beats, startBeat, totalBeats);

  const before = computeTiming(currentBeats, timeline.music.startBeat, timeline.clips);
  const meanBeatSec = (currentBeats.at(-1)! - currentBeats[0]!) / (currentBeats.length - 1);
  const slots = timeline.clips.map((clip, k) => {
    const sec = before ? framesToSec(before.clips[k]!.frames) : clip.beats * meanBeatSec;
    const item = media[clip.mediaId];
    return {
      beats: Math.round(sec / range.beatSec),
      score: scores[clip.mediaId] ?? DEFAULT_SCORE,
      maxBeats: item ? Math.max(range.minBeats, range.capFor(item)) : range.maxBeats,
    };
  });

  const beatsLeft = next.beats.length - 1 - startBeat;
  const lo = slots.length * range.minBeats;
  const hi = Math.min(beatsLeft, slots.reduce((sum, slot) => sum + slot.maxBeats, 0));
  const beats = allocateBeats(slots, reachableTotal(totalBeats, beatsPerBar, lo, hi), range.minBeats);
  if (!beats) return { ok: false, error: 'SONG_TOO_SHORT', message: '歌曲太短，放不下所有片段' };

  const after = computeTiming(next.beats, startBeat, beats.map((b) => ({ beats: b })))!;
  const clips = timeline.clips.map((clip, k) => {
    const item = media[clip.mediaId];
    const latest = (item?.durationSec ?? 0) - framesToSec(after.clips[k]!.frames);
    const overruns = item?.kind === 'video' && clip.sourceInSec > latest;
    return { ...clip, beats: beats[k]!, sourceInSec: overruns ? floorToFrame(Math.max(0, latest)) : clip.sourceInSec };
  });
  return { ok: true, timeline: { ...timeline, music: { ...timeline.music, trackId: next.id, startBeat }, clips } };
}
