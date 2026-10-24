import type { MediaAnalysis } from '../analysis';
import type { Energy } from '../section';
import type { MediaKind } from '../status';

export type PlannerAnalysis = Omit<MediaAnalysis, 'description'>;

export type PlannerMedia = {
  id: string;
  kind: MediaKind;
  capturedAt: string | null;
  durationSec: number | null;
  analysis?: PlannerAnalysis | null;
};

export type PlannerTrack = { id: string; beats: number[]; downbeatIndices: number[]; energy: Energy };

export type PlanInput = { media: PlannerMedia[]; track: PlannerTrack; startBeat?: number };
