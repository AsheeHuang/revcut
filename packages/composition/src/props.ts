import { computeTiming, type MediaKind, type Timeline } from '@revcut/shared';

export const COMPOSITION_ID = 'RecapVideo';

// SPEC §9.1: the preview points sources at the 720p preview files, the export at its slices.
export type ClipSource = { kind: MediaKind; src: string; startFromSec: number; width: number; height: number };

export type CompositionProps = {
  timeline: Timeline;
  music: { src: string; beats: number[] };
  sources: Record<string, ClipSource>;
};

export function recapDurationInFrames({ timeline, music }: CompositionProps): number {
  return computeTiming(music.beats, timeline.music.startBeat, timeline.clips)?.totalFrames ?? 1;
}
