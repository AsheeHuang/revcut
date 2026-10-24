import { FPS } from '@revcut/shared';

const clamp01 = (value: number) => Math.max(0, Math.min(value, 1));

// Remotion holds one volume per frame, so a fade is its linear ramp sampled at each frame.
// The first and last frames of a clip sit at 0 so the cut itself never jumps.
export function edgeFade(frame: number, frames: number, fadeSec: number): number {
  return clamp01(Math.min(frame, frames - 1 - frame) / (fadeSec * FPS));
}

export function tailFade(frame: number, totalFrames: number, fadeSec: number): number {
  return fadeSec <= 0 ? 1 : clamp01((totalFrames - 1 - frame) / (fadeSec * FPS));
}
