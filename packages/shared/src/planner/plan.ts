import { FADE_OUT_SEC, MAX_CLIPS_PER_DAY } from '../constants';
import { barShape, SECTION_ERROR_MESSAGES, suggestSection } from '../section';
import type { Timeline } from '../timeline';
import { computeTiming, framesToSec } from '../timing';
import { type ValidationContext, type ValidationIssue, validateTimeline } from '../validate';
import { allocateBeats } from './allocateBeats';
import { beatRange } from './beatRange';
import { buildClip } from './buildClip';
import { type Random, seededRandom, seededUuid } from './random';
import type { MediaAnalysis, Moment, PlanInput, PlannerMedia, PlannerTrack } from './types';

export const PLAN_ERROR_MESSAGES = {
  ...SECTION_ERROR_MESSAGES,
  START_NOT_DOWNBEAT: '音樂起點必須是重拍',
  NOT_ENOUGH_MEDIA: '素材不足',
  INVALID_TIMELINE: '排出的時間軸不合規則',
} as const;
export type PlanError = keyof typeof PLAN_ERROR_MESSAGES;

export type PlanResult =
  | { ok: true; timeline: Timeline; warnings: ValidationIssue[] }
  | { ok: false; error: PlanError; message: string };

const DEFAULT_SCORE = 5;
const SECOND_MOMENT_GAP_SEC = 3;

type Section = { startBeat: number; beatsPerBar: number; totalBeats: number };
type Candidate = { media: PlannerMedia; moment: Moment; score: number; maxBeats: number; rank: number };

const fail = (error: PlanError, message: string = PLAN_ERROR_MESSAGES[error]): PlanResult => ({ ok: false, error, message });
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

// Phase 3 has no AI yet: every media is usable, scores 5, and is framed on its center.
function defaultAnalysis(media: PlannerMedia): MediaAnalysis {
  const t = media.kind === 'video' ? (media.durationSec ?? 0) / 2 : 0;
  return { usable: true, score: DEFAULT_SCORE, moments: [{ t, score: DEFAULT_SCORE, focusX: 0.5, focusY: 0.5 }], duplicateOf: null };
}

function chooseSection({ beats, downbeatIndices, energy }: PlannerTrack, startBeat: number | undefined): Section | PlanError {
  const shape = barShape(beats, downbeatIndices);
  if (!shape) return 'NO_DOWNBEATS';
  const totalBeats = shape.bars * shape.beatsPerBar;
  if (startBeat === undefined) {
    const suggested = suggestSection(beats, downbeatIndices, energy);
    if (!suggested.ok) return suggested.error;
    return { startBeat: suggested.section.startBeat, beatsPerBar: shape.beatsPerBar, totalBeats };
  }
  if (!downbeatIndices.includes(startBeat)) return 'START_NOT_DOWNBEAT';
  if (beats[startBeat + totalBeats] === undefined) return 'SONG_TOO_SHORT';
  return { startBeat, beatsPerBar: shape.beatsPerBar, totalBeats };
}

// SPEC §8.2 step 4: best scores first, at most MAX_CLIPS_PER_DAY a day, raised one at a time until full.
function pickByScore(ranked: Candidate[], count: number): Candidate[] {
  for (let cap = MAX_CLIPS_PER_DAY; ; cap++) {
    const perDay = new Map<string, number>();
    const picked: Candidate[] = [];
    for (const candidate of ranked) {
      if (picked.length === count) break;
      const day = candidate.media.capturedAt?.slice(0, 10) ?? '';
      const taken = perDay.get(day) ?? 0;
      if (taken < cap) {
        picked.push(candidate);
        perDay.set(day, taken + 1);
      }
    }
    if (picked.length === count) return picked;
  }
}

function varyRhythm(beats: number[], picked: Candidate[], minBeats: number, random: Random) {
  for (let pair = 0; pair < Math.floor(beats.length / 4); pair++) {
    const from = Math.floor(random() * beats.length);
    const to = Math.floor(random() * beats.length);
    if (from !== to && beats[from]! > minBeats && beats[to]! < picked[to]!.maxBeats) {
      beats[from]!--;
      beats[to]!++;
    }
  }
}

