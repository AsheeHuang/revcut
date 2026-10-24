import path from 'node:path';
import fastifyStatic from '@fastify/static';
import { Render, StartRenderResponse, Timeline, validateTimeline } from '@revcut/shared';
import { desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { HttpError } from '../app';
import type { Db } from '../db/client';
import { projects, renders } from '../db/schema';
import { renderPaths } from '../storage/paths';
import type { ApiDeps } from './deps';
import { IdParams } from './projects';
import { loadTimelineContext } from './timelineContext';
import { findTimeline } from './timelines';

type RenderRow = typeof renders.$inferSelect;

const SliceParams = z.object({ id: z.uuid(), name: z.string().regex(/^[0-9a-f-]{36}\.mp4$/) });

const renderDto = (row: RenderRow): Render => ({
  id: row.id,
  timelineId: row.timelineId,
  state: row.state,
  progress: row.progress,
  error: row.error,
  downloadUrl: row.state === 'done' ? `/api/renders/${row.id}/download` : null,
  createdAt: row.createdAt.toISOString(),
  finishedAt: row.finishedAt?.toISOString() ?? null,
});

const UNSAFE_IN_FILENAME = /[\\/:*?"<>|\x00-\x1f]/g;

// SPEC §5.2: filename* carries the UTF-8 title (RFC 5987, which also reserves ' ( ) *),
// and filename an ASCII stand-in for clients that ignore it.
export function contentDisposition(title: string): string {
  const name = `${title.replace(UNSAFE_IN_FILENAME, '_')}.mp4`;
  const ascii = name.replace(/[^\x20-\x7e]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

async function findRender(db: Db, id: string): Promise<RenderRow> {
  const [row] = await db.select().from(renders).where(eq(renders.id, id));
  if (!row) throw new HttpError(404, 'NOT_FOUND', '找不到這次匯出');
  return row;
}

export const renderRoutes: FastifyPluginAsyncZod<ApiDeps> = async (app, { db, dataDir, enqueueRender }) => {
  await app.register(fastifyStatic, { root: dataDir, serve: false });

  // SPEC §6.5: errors block the export, warnings do not; later edits never change a queued export.
  app.post(
    '/api/timelines/:id/renders',
    { schema: { params: IdParams, response: { 202: StartRenderResponse } } },
    async (request, reply) => {
      const timeline = await findTimeline(db, request.params.id);
      const data = Timeline.parse(timeline.data);
      const { errors } = validateTimeline(data, (await loadTimelineContext(db, timeline.projectId, data)).context);
      if (errors.length > 0) throw new HttpError(422, 'VALIDATION_FAILED', '時間軸有錯誤，不能匯出', errors);
      const [row] = await db
        .insert(renders)
        .values({ projectId: timeline.projectId, timelineId: timeline.id, snapshot: data })
        .returning({ id: renders.id });
      enqueueRender(row!.id);
      return reply.code(202).send({ renderId: row!.id });
    },
  );

  app.get('/api/renders/:id', { schema: { params: IdParams, response: { 200: Render } } }, async (request) =>
    renderDto(await findRender(db, request.params.id)),
  );

  app.get('/api/renders/:id/download', { schema: { params: IdParams } }, async (request, reply) => {
    const row = await findRender(db, request.params.id);
    if (row.state !== 'done') throw new HttpError(409, 'NOT_READY', '匯出還沒完成');
    const [project] = await db.select({ title: projects.title }).from(projects).where(eq(projects.id, row.projectId));
    const { output } = renderPaths(dataDir, row.projectId, row.id);
    reply.header('content-disposition', contentDisposition(project!.title));
    return reply.sendFile(path.basename(output), path.dirname(output));
  });

  app.get('/api/renders/:id/slices/:name', { schema: { params: SliceParams } }, async (request, reply) => {
    const row = await findRender(db, request.params.id);
    return reply.sendFile(request.params.name, renderPaths(dataDir, row.projectId, row.id).tmp);
  });

  app.get('/api/projects/:id/renders', { schema: { params: IdParams, response: { 200: z.array(Render) } } }, async (request) => {
    const [project] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, request.params.id));
    if (!project) throw new HttpError(404, 'NOT_FOUND', '找不到專案');
    const rows = await db.select().from(renders).where(eq(renders.projectId, project.id)).orderBy(desc(renders.createdAt));
    return rows.map(renderDto);
  });
};
