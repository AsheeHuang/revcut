import { HEIGHT, type SliceWindow, WIDTH } from '@revcut/shared';
import { scaleFilter } from '../media/derive';
import { runProcess } from '../process';

export type Size = { width: number; height: number };

const evenUp = (value: number) => Math.ceil(value / 2) * 2;
const evenDown = (value: number) => Math.floor(value / 2) * 2;

// SPEC §6.5: enough pixels that the 9:16 crop at its zoom still covers 1080x1920, never more than the source.
export function sliceSize(width: number, height: number, zoom: number): Size {
  const scale = Math.min(1, Math.max(WIDTH / width, HEIGHT / height) * zoom);
  return { width: Math.min(evenUp(width * scale), evenDown(width)), height: Math.min(evenUp(height * scale), evenDown(height)) };
}

// Cut from the original, not the preview: HDR goes to SDR with the scale-first chain of §6.2,
// at a constant 30 fps with a keyframe every second, keeping the first audio track.
export async function cutSlice(
  { source, window, size, hdr, out }: { source: string; window: Pick<SliceWindow, 'startSec' | 'endSec'>; size: Size; hdr: boolean; out: string },
  signal: AbortSignal,
) {
  await runProcess(
    'ffmpeg',
    [
      ...['-y', '-v', 'error', '-ss', window.startSec.toFixed(6), '-i', source, '-t', (window.endSec - window.startSec).toFixed(6)],
      ...['-map', '0:v:0', '-map', '0:a:0?', '-vf', `fps=30,${scaleFilter(hdr, size)}`],
      ...['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-g', '30', '-sc_threshold', '0'],
      ...['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709'],
      ...['-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-f', 'mp4', out],
    ],
    { signal },
  );
}
