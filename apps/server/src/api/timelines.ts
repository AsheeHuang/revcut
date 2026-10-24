import { randomInt } from 'node:crypto';
import { DraftBody, isMediaBusy, Project } from '@revcut/shared';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { HttpError } from '../app';
import { claimDraft } from '../db/draftState';
import { media, musicTracks, projects } from '../db/schema';
import type { ApiDeps } from './deps';
import { visibleMedia } from './dto';
import { IdParams, loadProject } from './projects';

export const timelineRoutes: FastifyPluginAsyncZod<ApiDeps> = async (app, { db, enqueueDraft }) => {
  // SPEC §6.4: the preconditions are checked up front, so a draft that starts can only fail on its own work.
  app.post(
    '/api/projects/:id/draft',
    { schema: { params: IdParams, body: DraftBody, response: { 202: Project } } },
    async (request, reply) => {
      const { id } = request.params;
      const { trackId, startBeat, seed = randomInt(2 ** 31) } = request.body;
      const [project] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, id));
      if (!project) throw new HttpError(404, 'NOT_FOUND', '找不到專案');

      const [track] = await db.select({ status: musicTracks.status }).from(musicTracks).where(eq(musicTracks.id, trackId));
      if (track?.status !== 'ready') {
        throw new HttpError(409, 'TRACK_NOT_READY', track ? '歌曲還沒分析完成' : '找不到歌曲');
      }
      const rows = await db.select().from(media).where(eq(media.projectId, id));
      if (rows.some((row) => isMediaBusy(row.status))) throw new HttpError(409, 'MEDIA_BUSY', '還有素材在處理');
      if (!visibleMedia(rows).some((item) => item.status === 'ready' && !item.excluded)) {
        throw new HttpError(422, 'NO_MEDIA', '沒有可用的素材');
      }

      const [claimed] = await claimDraft(db, id);
      if (!claimed) throw new HttpError(409, 'DRAFT_RUNNING', '初版正在產生中');
      enqueueDraft({ projectId: id, trackId, startBeat, seed });
      return reply.code(202).send(await loadProject(db, id));
    },
  );
};
