import { rm } from 'node:fs/promises';
import { CreateProjectBody, isMediaBusy, PatchProjectBody, Project } from '@revcut/shared';
import { desc, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { HttpError } from '../app';
import { media, projects } from '../db/schema';
import { projectDir } from '../storage/paths';
import type { ApiDeps } from './deps';
import { projectDto, visibleMedia } from './dto';

export const IdParams = z.object({ id: z.uuid() });

export const projectRoutes: FastifyPluginAsyncZod<ApiDeps> = async (app, { db, dataDir }) => {
  async function loadProject(id: string): Promise<Project> {
    const [row] = await db.select().from(projects).where(eq(projects.id, id));
    if (!row) throw new HttpError(404, 'NOT_FOUND', '找不到專案');
    return projectDto(row, visibleMedia(await db.select().from(media).where(eq(media.projectId, id))));
  }

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
    loadProject(request.params.id),
  );

  app.patch(
    '/api/projects/:id',
    { schema: { params: IdParams, body: PatchProjectBody, response: { 200: Project } } },
    async (request) => {
      await db
        .update(projects)
        .set({ ...request.body, updatedAt: sql`now()` })
        .where(eq(projects.id, request.params.id));
      return loadProject(request.params.id);
    },
  );

  app.delete('/api/projects/:id', { schema: { params: IdParams } }, async (request, reply) => {
    const { id } = request.params;
    await db.transaction(async (tx) => {
      const [row] = await tx.select().from(projects).where(eq(projects.id, id)).for('update');
      if (!row) throw new HttpError(404, 'NOT_FOUND', '找不到專案');
      const rows = await tx.select({ status: media.status }).from(media).where(eq(media.projectId, id)).for('update');
      if (rows.some((m) => isMediaBusy(m.status))) throw new HttpError(409, 'BUSY', '處理中，請稍後再刪');
      await tx.delete(projects).where(eq(projects.id, id));
    });
    await rm(projectDir(dataDir, id), { recursive: true, force: true });
    return reply.code(204).send();
  });
};
