import type { MusicTransition } from '@revcut/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from './client';
import { musicTracks } from './schema';

export function transitionMusic(
  db: Db,
  id: string,
  { from, to }: MusicTransition,
  patch: Partial<typeof musicTracks.$inferInsert> = {},
) {
  return db
    .update(musicTracks)
    .set({ ...patch, status: to, updatedAt: sql`now()` })
    .where(and(eq(musicTracks.id, id), eq(musicTracks.status, from)))
    .returning();
}
