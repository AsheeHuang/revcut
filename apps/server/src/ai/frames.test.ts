import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runProcess } from '../process';
import { budgetFrames, extractFrames, frameCount, frameSize, frameTimes } from './frames';

describe('frameCount and frameTimes', () => {
  it.each([
    [1.8, 2],
    [3, 2],
    [3.1, 3],
    [6.17, 5],
    [12, 8],
    [33.9, 8],
  ])('takes clamp(ceil(%f / 1.5), 2, 8) frames from a video: %i', (durationSec, n) => {
    expect(frameCount(durationSec)).toBe(n);
  });

  it('samples the middle of n equal slices', () => {
    expect(frameTimes(6, 4)).toEqual([0.75, 2.25, 3.75, 5.25]);
  });
});

describe('frameSize', () => {
  it.each([
    [720, 1280, 360, 640],
    [1280, 720, 640, 360],
    [2304, 3072, 480, 640],
    [400, 300, 400, 300],
  ])('fits %ix%i into a 640 long edge without upscaling: %ix%i', (w, h, ew, eh) => {
    expect(frameSize(w, h)).toEqual({ width: ew, height: eh });
  });
});

describe('budgetFrames', () => {
  const video = (durationSec: number) => ({ kind: 'video' as const, durationSec, width: 1080, height: 1920 });
  const photo = { kind: 'photo' as const, durationSec: null, width: 3000, height: 4000 };
  const roomy = { limits: { maxImages: 600, maxRequestBytes: 32 * 1024 ** 2 }, imageTokens: () => 300 };

  it('sends every frame when the request fits, one per photo', () => {
    const budget = budgetFrames([video(12), video(1.8), photo], roomy);
    expect(budget).toMatchObject({ counts: [8, 2, 1], imageCount: 11 });
    expect(budget!.inputTokens).toBeGreaterThan(11 * 300);
  });

  it('lowers the frames per video until the image count fits', () => {
    const tenLongVideos = Array.from({ length: 10 }, () => video(30));
    const budget = budgetFrames([...tenLongVideos, video(2), photo], { ...roomy, limits: { ...roomy.limits, maxImages: 50 } });
    expect(budget?.counts).toEqual([...Array(10).fill(4), 2, 1]);
  });

  it('lowers the frames per video to stay under 300k tokens', () => {
    const budget = budgetFrames(Array.from({ length: 10 }, () => video(30)), { ...roomy, imageTokens: () => 5000 });
    expect(budget?.counts).toEqual(Array(10).fill(5));
    expect(budget!.inputTokens).toBeLessThanOrEqual(300_000);
  });

  it('lowers the frames per video to fit the request size', () => {
    const budget = budgetFrames(Array.from({ length: 10 }, () => video(30)), { ...roomy, limits: { ...roomy.limits, maxRequestBytes: 3 * 1024 ** 2 } });
    expect(budget!.counts.every((n) => n < 8)).toBe(true);
    expect(budget!.requestBytes).toBeLessThanOrEqual(3 * 1024 ** 2);
  });

  it('gives up when even two frames per video do not fit', () => {
    expect(budgetFrames(Array.from({ length: 10 }, () => video(30)), { ...roomy, limits: { ...roomy.limits, maxImages: 19 } })).toBeNull();
  });
});

describe('extractFrames', () => {
  let dir: string;
  const never = new AbortController().signal;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'revcut-frames-'));
    const ff = (args: string[]) => runProcess('ffmpeg', ['-y', '-v', 'error', ...args], { signal: never });
    await ff(['-f', 'lavfi', '-i', 'testsrc2=size=720x1280:rate=30', '-t', '4', '-pix_fmt', 'yuv420p', path.join(dir, 'preview.mp4')]);
    await ff(['-f', 'lavfi', '-i', 'testsrc2=size=2304x3072', '-frames:v', '1', path.join(dir, 'photo.jpg')]);
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('takes 640px JPEG frames at the sample times of a video and leaves no work files', async () => {
    const work = path.join(dir, 'work-video');
    const frames = await extractFrames({ kind: 'video', file: path.join(dir, 'preview.mp4'), durationSec: 4 }, 3, work, never);
    expect(frames.map((frame) => frame.t)).toEqual(frameTimes(4, 3));
    for (const frame of frames) {
      expect(await sharp(frame.jpeg).metadata()).toMatchObject({ format: 'jpeg', width: 360, height: 640 });
      expect([frame.width, frame.height]).toEqual([360, 640]);
    }
    await expect(readdir(work)).rejects.toThrow();
  });

  it('takes one 640px JPEG of a photo', async () => {
    const frames = await extractFrames({ kind: 'photo', file: path.join(dir, 'photo.jpg'), durationSec: null }, 1, path.join(dir, 'work-photo'), never);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ t: 0, width: 480, height: 640 });
  });
});
