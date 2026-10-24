import { ENERGY_HOP_SEC, type Media, plan, type PlannerMedia } from '@revcut/shared';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import PQueue from 'p-queue';
import { visibleMedia } from '../api/dto';
import type { Db } from '../db/client';
import { transitionDraft } from '../db/draftState';
import { media, musicTracks, projects, timelines } from '../db/schema';

export type DraftRequest = { projectId: string; trackId: string; startBeat?: number; seed: number };

class DraftFailure extends Error {}

const toPlannerMedia = ({ id, kind, capturedAt, durationSec }: Media): PlannerMedia => ({ id, kind, capturedAt, durationSec });

export function createDraftQueue({ db, log }: { db: Db; log: Pick<FastifyBaseLogger, 'info' | 'error'> }) {
  const queue = new PQueue({ concurrency: 1 });
  const shutdown = new AbortController();

  // SPEC §6.4. Phase 3 has no AI analysis, so a draft goes straight from queued to planning.
  async function draft({ projectId, trackId, startBeat, seed }: DraftRequest) {
    const [claimed] = await transitionDraft(db, projectId, { from: 'queued', to: 'planning' });
    if (!claimed) return;
    try {
      const [track] = await db.select().from(musicTracks).where(eq(musicTracks.id, trackId));
      if (!track || track.status !== 'ready' || !track.beats || !track.downbeatIndices || !track.energy) {
        throw new DraftFailure('找不到歌曲，或歌曲還沒分析完成');
      }
      const rows = await db.select().from(media).where(eq(media.projectId, projectId));
      const usable = visibleMedia(rows).filter((item) => item.status === 'ready' && !item.excluded);
      const result = plan(
        {
          media: usable.map(toPlannerMedia),
          track: {
            id: track.id,
            beats: track.beats,
            downbeatIndices: track.downbeatIndices,
            energy: { hopSec: ENERGY_HOP_SEC, values: track.energy },
          },
          startBeat,
        },
        seed,
      );
      if (!result.ok) throw new DraftFailure(result.message);

      await db.transaction(async (tx) => {
        const [timeline] = await tx.insert(timelines).values({ projectId, seed, data: result.timeline }).returning();
        const [done] = await transitionDraft(tx, projectId, { from: 'planning', to: 'done' }, { currentTimelineId: timeline!.id });
        if (!done) throw new Error('draft state changed while planning');
      });
    } catch (error) {
      if (shutdown.signal.aborted) return;
      log.error({ err: error, projectId }, 'project.draft failed');
      const message = error instanceof DraftFailure ? error.message : '排版失敗';
      await transitionDraft(db, projectId, { from: 'planning', to: 'failed' }, { draftError: message });
    }
  }

  return {
    enqueue(request: DraftRequest) {
      queue
        .add(() => draft(request))
        .catch((error: unknown) => {
          if (!shutdown.signal.aborted) log.error({ err: error, projectId: request.projectId }, 'project.draft crashed');
        });
    },

    // SPEC §6.1: from Phase 4 on a draft costs money, so one a restart interrupted fails instead of rerunning.
    async recover() {
      const interrupted = await db
        .update(projects)
        .set({ draftState: 'failed', draftError: '伺服器重啟中斷，請重試' })
        .where(inArray(projects.draftState, ['queued', 'analyzing', 'planning']))
        .returning({ id: projects.id });
      log.info({ failed: interrupted.length }, 'project.draft recovered');
    },

    idle: () => queue.onIdle(),

    async close() {
      queue.clear();
      shutdown.abort();
      await queue.onIdle();
    },
  };
}
