import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../config';
import { isHdr, parseExiftool, parseFfprobe, resolveCaptureTime, toOffsetIso } from './metadata';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(path.join(repoRoot, 'fixtures', 'metadata', name), 'utf8'));

const exif = (file: string) => parseExiftool(fixture(`${file}.exiftool.json`));
const video = (file: string) => parseFfprobe(fixture(`${file}.ffprobe.json`));

function capturedAt(file: string, fileLastModified: Date | null = null) {
  const { captureTags, gps } = exif(file);
  const result = resolveCaptureTime({ tags: captureTags, gps, fileLastModified, defaultTz: 'Asia/Taipei' });
  return result && toOffsetIso(result.capturedAt, result.utcOffsetMin);
}

describe('resolveCaptureTime on real iPhone files', () => {
  it.each([
    ['IMG_0242.HEIC', '2026-01-08T19:31:37+08:00'],
    ['IMG_7554.JPG', '2026-01-18T20:07:19+08:00'],
    // An editing app appended 下午 to DateTimeOriginal; the 24-hour time before it is still right.
    ['IMG_0531.HEIC', '2026-01-25T14:19:56+08:00'],
  ])('takes DateTimeOriginal with OffsetTimeOriginal for photo %s', (file, expected) => {
    expect(capturedAt(file)).toBe(expected);
  });

  it('prefers Keys:CreationDate over QuickTime:CreateDate, which on a Live Photo MOV is the export time', () => {
    expect(capturedAt('IMG_0242.MOV')).toBe('2026-01-08T19:31:36+08:00');
  });

  it('converts a UTC QuickTime:CreateDate to DEFAULT_TZ when the file has no GPS', () => {
    expect(capturedAt('2B4B5138-C401-4A2D-AEE9-53E4068108C5.mov')).toBe('2026-01-31T17:13:30+08:00');
  });
});

describe('resolveCaptureTime on synthetic files', () => {
  it('keeps an explicit offset even where GPS says otherwise', () => {
    expect(capturedAt('jpeg-offset.jpg')).toBe('2026-10-05T08:00:00+09:00');
    expect(capturedAt('hdr-hevc.mov')).toBe('2026-10-04T09:15:00+09:00');
  });

  it('reads a naive DateTimeOriginal as local time where GPS places it', () => {
    expect(capturedAt('jpeg-naive.jpg')).toBe('2026-10-06T18:30:00-07:00');
  });

  it('converts a UTC CreateDate to DEFAULT_TZ', () => {
    expect(capturedAt('sdr-portrait.mp4')).toBe('2026-10-03T14:22:10+08:00');
  });
});

describe('resolveCaptureTime fallbacks', () => {
  const noTags = { dateTimeOriginal: null, keysCreationDate: null, quickTimeCreateDate: null };
  const tokyo = { lat: 35.66, lng: 139.7 };
  const iso = (result: ReturnType<typeof resolveCaptureTime>) =>
    result && toOffsetIso(result.capturedAt, result.utcOffsetMin);

  it('converts a UTC time to the zone at the GPS location', () => {
    const tags = { ...noTags, quickTimeCreateDate: new Date('2026-10-03T06:22:10Z') };
    expect(iso(resolveCaptureTime({ tags, gps: tokyo, fileLastModified: null, defaultTz: 'Asia/Taipei' }))).toBe(
      '2026-10-03T15:22:10+09:00',
    );
  });

  it('falls back to the browser lastModified, shown in the capture zone', () => {
    const fileLastModified = new Date('2026-10-03T06:22:10Z');
    expect(iso(resolveCaptureTime({ tags: noTags, gps: null, fileLastModified, defaultTz: 'Asia/Taipei' }))).toBe(
      '2026-10-03T14:22:10+08:00',
    );
  });

  it('applies daylight saving for the date, not for today', () => {
    const tags = { ...noTags, dateTimeOriginal: { wall: Date.UTC(2026, 0, 15, 9, 0, 0), offsetMin: null } };
    const sf = { lat: 37.779, lng: -122.419 };
    expect(iso(resolveCaptureTime({ tags, gps: sf, fileLastModified: null, defaultTz: 'Asia/Taipei' }))).toBe(
      '2026-01-15T09:00:00-08:00',
    );
  });

  it('returns null when nothing dates the file', () => {
    expect(resolveCaptureTime({ tags: noTags, gps: null, fileLastModified: null, defaultTz: 'Asia/Taipei' })).toBeNull();
  });
});

describe('parseExiftool', () => {
  it('reads the Live Photo identifier from both halves of a real pair', () => {
    expect(exif('IMG_0242.HEIC').contentIdentifier).toBe('C356D020-4DDD-437F-8CD2-37C929A4B676');
    expect(exif('IMG_0242.MOV').contentIdentifier).toBe('C356D020-4DDD-437F-8CD2-37C929A4B676');
    expect(exif('live.heic').contentIdentifier).toBe(exif('live.mov').contentIdentifier);
  });

  it('has no identifier on a plain photo or video', () => {
    expect(exif('IMG_0531.HEIC').contentIdentifier).toBeNull();
    expect(exif('IMG_0304.MOV').contentIdentifier).toBeNull();
  });

  it('reads signed GPS for photos and videos', () => {
    expect(exif('IMG_0242.MOV').gps).toEqual({ lat: 25.001, lng: 121.463 });
    expect(exif('jpeg-naive.jpg').gps).toEqual({ lat: 37.779, lng: -122.419 });
    expect(exif('2B4B5138-C401-4A2D-AEE9-53E4068108C5.mov').gps).toBeNull();
  });

  it('reports the MIME type the file content has', () => {
    expect(exif('IMG_0242.HEIC').mimeType).toBe('image/heic');
    expect(exif('IMG_0242.MOV').mimeType).toBe('video/quicktime');
  });
});

describe('parseFfprobe', () => {
  it('reports display size after the iPhone 90° rotation', () => {
    expect(video('IMG_0304.MOV')).toMatchObject({ width: 2160, height: 3840 });
    expect(video('IMG_0242.MOV')).toMatchObject({ width: 1080, height: 1920 });
  });

  it('keeps unrotated video as stored', () => {
    expect(video('2B4B5138-C401-4A2D-AEE9-53E4068108C5.mov')).toMatchObject({ width: 1080, height: 1920 });
  });

  it('reads duration, average frame rate and audio', () => {
    const live = video('IMG_0242.MOV');
    expect(live.durationSec).toBeCloseTo(1.92, 1);
    expect(live.fps).toBeCloseTo(22.49, 1);
    expect(live.hasAudio).toBe(true);
    expect(video('2B4B5138-C401-4A2D-AEE9-53E4068108C5.mov').hasAudio).toBe(false);
  });

  it('rejects a file without a video stream', () => {
    expect(() => parseFfprobe({ streams: [{ codec_type: 'audio' }], format: { duration: '3.0' } })).toThrow();
  });
});

describe('isHdr', () => {
  it.each([
    ['IMG_0304.MOV', true],
    ['hdr-hevc.mov', true],
    ['IMG_6389.MOV', false],
    ['IMG_0242.MOV', false],
    ['sdr-portrait.mp4', false],
  ])('%s → %s', (file, expected) => {
    expect(isHdr(video(file).colorTransfer)).toBe(expected);
  });

  it('treats PQ as HDR and a missing transfer as SDR', () => {
    expect(isHdr('smpte2084')).toBe(true);
    expect(isHdr(null)).toBe(false);
  });
});
