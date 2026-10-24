import { randomInt } from 'node:crypto';
import {
  computeTiming,
  DraftBody,
  framesToSec,
  isMediaBusy,
  Project,
  PutTimelineBody,
  Timeline,
  TimelineDetail,
  TimelineSummary,
  validateTimeline,
} from '@revcut/shared';
import { desc, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { HttpError } from '../app';
import type { Db } from '../db/client';
import { claimDraft } from '../db/draftState';
import { media, musicTracks, projects, timelines } from '../db/schema';
import { configuredProvider } from './ai';
import type { ApiDeps } from './deps';
import { visibleMedia } from './dto';
import { IdParams, loadProject } from './projects';
import { loadTimelineContext } from './timelineContext';

type TimelineRow = typeof timelines.$inferSelect;

const summary = (row: TimelineRow): TimelineSummary => ({
  id: row.id,
  seed: row.seed,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

// SPEC §10.3: the timeline plus what a preview needs, checked against the media and song as they are now.
async function timelineDetail(db: Db, row: TimelineRow): Promise<TimelineDetail> {
  const data = Timeline.parse(row.data);
  const { song, media: rows, context } = await loadTimelineContext(db, row.projectId, data);
  const timing = song && computeTiming(song.beats, data.music.startBeat, data.clips);
  const previewable = rows.flatMap(({ id, kind, status, width, height, durationSec }) =>
    status === 'ready' && width !== null && height !== null ? [{ id, kind, width, height, durationSec }] : [],
  );
  return {
    ...summary(row),
    projectId: row.projectId,
    durationSec: timing ? framesToSec(timing.totalFrames) : null,
    data,
    assets: {
      media: Object.fromEntries(
        previewable.map(({ id, ...asset }) => [id, { ...asset, previewUrl: `/api/media/${id}/preview` }]),
      ),
      music: song && {
        url: `/api/music/${song.id}/audio`,
        beats: song.beats,
        downbeatIndices: song.downbeatIndices,
        durationSec: song.durationSec,
      },
    },
    validation: validateTimeline(data, context),
  };
}

export async function findTimeline(db: Db, id: string): Promise<TimelineRow> {
  const [row] = await db.select().from(timelines).where(eq(timelines.id, id));
  if (!row) throw new HttpError(404, 'NOT_FOUND', '找不到這個版本');
  return row;
}

export const timelineRoutes: FastifyPluginAsyncZod<ApiDeps> = async (app, { db, ai, enqueueDraft }) => {
  // SPEC §6.4: the preconditions are checked up front, so a draft that starts can only fail on its own work.
  app.post(
    '/api/projects/:id/draft',
    { schema: { params: IdParams, body: DraftBody, response: { 202: Project } } },
    async (request, reply) => {
      const { id } = request.params;
      const { trackId, startBeat, seed = randomInt(2 ** 31), reanalyze = false } = request.body;
      const [project] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, id));
      if (!project) throw new HttpError(404, 'NOT_FOUND', '找不到專案');
      const provider = configuredProvider(ai, request.body.provider);

      const [track] = await db
        .select({ status: musicTracks.status })
        .from(musicTracks)
        .where(eq(musicTracks.id, trackId));
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
      enqueueDraft({ projectId: id, trackId, startBeat, seed, provider, reanalyze });
      return reply.code(202).send(await loadProject(db, id));
    },
  );

  app.get(
    '/api/projects/:id/timelines',
    { schema: { params: IdParams, response: { 200: TimelineSummary.array() } } },
    async (request) => {
      const [project] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, request.params.id));
      if (!project) throw new HttpError(404, 'NOT_FOUND', '找不到專案');
      const rows = await db.select().from(timelines).where(eq(timelines.projectId, project.id)).orderBy(desc(timelines.createdAt));
      return rows.map(summary);
    },
  );

  app.get('/api/timelines/:id', { schema: { params: IdParams, response: { 200: TimelineDetail } } }, async (request) =>
    timelineDetail(db, await findTimeline(db, request.params.id)),
  );

  // SPEC §3.4: an edit is stored even when it breaks a rule; only an export refuses errors.
  app.put(
    '/api/timelines/:id',
    { schema: { params: IdParams, body: PutTimelineBody, response: { 200: TimelineDetail } } },
    async (request) => {
      const [row] = await db
        .update(timelines)
        .set({ data: request.body.data, updatedAt: sql`now()` })
        .where(eq(timelines.id, request.params.id))
        .returning();
      if (!row) throw new HttpError(404, 'NOT_FOUND', '找不到這個版本');
      return timelineDetail(db, row);
    },
  );
};
