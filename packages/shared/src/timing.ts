import { FPS } from './constants';

export type ClipTiming = { startFrame: number; frames: number };
export type Timing = { f0: number; totalFrames: number; clips: ClipTiming[] };

const SLICE_MARGIN_SEC = 0.5;

function frameOfBeat(beats: readonly number[], index: number): number | undefined {
  const sec = beats[index];
  return sec === undefined ? undefined : Math.round(sec * FPS);
}

// SPEC §3.3: every cut is rounded from its absolute beat time, never accumulated, so
// each cut stays within half a frame of its beat. Null when the clips outrun the song.
export function computeTiming(
  beats: readonly number[],
  startBeat: number,
  clips: readonly { beats: number }[],
): Timing | null {
  const f0 = frameOfBeat(beats, startBeat);
  if (f0 === undefined) return null;
  let beat = startBeat;
  let start = f0;
  const timed: ClipTiming[] = [];
  for (const clip of clips) {
    beat += clip.beats;
    const end = frameOfBeat(beats, beat);
    if (end === undefined) return null;
    timed.push({ startFrame: start - f0, frames: end - start });
    start = end;
  }
  return { f0, totalFrames: start - f0, clips: timed };
}

export const framesToSec = (frames: number) => frames / FPS;

// Whole frames line an in-point up with the 30 fps grid of both the preview file and the export slice.
export const floorToFrame = (sec: number) => Math.floor(sec * FPS + 1e-6) / FPS;

export type SliceWindow = { startSec: number; endSec: number; startFromSec: number };

// SPEC §3.3: the export cuts half a second of margin around each clip, less at either end of the video.
export function sliceWindow(sourceInSec: number, clipSec: number, durationSec: number): SliceWindow {
  const startSec = Math.max(0, sourceInSec - SLICE_MARGIN_SEC);
  return {
    startSec,
    endSec: Math.min(durationSec, sourceInSec + clipSec + SLICE_MARGIN_SEC),
    startFromSec: sourceInSec - startSec,
  };
}