const captureKey = (media: PlannerMedia) => (media.capturedAt === null ? Number.POSITIVE_INFINITY : Date.parse(media.capturedAt));

// SPEC §8.2. A video shorter than its slot is capped before allocation (beatRange),
// so every video fits by construction instead of being repaired after sorting.
export function plan(input: PlanInput, seed: number): PlanResult {
  const random = seededRandom(seed);
  const { track } = input;
  const section = chooseSection(track, input.startBeat);
  if (typeof section === 'string') return fail(section);
  const { startBeat, beatsPerBar } = section;

  const { minBeats, maxBeats, baseBeats, capFor } = beatRange(track.beats, startBeat, section.totalBeats);

  const ids = new Set(input.media.map((media) => media.id));
  const firsts: Candidate[] = [];
  const seconds: Candidate[] = [];
  for (const media of input.media) {
    const rank = random();
    const analysis = media.analysis ?? defaultAnalysis(media);
    const cap = capFor(media);
    if (!analysis.usable || (analysis.duplicateOf !== null && ids.has(analysis.duplicateOf)) || cap < minBeats) continue;
    const moments = [...analysis.moments].sort((a, b) => b.score - a.score || a.t - b.t);
    const best = moments[0] ?? defaultAnalysis(media).moments[0]!;
    firsts.push({ media, moment: best, score: analysis.score, maxBeats: cap, rank });
    const second = media.kind === 'video' ? moments.find((m) => Math.abs(m.t - best.t) >= SECOND_MOMENT_GAP_SEC) : undefined;
    if (second) seconds.push({ media, moment: second, score: analysis.score, maxBeats: cap, rank });
  }

  const byScore = (a: Candidate, b: Candidate) => b.score - a.score || a.rank - b.rank;
  const target = (total: number) => clamp(Math.round(total / baseBeats), Math.ceil(total / maxBeats), Math.floor(total / minBeats));
  const needed = target(section.totalBeats) - firsts.length;
  const pool = [...firsts, ...seconds.sort(byScore).slice(0, Math.max(0, needed))].sort(byScore);

  for (let total = section.totalBeats; total > 0; total -= beatsPerBar) {
    const most = Math.min(Math.floor(total / minBeats), pool.length);
    let count = Math.min(target(total), pool.length);
    let picked = pickByScore(pool, count);
    const capacity = () => sum(picked.map((candidate) => candidate.maxBeats));
    while (capacity() < total && count < most) picked = pickByScore(pool, ++count);
    if (capacity() < total) continue;
    const slots = picked.map((candidate) => ({ beats: baseBeats, score: candidate.score, maxBeats: candidate.maxBeats }));
    const beats = allocateBeats(slots, total, minBeats);
    if (!beats) continue;
    varyRhythm(beats, picked, minBeats, random);

    const ordered = picked
      .map((candidate, i) => ({ ...candidate, beats: beats[i]! }))
      .sort((a, b) => captureKey(a.media) - captureKey(b.media) || a.media.id.localeCompare(b.media.id) || a.moment.t - b.moment.t);
    const timing = computeTiming(track.beats, startBeat, ordered)!;
    const timeline: Timeline = {
      schemaVersion: 1,
      music: { trackId: track.id, startBeat, volume: 1, fadeOutSec: FADE_OUT_SEC },
      overlayEnabled: true,
      clips: ordered.map((clip, k) =>
        buildClip({
          id: seededUuid(random),
          media: clip.media,
          moment: clip.moment,
          beats: clip.beats,
          clipSec: framesToSec(timing.clips[k]!.frames),
        }),
      ),
    };

    const context: ValidationContext = {
      track: { status: 'ready', beats: track.beats, downbeatIndices: track.downbeatIndices },
      media: Object.fromEntries(
        input.media.map((media) => [media.id, { kind: media.kind, status: 'ready', excluded: false, durationSec: media.durationSec }]),
      ),
    };
    const { errors, warnings } = validateTimeline(timeline, context);
    if (errors.length > 0) return fail('INVALID_TIMELINE', `${PLAN_ERROR_MESSAGES.INVALID_TIMELINE}：${errors[0]!.message}`);
    return { ok: true, timeline, warnings };
  }
  return fail('NOT_ENOUGH_MEDIA');
}
