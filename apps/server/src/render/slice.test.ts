import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runProcess } from '../process';
import { cutSlice, sliceSize } from './slice';

const never = new AbortController().signal;

describe('sliceSize', () => {
  it('scales a 4K portrait video down to exactly cover 1080x1920', () => {
    expect(sliceSize(2160, 3840, 1)).toEqual({ width: 1080, height: 1920 });
  });

  it('keeps enough pixels for a zoomed crop, but never more than the source has', () => {
    expect(sliceSize(2160, 3840, 1.5)).toEqual({ width: 1620, height: 2880 });
    expect(sliceSize(2160, 3840, 2.5)).toEqual({ width: 2160, height: 3840 });
    expect(sliceSize(1080, 1920, 1)).toEqual({ width: 1080, height: 1920 });
  });

  it('covers the height of a landscape video and keeps both sides even', () => {
    expect(sliceSize(3840, 2160, 1)).toEqual({ width: 3414, height: 1920 });
  });
});

describe('cutSlice', () => {
  let dir: string;
  const probe = async (file: string, args: string[]) =>
    JSON.parse((await runProcess('ffprobe', ['-v', 'error', ...args, '-of', 'json', file], { signal: never })).stdout);

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'revcut-slice-'));
    await runProcess(
      'ffmpeg',
      [
        ...['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=720x1280:rate=60', '-f', 'lavfi', '-i', 'sine', '-t', '6'],
        ...['-c:v', 'libx264', '-g', '120', '-color_trc', 'bt709', '-color_primaries', 'bt709', '-colorspace', 'bt709'],
        ...['-c:a', 'aac', path.join(dir, 'source.mp4')],
      ],
      { signal: never },
    );
  }, 60_000);
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it.each([false, true])('cuts a 30 fps slice with a keyframe every second and its audio (HDR chain: %s)', async (hdr) => {
    const out = path.join(dir, `slice-${hdr}.mp4`);
    await cutSlice({ source: path.join(dir, 'source.mp4'), window: { startSec: 1.5, endSec: 4.5 }, size: { width: 540, height: 960 }, hdr, out }, never);

    const { streams, format } = await probe(out, ['-show_entries', 'stream=codec_type,width,height,avg_frame_rate,color_transfer:format=duration']);
    expect(streams).toEqual([
      { codec_type: 'video', width: 540, height: 960, avg_frame_rate: '30/1', color_transfer: 'bt709' },
      expect.objectContaining({ codec_type: 'audio' }),
    ]);
    expect(Number(format.duration)).toBeCloseTo(3, 1);
    const { frames } = await probe(out, ['-select_streams', 'v', '-skip_frame', 'nokey', '-show_entries', 'frame=best_effort_timestamp_time']);
    expect(frames.map((f: { best_effort_timestamp_time: string }) => Math.round(Number(f.best_effort_timestamp_time)))).toEqual([0, 1, 2]);
  });
});
