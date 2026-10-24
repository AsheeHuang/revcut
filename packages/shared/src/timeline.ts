import { z } from 'zod';

export const Crop = z.object({
  focusX: z.number().min(0).max(1),
  focusY: z.number().min(0).max(1),
  zoom: z.number().min(1).max(3),
});
export type Crop = z.infer<typeof Crop>;

export const Clip = z.object({
  id: z.uuid(),
  mediaId: z.uuid(),
  beats: z.number().int().min(1),
  sourceInSec: z.number().min(0),
  crop: Crop,
  kenBurns: z.object({ endZoom: z.number().min(1).max(3) }).nullable(),
  date: z.string().nullable(),
  originalVolume: z.number().min(0).max(1),
});
export type Clip = z.infer<typeof Clip>;

export const Timeline = z.object({
  schemaVersion: z.literal(1),
  music: z.object({
    trackId: z.uuid(),
    startBeat: z.number().int().min(0),
    volume: z.number().min(0).max(1),
    fadeOutSec: z.number().min(0).max(5),
  }),
  overlayEnabled: z.boolean(),
  clips: z.array(Clip).min(1),
});
export type Timeline = z.infer<typeof Timeline>;
