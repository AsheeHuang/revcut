import type { Timeline, ValidationContext } from '@revcut/shared';
import { eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client';
import { media, musicTracks } from '../db/schema';

export type Song = { id: string; beats: number[]; downbeatIndices: number[]; durationSec: number | null };

export async function loadTimelineContext(db: Db, projectId: string, data: Timeline) {
  const [track] = await db.select().from(musicTracks).where(eq(musicTracks.id, data.music.trackId));
  const ids = [...new Set(data.clips.map((clip) => clip.mediaId))];
  const rows = (await db.select().from(media).where(inArray(media.id, ids))).filter((row) => row.projectId === projectId);
  const song: Song | null =
    track?.status === 'ready' && track.beats && track.downbeatIndices
      ? { id: track.id, beats: track.beats, downbeatIndices: track.downbeatIndices, durationSec: track.durationSec }
      : null;
  const context: ValidationContext = {
    track: track ? { status: track.status, beats: track.beats, downbeatIndices: track.downbeatIndices } : null,
    media: Object.fromEntries(
      rows.map((row) => [row.id, { kind: row.kind, status: row.status, excluded: row.excluded, durationSec: row.durationSec }]),
    ),
  };
  return { song, media: rows, context };
}
