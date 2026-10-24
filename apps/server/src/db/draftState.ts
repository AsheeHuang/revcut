import type { DraftTransition } from '@revcut/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from './client';
import { projects } from './schema';

const CLAIMABLE = ['idle', 'done', 'failed'] as const satisfies readonly Extract<DraftTransition, { to: 'queued' }>['from'][];

// SPEC §6.1: one draft per project. The conditional update both checks and claims,
// so a second request that finds nothing to update knows a draft is already running.
export function claimDraft(db: Db, id: string) {
  return db
    .update(projects)
    .set({ draftState: 'queued', draftError: null, updatedAt: sql`now()` })
    .where(and(eq(projects.id, id), inArray(projects.draftState, CLAIMABLE)))
    .returning();
}

export function transitionDraft(
  db: Pick<Db, 'update'>,
  id: string,
  { from, to }: DraftTransition,
  patch: Partial<typeof projects.$inferInsert> = {},
) {
  return db
    .update(projects)
    .set({ ...patch, draftState: to, updatedAt: sql`now()` })
    .where(and(eq(projects.id, id), eq(projects.draftState, from)))
    .returning();
}
