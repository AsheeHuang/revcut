import { rm } from 'node:fs/promises';
import { CreateProjectBody, isDraftBusy, isMediaBusy, isRenderBusy, PatchProjectBody, Project, RENDER_STATES } from '@revcut/shared';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { HttpError } from '../app';
import type { Db } from '../db/client';
import { media, projects, renders, timelines } from '../db/schema';
import { projectDir } from '../storage/paths';
import type { ApiDeps } from './deps';
import { projectDto, visibleMedia } from './dto';

export const IdParams = z.object({ id: z.uuid() });

export const busy = () => new HttpError(409, 'BUSY', '處理中，請稍後再刪');

export async function loadProject(db: Db, id: string): Promise<Project> {
  const [row] = await db.select().from(projects).where(eq(projects.id, id));
  if (!row) throw new HttpError(404, 'NOT_FOUND', '找不到專案');
  return projectDto(row, visibleMedia(await db.select().from(media).where(eq(media.projectId, id))));
}

// SPEC §6.1: nothing in a project is deleted while its draft or an export is still reading it.
export async function assertProjectIdle(tx: Pick<Db, 'select'>, projectId: string) {
  const [project] = await tx.select({ draftState: projects.draftState }).from(projects).where(eq(projects.id, projectId));
  const running = await tx
    .select({ id: renders.id })
    .from(renders)
    .where(and(eq(renders.projectId, projectId), inArray(renders.state, RENDER_STATES.filter(isRenderBusy))))
    .limit(1);
  if ((project && isDraftBusy(project.draftState)) || running.length > 0) throw busy();
}

export const projectRoutes: FastifyPluginAsyncZod<ApiDeps> = async (app, { db, dataDir }) => {

  app.get('/api/projects', { schema: { response: { 200: z.array(Project) } } }, async () => {
    const [rows, allMedia] = await Promise.all([
      db.select().from(projects).orderBy(desc(projects.createdAt)),
      db.select().from(media),
    ]);
    return rows.map((row) => projectDto(row, visibleMedia(allMedia.filter((m) => m.projectId === row.id))));
  });

  app.post(
    '/api/projects',
    { schema: { body: CreateProjectBody, response: { 201: Project } } },
    async (request, reply) => {
      const [row] = await db.insert(projects).values({ title: request.body.title }).returning();
      return reply.code(201).send(projectDto(row!, []));
    },
  );

  app.get('/api/projects/:id', { schema: { params: IdParams, response: { 200: Project } } }, (request) =>
    loadProject(db, request.params.id),
  );

  app.patch(
    '/api/projects/:id',
    { schema: { params: IdParams, body: PatchProjectBody, response: { 200: Project } } },
    async (request) => {
      const { id } = request.params;
      const [project] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, id));
      if (!project) throw new HttpError(404, 'NOT_FOUND', '找不到專案');
      const { currentTimelineId } = request.body;
      if (currentTimelineId !== undefined) {
        const [owned] = await db
          .select({ id: timelines.id })
          .from(timelines)
          .where(and(eq(timelines.id, currentTimelineId), eq(timelines.projectId, id)));
        if (!owned) throw new HttpError(422, 'TIMELINE_NOT_FOUND', '這個專案沒有這個版本');
      }
      await db
        .update(projects)
        .set({ ...request.body, updatedAt: sql`now()` })
        .where(eq(projects.id, id));
      return loadProject(db, id);
    },
  );

  app.delete('/api/projects/:id', { schema: { params: IdParams } }, async (request, reply) => {
    const { id } = request.params;
    await db.transaction(async (tx) => {
      const [row] = await tx.select().from(projects).where(eq(projects.id, id)).for('update');
      if (!row) throw new HttpError(404, 'NOT_FOUND', '找不到專案');
      const rows = await tx.select({ status: media.status }).from(media).where(eq(media.projectId, id)).for('update');
      if (rows.some((m) => isMediaBusy(m.status))) throw busy();
      await assertProjectIdle(tx, id);
      await tx.delete(projects).where(eq(projects.id, id));
    });
    await rm(projectDir(dataDir, id), { recursive: true, force: true });
    return reply.code(204).send();
  });
};
