import type { Energy } from '../section';
import type { MediaKind } from '../status';

export type Moment = { t: number; score: number; focusX: number; focusY: number };

export type MediaAnalysis = { usable: boolean; score: number; moments: Moment[]; duplicateOf: string | null };

export type PlannerMedia = {
  id: string;
  kind: MediaKind;
  capturedAt: string | null;
  durationSec: number | null;
  analysis?: MediaAnalysis | null;
};

export type PlannerTrack = { id: string; beats: number[]; downbeatIndices: number[]; energy: Energy };

export type PlanInput = { media: PlannerMedia[]; track: PlannerTrack; startBeat?: number };
