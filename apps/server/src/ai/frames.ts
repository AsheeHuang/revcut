import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { MediaKind } from '@revcut/shared';
import sharp from 'sharp';
import { runProcess } from '../process';
import { SYSTEM_PROMPT } from './contract';

export type Frame = { t: number; jpeg: Buffer; width: number; height: number };

export type RequestLimits = { maxImages: number; maxRequestBytes: number };
export type FrameBudget = { limits: RequestLimits; imageTokens: (width: number, height: number) => number };

const FRAME_LONG_EDGE = 640;
const JPEG_QUALITY = 80;
const MIN_FRAMES = 2;
const MAX_FRAMES = 8;
const SEC_PER_FRAME = 1.5;
const MAX_INPUT_TOKENS = 300_000;
// 640px frames from the real previews encode at 0.15–0.32 bytes per pixel at q80; base64 adds a third.
const JPEG_BYTES_PER_PIXEL = 0.35;
const BASE64_RATIO = 4 / 3;
// The prompt is mostly CJK, about one token per character; each media adds a header and frame labels.
const TEXT_TOKENS_PER_MEDIA = 40;
const TEXT_TOKENS_PER_FRAME = 8;

// SPEC §7.2.
export const frameCount = (durationSec: number) => Math.min(MAX_FRAMES, Math.max(MIN_FRAMES, Math.ceil(durationSec / SEC_PER_FRAME)));

export const frameTimes = (durationSec: number, n: number) => Array.from({ length: n }, (_, i) => ((i + 0.5) * durationSec) / n);

export function frameSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, FRAME_LONG_EDGE / Math.max(width, height));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

type FrameSource = { kind: MediaKind; durationSec: number | null; width: number | null; height: number | null };

// SPEC §7.2: estimate the request before extracting anything, and send fewer frames per video until it fits.
export function budgetFrames(sources: FrameSource[], { limits, imageTokens }: FrameBudget) {
  for (let cap = MAX_FRAMES; cap >= MIN_FRAMES; cap--) {
    const counts = sources.map((source) => (source.kind === 'photo' ? 1 : Math.min(cap, frameCount(source.durationSec ?? 0))));
    let inputTokens = SYSTEM_PROMPT.length + TEXT_TOKENS_PER_MEDIA * sources.length;
    let requestBytes = Buffer.byteLength(SYSTEM_PROMPT);
    sources.forEach((source, i) => {
      const { width, height } = frameSize(source.width ?? FRAME_LONG_EDGE, source.height ?? FRAME_LONG_EDGE);
      inputTokens += counts[i]! * (imageTokens(width, height) + TEXT_TOKENS_PER_FRAME);
      requestBytes += counts[i]! * width * height * JPEG_BYTES_PER_PIXEL * BASE64_RATIO;
    });
    const imageCount = counts.reduce((total, n) => total + n, 0);
    if (imageCount <= limits.maxImages && inputTokens <= MAX_INPUT_TOKENS && requestBytes <= limits.maxRequestBytes) {
      return { counts, imageCount, inputTokens, requestBytes };
    }
  }
  return null;
}

async function toFrame(t: number, input: string): Promise<Frame> {
  const { data, info } = await sharp(input)
    .resize(FRAME_LONG_EDGE, FRAME_LONG_EDGE, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer({ resolveWithObject: true });
  return { t, jpeg: data, width: info.width, height: info.height };
}

// Videos are sampled from the SDR preview, photos from photo.jpg; workDir only holds ffmpeg's stills meanwhile.
export async function extractFrames(
  source: { kind: MediaKind; file: string; durationSec: number | null },
  count: number,
  workDir: string,
  signal: AbortSignal,
): Promise<Frame[]> {
  if (source.kind === 'photo') return [await toFrame(0, source.file)];
  await mkdir(workDir, { recursive: true });
  try {
    const frames: Frame[] = [];
    for (const [i, t] of frameTimes(source.durationSec ?? 0, count).entries()) {
      const still = path.join(workDir, `${i}.png`);
      await runProcess('ffmpeg', ['-y', '-v', 'error', '-ss', t.toFixed(3), '-i', source.file, '-frames:v', '1', still], { signal });
      frames.push(await toFrame(t, still));
    }
    return frames;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
