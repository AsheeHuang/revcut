import { ORIGINAL_DEFAULT_VOLUME, PHOTO_END_ZOOM } from '../constants';
import type { Clip } from '../timeline';
import { floorToFrame } from '../timing';
import type { Moment, PlannerMedia } from './types';

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

// capturedAt carries the capture place's own offset, so its date part is the local date.
const localDate = (capturedAt: string | null) => (capturedAt === null ? null : capturedAt.slice(0, 10).replaceAll('-', '.'));

// SPEC §8.2 step 7: the one place clip defaults come from, shared by the planner and the editor.
export function buildClip({
  id,
  media,
  moment,
  beats,
  clipSec,
}: {
  id: string;
  media: Pick<PlannerMedia, 'id' | 'kind' | 'capturedAt' | 'durationSec'>;
  moment: Moment;
  beats: number;
  clipSec: number;
}): Clip {
  const isVideo = media.kind === 'video';
  return {
    id,
    mediaId: media.id,
    beats,
    sourceInSec: isVideo ? floorToFrame(clamp(moment.t - clipSec / 2, 0, (media.durationSec ?? 0) - clipSec)) : 0,
    crop: { focusX: moment.focusX, focusY: moment.focusY, zoom: 1 },
    kenBurns: isVideo ? null : { endZoom: PHOTO_END_ZOOM },
    date: localDate(media.capturedAt),
    originalVolume: ORIGINAL_DEFAULT_VOLUME,
  };
}
