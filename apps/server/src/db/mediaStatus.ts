import type { MediaTransition } from '@revcut/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from './client';
import { media } from './schema';

// The status column is the only job record (SPEC §6.1); a conditional update
// both moves the state machine and claims the row, so a repeat finds nothing to do.
export function transitionMedia(
  db: Db,
  id: string,
  { from, to }: MediaTransition,
  patch: Partial<typeof media.$inferInsert> = {},
) {
  return db
    .update(media)
    .set({ ...patch, status: to, updatedAt: sql`now()` })
    .where(and(eq(media.id, id), eq(media.status, from)))
    .returning();
}
