import { z } from 'zod';
import { MediaKind } from './status';
import { Timeline } from './timeline';
import { ValidationResult } from './validate';

const Timestamp = z.iso.datetime({ offset: true });

export const TimelineSummary = z.object({ id: z.uuid(), seed: z.number().int(), createdAt: Timestamp, updatedAt: Timestamp });
export type TimelineSummary = z.infer<typeof TimelineSummary>;

export const MediaAsset = z.object({
  kind: MediaKind,
  previewUrl: z.string(),
  width: z.number().int(),
  height: z.number().int(),
  durationSec: z.number().nullable(),
});
export type MediaAsset = z.infer<typeof MediaAsset>;

export const MusicAsset = z.object({
  url: z.string(),
  beats: z.array(z.number()),
  downbeatIndices: z.array(z.number().int()),
  durationSec: z.number().nullable(),
});
export type MusicAsset = z.infer<typeof MusicAsset>;

// SPEC §10.3: durationSec is computed from the clips and the song's beats, null when they run past its end.
export const TimelineDetail = TimelineSummary.extend({
  projectId: z.uuid(),
  durationSec: z.number().nullable(),
  data: Timeline,
  assets: z.object({ media: z.record(z.uuid(), MediaAsset), music: MusicAsset.nullable() }),
  validation: ValidationResult,
});
export type TimelineDetail = z.infer<typeof TimelineDetail>;

export const PutTimelineBody = z.object({ data: Timeline });
export type PutTimelineBody = z.infer<typeof PutTimelineBody>;
