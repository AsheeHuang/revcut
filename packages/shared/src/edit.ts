import { changeSong } from './planner/changeSong';
import { beatRange } from './planner/beatRange';
import { buildClip } from './planner/buildClip';
import { rankedMoments } from './planner/plan';
import type { PlannerMedia, PlannerTrack } from './planner/types';
import type { Clip, Crop, Timeline } from './timeline';
import { computeTiming, floorToFrame, framesToSec } from './timing';
import { DURATION_TOLERANCE_SEC } from './validate';

// SPEC §11.3: every editor operation is one of these, applied by a pure function so undo can replay snapshots.
export type EditCommand =
  | { type: 'reorder'; clipId: string; toIndex: number }
  | { type: 'delete'; clipId: string }
  | { type: 'insert'; index: number; mediaId: string; clipId: string }
  | { type: 'replaceMedia'; clipId: string; mediaId: string }
  | { type: 'nudgeBeats'; clipId: string; delta: 1 | -1 }
  | { type: 'setSourceIn'; clipId: string; sec: number }
  | { type: 'setCrop'; clipId: string; crop: Partial<Crop> }
  | { type: 'setDate'; clipId: string; date: string | null }
  | { type: 'setOriginalVolume'; clipId: string; volume: number }
  | { type: 'changeSong'; track: PlannerTrack }
  | { type: 'moveStart'; bars: 1 | -1 }
  | { type: 'setFadeOut'; sec: number }
  | { type: 'setMusicVolume'; volume: number }
  | { type: 'setOverlay'; enabled: boolean };

// The current song and every media the editor can place.
export type EditContext = {
  beats: readonly number[];
  downbeatIndices: readonly number[];
  media: Readonly<Record<string, PlannerMedia>>;
};

// An edit that cannot apply returns the same timeline; ok: false carries a reason worth showing.
export type EditResult = { ok: true; timeline: Timeline } | { ok: false; message: string };

type Handlers = { [K in EditCommand['type']]: (t: Timeline, command: Extract<EditCommand, { type: K }>, ctx: EditContext) => Timeline | string };

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));
const totalBeats = (t: Timeline) => t.clips.reduce((sum, clip) => sum + clip.beats, 0);
const lastBeat = (ctx: EditContext) => ctx.beats.length - 1;
const fitsSong = (t: Timeline, ctx: EditContext) => t.music.startBeat + totalBeats(t) <= lastBeat(ctx);

function clipSeconds(t: Timeline, ctx: EditContext): number[] | null {
  return computeTiming(ctx.beats, t.music.startBeat, t.clips)?.clips.map((clip) => framesToSec(clip.frames)) ?? null;
}

function rangeOf(t: Timeline, ctx: EditContext) {
  return fitsSong(t, ctx) ? beatRange(ctx.beats, t.music.startBeat, totalBeats(t)) : null;
}

const withClip = (t: Timeline, clipId: string, update: (clip: Clip) => Clip): Timeline => ({
  ...t,
  clips: t.clips.map((clip) => (clip.id === clipId ? update(clip) : clip)),
});

const latestIn = (media: PlannerMedia, clipSec: number) => (media.durationSec ?? 0) - clipSec;

// Clip lengths shift by a frame when clips move between uneven beats, so after any edit a video
// that would now run past its end starts earlier instead of failing the export.
function fitSources(t: Timeline, ctx: EditContext): Timeline {
  const secs = clipSeconds(t, ctx);
  if (!secs) return t;
  let moved = false;
  const clips = t.clips.map((clip, k) => {
    const media = ctx.media[clip.mediaId];
    if (media?.kind !== 'video') return clip;
    const latest = latestIn(media, secs[k]!);
    if (clip.sourceInSec <= latest + DURATION_TOLERANCE_SEC) return clip;
    moved = true;
    return { ...clip, sourceInSec: floorToFrame(Math.max(0, latest)) };
  });
  return moved ? { ...t, clips } : t;
}

function placed(media: PlannerMedia, id: string, beats: number, clipSec: number): Clip {
  return buildClip({ id, media, moment: rankedMoments(media)[0]!, beats, clipSec });
}

