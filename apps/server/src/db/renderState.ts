import type { RenderTransition } from '@revcut/shared';
import { and, eq } from 'drizzle-orm';
import type { Db } from './client';
import { renders } from './schema';

export function transitionRender(
  db: Db,
  id: string,
  { from, to }: RenderTransition,
  patch: Partial<typeof renders.$inferInsert> = {},
) {
  return db
    .update(renders)
    .set({ ...patch, state: to })
    .where(and(eq(renders.id, id), eq(renders.state, from)))
    .returning();
}
