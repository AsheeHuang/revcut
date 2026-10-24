import { z } from 'zod';

export const HealthCheckName = z.enum([
  'database',
  'disk',
  'ffmpeg',
  'ffprobe',
  'exiftool',
  'analyzer',
  'remotionBrowser',
  'anthropicKey',
  'openaiKey',
]);
export type HealthCheckName = z.infer<typeof HealthCheckName>;

export const HealthCheck = z.object({
  name: HealthCheckName,
  required: z.boolean(),
  ok: z.boolean(),
  detail: z.string(),
});
export type HealthCheck = z.infer<typeof HealthCheck>;

export const HealthResponse = z.object({
  ok: z.boolean(),
  checks: z.array(HealthCheck),
});
export type HealthResponse = z.infer<typeof HealthResponse>;
