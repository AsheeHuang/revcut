import { z } from 'zod';
import { CLIP_MAX_SEC, CLIP_MIN_SEC, TARGET_MAX_SEC, TARGET_MIN_SEC } from './constants';
import { barShape } from './section';
import type { MediaKind, MediaStatus, MusicStatus } from './status';
import type { Timeline } from './timeline';
import { computeTiming, framesToSec } from './timing';

// SPEC §3.4: warnings leave the export to the user, errors block it.
const ISSUE_LEVELS = {
  CLIP_TOO_SHORT: 'warning',
  CLIP_TOO_LONG: 'warning',
  TOTAL_TOO_SHORT: 'warning',
  TOTAL_TOO_LONG: 'warning',
  NOT_WHOLE_BARS: 'warning',
  SOURCE_OVERRUN: 'error',
  START_NOT_DOWNBEAT: 'error',
  TRACK_MISSING: 'error',
  TRACK_NOT_READY: 'error',
  BEATS_EXHAUSTED: 'error',
  MEDIA_MISSING: 'error',
  MEDIA_EXCLUDED: 'error',
  MEDIA_NOT_READY: 'error',
} as const;

export const ValidationCode = z.enum(Object.keys(ISSUE_LEVELS) as [keyof typeof ISSUE_LEVELS]);
export type ValidationCode = z.infer<typeof ValidationCode>;

export const ValidationIssue = z.object({ code: ValidationCode, message: z.string(), clipId: z.uuid().optional() });
export type ValidationIssue = z.infer<typeof ValidationIssue>;

export const ValidationResult = z.object({ errors: z.array(ValidationIssue), warnings: z.array(ValidationIssue) });
export type ValidationResult = z.infer<typeof ValidationResult>;

export type ValidationContext = {
  track: { status: MusicStatus; beats: number[] | null; downbeatIndices: number[] | null } | null;
  media: Readonly<Record<string, { kind: MediaKind; status: MediaStatus; excluded: boolean; durationSec: number | null }>>;
};

// durationSec is stored as a 4-byte real, so an in-point clamped to the very end can read back a hair over.
export const DURATION_TOLERANCE_SEC = 1e-4;

const sec = (value: number) => Number(value.toFixed(2));

export function validateTimeline(timeline: Timeline, context: ValidationContext): ValidationResult {
  const issues: ValidationIssue[] = [];
  const add = (code: ValidationCode, message: string, clipId?: string) =>
    issues.push(clipId === undefined ? { code, message } : { code, message, clipId });

  for (const clip of timeline.clips) {
    const media = context.media[clip.mediaId];
    if (!media) add('MEDIA_MISSING', '素材已刪除', clip.id);
    else if (media.excluded) add('MEDIA_EXCLUDED', '素材已排除', clip.id);
    else if (media.status !== 'ready') add('MEDIA_NOT_READY', '素材還沒處理完成', clip.id);
  }

  const { track } = context;
  const { startBeat } = timeline.music;
  if (!track) add('TRACK_MISSING', '歌曲已刪除');
  else if (track.status !== 'ready' || !track.beats || !track.downbeatIndices) add('TRACK_NOT_READY', '歌曲還沒分析完成');
  else {
    const { beats, downbeatIndices } = track;
    if (!downbeatIndices.includes(startBeat)) add('START_NOT_DOWNBEAT', '音樂起點不是重拍');
    const totalBeats = timeline.clips.reduce((sum, clip) => sum + clip.beats, 0);
    const shape = barShape(beats, downbeatIndices);
    if (shape && totalBeats % shape.beatsPerBar !== 0) {
      add('NOT_WHOLE_BARS', `總長 ${totalBeats} 拍，不是整數小節，結尾不在重拍上`);
    }

    const timing = computeTiming(beats, startBeat, timeline.clips);
    if (!timing) add('BEATS_EXHAUSTED', '歌曲的拍數不夠，片段超過歌曲結尾');
    else {
      timeline.clips.forEach((clip, k) => {
        const clipSec = framesToSec(timing.clips[k]!.frames);
        if (clipSec < CLIP_MIN_SEC) add('CLIP_TOO_SHORT', `片段 ${sec(clipSec)} 秒，短於 ${CLIP_MIN_SEC} 秒`, clip.id);
        if (clipSec > CLIP_MAX_SEC) add('CLIP_TOO_LONG', `片段 ${sec(clipSec)} 秒，超過 ${CLIP_MAX_SEC} 秒`, clip.id);
        const media = context.media[clip.mediaId];
        if (media?.kind === 'video' && media.durationSec !== null) {
          if (clip.sourceInSec + clipSec > media.durationSec + DURATION_TOLERANCE_SEC) {
            add(
              'SOURCE_OVERRUN',
              `影片只有 ${sec(media.durationSec)} 秒，從 ${sec(clip.sourceInSec)} 秒開始放不下 ${sec(clipSec)} 秒`,
              clip.id,
            );
          }
        }
      });
      const totalSec = framesToSec(timing.totalFrames);
      if (totalSec < TARGET_MIN_SEC) add('TOTAL_TOO_SHORT', `總長 ${sec(totalSec)} 秒，短於 ${TARGET_MIN_SEC} 秒`);
      if (totalSec > TARGET_MAX_SEC) add('TOTAL_TOO_LONG', `總長 ${sec(totalSec)} 秒，超過 ${TARGET_MAX_SEC} 秒`);
    }
  }

  return {
    errors: issues.filter((issue) => ISSUE_LEVELS[issue.code] === 'error'),
    warnings: issues.filter((issue) => ISSUE_LEVELS[issue.code] === 'warning'),
  };
}
