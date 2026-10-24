import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import decodeHeic from 'heic-decode';
import sharp, { type Sharp } from 'sharp';
import { runProcess } from '../process';
import { isHdr, type VideoInfo } from './metadata';

const PREVIEW_SHORT_EDGE = 720;
const PHOTO_LONG_EDGE = 3072;
const THUMB_LONG_EDGE = 360;

export function previewSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, PREVIEW_SHORT_EDGE / Math.min(width, height));
  const even = (side: number) => Math.round((side * scale) / 2) * 2;
  return { width: even(width), height: even(height) };
}

// SPEC §6.2 step 5: HDR is scaled in the first zscale so the float math runs at the target size, not 4K.
export function scaleFilter(hdr: boolean, { width, height }: { width: number; height: number }): string {
  if (!hdr) return `scale=${width}:${height},format=yuv420p`;
  return [
    `zscale=w=${width}:h=${height}:t=linear:npl=100`,
    'format=gbrpf32le',
    'zscale=p=bt709',
    'tonemap=hable:desat=0',
    'zscale=t=bt709:m=bt709:r=tv',
    'format=yuv420p',
  ].join(',');
}

function writeThumb(input: string | Buffer, output: string) {
  return sharp(input)
    .resize(THUMB_LONG_EDGE, THUMB_LONG_EDGE, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 })
    .toFile(output);
}

export async function makeVideoDerivatives(source: string, dir: string, video: VideoInfo, signal: AbortSignal) {
  const preview = path.join(dir, 'preview.mp4');
  // ffmpeg applies the display rotation before the filter chain, so the chain sees display size.
  await runProcess(
    'ffmpeg',
    [
      ...['-y', '-v', 'error', '-i', source, '-map', '0:v:0', '-map', '0:a:0?'],
      ...['-vf', `fps=30,${scaleFilter(isHdr(video.colorTransfer), previewSize(video.width, video.height))}`],
      ...['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-g', '15'],
      ...['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709'],
      ...['-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-f', 'mp4', preview],
    ],
    { signal },
  );
  const frame = path.join(dir, 'frame.png');
  const at = Math.min(1, (video.durationSec ?? 0) / 2);
  await runProcess('ffmpeg', ['-y', '-v', 'error', '-ss', String(at), '-i', preview, '-frames:v', '1', frame], { signal });
  await writeThumb(frame, path.join(dir, 'thumb.webp'));
  await rm(frame);
}

async function decodePhoto(source: string, ext: string): Promise<Sharp> {
  if (ext !== 'heic' && ext !== 'heif') return sharp(source);
  // libheif 1.12's heif-convert cannot read current iPhone HEICs; the WASM build of libheif 1.23 can.
  // Decoding to raw pixels also keeps the single lossy step at the final JPEG.
  const { width, height, data } = await decodeHeic({ buffer: await readFile(source) });
  return sharp(Buffer.from(data.buffer), { raw: { width, height, channels: 4 } });
}

// Returns the display size, after EXIF orientation.
export async function makePhotoDerivatives(source: string, ext: string, dir: string) {
  const image = await decodePhoto(source, ext);
  const { width, height, orientation } = await image.metadata();
  const photo = path.join(dir, 'photo.jpg');
  await image
    .rotate()
    .resize(PHOTO_LONG_EDGE, PHOTO_LONG_EDGE, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toFile(photo);
  await writeThumb(photo, path.join(dir, 'thumb.webp'));
  const sideways = (orientation ?? 1) >= 5;
  return { width: sideways ? height : width, height: sideways ? width : height };
}
