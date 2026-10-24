import { type Crop, HEIGHT, WIDTH } from '@revcut/shared';

export type Rect = { left: number; top: number; width: number; height: number };

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

// SPEC §9.2: cover the 1080x1920 frame, then put the focus at the center without showing past
// the source's edges. The focus is relative, so a preview and its original lay out alike.
export function coverRect(width: number, height: number, { focusX, focusY, zoom }: Crop): Rect {
  const scale = Math.max(WIDTH / width, HEIGHT / height) * zoom;
  const w = width * scale;
  const h = height * scale;
  return {
    left: clamp(WIDTH / 2 - focusX * w, WIDTH - w, 0),
    top: clamp(HEIGHT / 2 - focusY * h, HEIGHT - h, 0),
    width: w,
    height: h,
  };
}

export function kenBurnsZoom(frame: number, frames: number, from: number, to: number): number {
  return frames <= 1 ? from : from + ((to - from) * frame) / (frames - 1);
}
