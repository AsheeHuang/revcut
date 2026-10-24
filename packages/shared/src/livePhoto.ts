import type { MediaKind, MediaStatus } from './status';

export type LiveGroupable = {
  kind: MediaKind;
  status: MediaStatus;
  contentIdentifier: string | null;
  capturedAt: string | null;
  lat: number | null;
  lng: number | null;
  placeLabel: string | null;
};

type Grouped<T> = T & { livePhoto: boolean };

// SPEC §4.4: a ready video hides the photos that share its content identifier
// and fills in what it lacks from them.
export function groupLivePhotos<T extends LiveGroupable>(media: readonly T[]): Grouped<T>[] {
  const photosById = new Map<string, T>();
  const readyVideoIds = new Set<string>();
  for (const item of media) {
    if (item.contentIdentifier === null) continue;
    if (item.kind === 'photo' && !photosById.has(item.contentIdentifier)) photosById.set(item.contentIdentifier, item);
    if (item.kind === 'video' && item.status === 'ready') readyVideoIds.add(item.contentIdentifier);
  }

  return media.flatMap((item): Grouped<T>[] => {
    const id = item.contentIdentifier;
    if (id === null || !readyVideoIds.has(id)) return [{ ...item, livePhoto: false }];
    if (item.kind === 'photo') return [];
    const photo = photosById.get(id);
    if (!photo || item.status !== 'ready') return [{ ...item, livePhoto: false }];
    const hasGps = item.lat !== null && item.lng !== null;
    return [
      {
        ...item,
        capturedAt: item.capturedAt ?? photo.capturedAt,
        lat: hasGps ? item.lat : photo.lat,
        lng: hasGps ? item.lng : photo.lng,
        placeLabel: item.placeLabel ?? photo.placeLabel,
        livePhoto: true,
      },
    ];
  });
}