const handlers: Handlers = {
  reorder(t, { clipId, toIndex }) {
    const from = t.clips.findIndex((clip) => clip.id === clipId);
    const to = clamp(toIndex, 0, t.clips.length - 1);
    if (from < 0 || from === to) return t;
    const clips = [...t.clips];
    clips.splice(to, 0, ...clips.splice(from, 1));
    return { ...t, clips };
  },

  delete(t, { clipId }) {
    if (t.clips.length === 1) return '至少要留一個片段';
    return { ...t, clips: t.clips.filter((clip) => clip.id !== clipId) };
  },

  insert(t, { index, mediaId, clipId }, ctx) {
    const media = ctx.media[mediaId];
    const range = rangeOf(t, ctx);
    if (!media || !range) return t;
    const beats = clamp(range.baseBeats, range.minBeats, Math.max(range.minBeats, range.capFor(media)));
    const at = clamp(index, 0, t.clips.length);
    const clips = [...t.clips];
    clips.splice(at, 0, placed(media, clipId, beats, beats * range.beatSec));
    const next = { ...t, clips };
    if (!fitsSong(next, ctx)) return '歌曲剩下的拍數不夠，放不下新的片段';
    clips[at] = placed(media, clipId, beats, clipSeconds(next, ctx)![at]!);
    return next;
  },

  replaceMedia(t, { clipId, mediaId }, ctx) {
    const media = ctx.media[mediaId];
    const k = t.clips.findIndex((clip) => clip.id === clipId);
    const secs = clipSeconds(t, ctx);
    if (!media || k < 0 || !secs) return t;
    return withClip(t, clipId, (clip) => placed(media, clip.id, clip.beats, secs[k]!));
  },

  nudgeBeats(t, { clipId, delta }, ctx) {
    const range = rangeOf(t, ctx);
    const k = t.clips.findIndex((clip) => clip.id === clipId);
    if (!range || k < 0) return t;
    const beats = t.clips[k]!.beats + delta;
    if ((delta > 0 && beats > range.maxBeats) || (delta < 0 && beats < range.minBeats)) return t;
    const next = withClip(t, clipId, (clip) => ({ ...clip, beats }));
    if (!fitsSong(next, ctx)) return t;
    const media = ctx.media[t.clips[k]!.mediaId];
    if (delta > 0 && media?.kind === 'video' && latestIn(media, clipSeconds(next, ctx)![k]!) < -DURATION_TOLERANCE_SEC) return t;
    return next;
  },

  setSourceIn(t, { clipId, sec }, ctx) {
    const k = t.clips.findIndex((clip) => clip.id === clipId);
    const media = ctx.media[t.clips[k]?.mediaId ?? ''];
    const secs = clipSeconds(t, ctx);
    if (media?.kind !== 'video' || !secs) return t;
    return withClip(t, clipId, (clip) => ({ ...clip, sourceInSec: floorToFrame(clamp(sec, 0, Math.max(0, latestIn(media, secs[k]!)))) }));
  },

  setCrop(t, { clipId, crop }) {
    const current = t.clips.find((clip) => clip.id === clipId)?.crop;
    if (!current) return t;
    const merged = { ...current, ...crop };
    const next = { focusX: clamp(merged.focusX, 0, 1), focusY: clamp(merged.focusY, 0, 1), zoom: clamp(merged.zoom, 1, 3) };
    const same = next.focusX === current.focusX && next.focusY === current.focusY && next.zoom === current.zoom;
    return same ? t : withClip(t, clipId, (clip) => ({ ...clip, crop: next }));
  },

  setDate: (t, { clipId, date }) => withClip(t, clipId, (clip) => ({ ...clip, date })),

  setOriginalVolume: (t, { clipId, volume }) => withClip(t, clipId, (clip) => ({ ...clip, originalVolume: clamp(volume, 0, 1) })),

  changeSong(t, { track }, ctx) {
    const scores = Object.fromEntries(Object.values(ctx.media).flatMap((m) => (m.analysis ? [[m.id, m.analysis.score]] : [])));
    const result = changeSong({ timeline: t, currentBeats: ctx.beats, next: track, media: ctx.media, scores });
    return result.ok ? result.timeline : result.message;
  },

  moveStart(t, { bars }, ctx) {
    const { startBeat } = t.music;
    const downbeat =
      bars > 0 ? ctx.downbeatIndices.find((i) => i > startBeat) : ctx.downbeatIndices.findLast((i) => i < startBeat);
    if (downbeat === undefined) return t;
    const next = { ...t, music: { ...t.music, startBeat: downbeat } };
    return fitsSong(next, ctx) ? next : t;
  },

  setFadeOut: (t, { sec }) => ({ ...t, music: { ...t.music, fadeOutSec: clamp(sec, 0, 5) } }),
  setMusicVolume: (t, { volume }) => ({ ...t, music: { ...t.music, volume: clamp(volume, 0, 1) } }),
  setOverlay: (t, { enabled }) => ({ ...t, overlayEnabled: enabled }),
};

export function applyEdit(timeline: Timeline, command: EditCommand, ctx: EditContext): EditResult {
  const handler = handlers[command.type] as (t: Timeline, command: EditCommand, ctx: EditContext) => Timeline | string;
  const result = handler(timeline, command, ctx);
  if (typeof result === 'string') return { ok: false, message: result };
  // changeSong fits the clips to the new song itself; the context still describes the old one.
  if (result === timeline || command.type === 'changeSong') return { ok: true, timeline: result };
  return { ok: true, timeline: fitSources(result, ctx) };
}
