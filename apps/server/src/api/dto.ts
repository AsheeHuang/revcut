import { groupLivePhotos, isMediaBusy, type Media, type Project } from '@revcut/shared';
import type { media, projects } from '../db/schema';
import { toOffsetIso } from '../media/metadata';

type MediaRow = typeof media.$inferSelect;
type ProjectRow = typeof projects.$inferSelect;

function toMediaRecord(row: MediaRow) {
  const ready = row.status === 'ready';
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    error: row.error,
    filename: row.filename,
    width: row.width,
    height: row.height,
    durationSec: row.durationSec,
    isHdr: row.isHdr,
    hasAudio: row.hasAudio,
    capturedAt: row.capturedAt && row.utcOffsetMin !== null ? toOffsetIso(row.capturedAt, row.utcOffsetMin) : null,
    lat: row.lat,
    lng: row.lng,
    excluded: row.excluded,
    contentIdentifier: row.contentIdentifier,
    thumbUrl: ready ? `/api/media/${row.id}/thumb` : null,
    previewUrl: ready ? `/api/media/${row.id}/preview` : null,
    analysis: null,
  };
}

const captureKey = (item: Media) => (item.capturedAt === null ? Number.POSITIVE_INFINITY : Date.parse(item.capturedAt));

function byCaptureTime(a: Media, b: Media): number {
  const [ka, kb] = [captureKey(a), captureKey(b)];
  if (ka !== kb) return ka < kb ? -1 : 1;
  return a.filename.localeCompare(b.filename);
}

export function visibleMedia(rows: MediaRow[]): Media[] {
  return groupLivePhotos(rows.map(toMediaRecord))
    .map(({ contentIdentifier: _, ...item }) => item)
    .sort(byCaptureTime);
}

// One media as the list would show it; a HEIC hidden behind its LIVE video still answers by id.
export function mediaDto(row: MediaRow, group: MediaRow[]): Media {
  const shown = visibleMedia(group).find((item) => item.id === row.id);
  if (shown) return shown;
  const { contentIdentifier: _, ...item } = toMediaRecord(row);
  return { ...item, livePhoto: false };
}

export function projectDto(row: ProjectRow, items: Media[]): Project {
  const dates = items.flatMap((item) => (item.capturedAt ? [item.capturedAt.slice(0, 10)] : [])).sort();
  const count = (keep: (item: Media) => boolean) => items.filter(keep).length;
  return {
    id: row.id,
    title: row.title,
    dateRange: dates.length > 0 ? { from: dates[0]!, to: dates.at(-1)! } : null,
    draftState: row.draftState,
    draftError: row.draftError,
    currentTimelineId: row.currentTimelineId,
    mediaCounts: {
      total: items.length,
      ready: count((item) => item.status === 'ready'),
      processing: count((item) => isMediaBusy(item.status)),
      failed: count((item) => item.status === 'failed'),
      excluded: count((item) => item.excluded),
    },
  };
}
