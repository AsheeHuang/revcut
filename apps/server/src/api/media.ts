import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import { extensionOf, isMediaBusy, kindFromExtension, Media, PatchMediaBody, UploadMediaQuery } from '@revcut/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod, ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { HttpError } from '../app';
import { latestAnalyses } from '../db/analysis';
import type { Db } from '../db/client';
import { transitionMedia } from '../db/mediaStatus';
import { media, projects } from '../db/schema';
import { MIN_FREE_BYTES } from '../storage/disk';
import { mediaPaths } from '../storage/paths';
import { MAX_UPLOAD_BYTES, receiveFile } from '../storage/upload';
import type { ApiDeps } from './deps';
import { mediaDto, visibleMedia } from './dto';
import { assertProjectIdle, busy, IdParams } from './projects';

const notFound = () => new HttpError(404, 'NOT_FOUND', '找不到素材');

type MediaRow = typeof media.$inferSelect;

async function findMedia(db: Db, id: string): Promise<MediaRow> {
  const [row] = await db.select().from(media).where(eq(media.id, id));
  if (!row) throw notFound();
  return row;
}

function liveGroup(db: Db, row: MediaRow) {
  if (row.contentIdentifier === null) return Promise.resolve([row]);
  return db
    .select()
    .from(media)
    .where(and(eq(media.projectId, row.projectId), eq(media.contentIdentifier, row.contentIdentifier)));
}

async function loadMediaDto(db: Db, id: string): Promise<Media> {
  const row = await findMedia(db, id);
  return mediaDto(row, await liveGroup(db, row), await latestAnalyses(db, [row.id]));
}

export const mediaRoutes: FastifyPluginAsyncZod<ApiDeps> = async (app, { db, dataDir, freeBytes, enqueueIngest }) => {
  await app.register(fastifyStatic, { root: dataDir, serve: false });

  // The upload body is the file itself, so this scope reads the raw stream instead of parsing it.
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', (_request, _payload, done) => done(null));

    scope.withTypeProvider<ZodTypeProvider>().post(
      '/api/projects/:id/media',
      { schema: { params: IdParams, querystring: UploadMediaQuery, response: { 201: Media } } },
      async (request, reply) => {
        const projectId = request.params.id;
        const { filename, lastModified } = request.query;
        const ext = extensionOf(filename);
        const kind = kindFromExtension(ext);
        if (!kind) throw new HttpError(400, 'UNSUPPORTED_FILE', `不支援的檔案格式：${filename}`);

        const size = Number(request.headers['content-length']);
        if (!Number.isInteger(size) || size <= 0) throw new HttpError(411, 'LENGTH_REQUIRED', '缺少檔案大小');
        if (size > MAX_UPLOAD_BYTES) throw new HttpError(413, 'FILE_TOO_LARGE', '單檔上限 4 GB');

        const [project] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId));
        if (!project) throw new HttpError(404, 'NOT_FOUND', '找不到專案');
        if ((await freeBytes()) < size + MIN_FREE_BYTES) {
          throw new HttpError(507, 'INSUFFICIENT_STORAGE', '磁碟空間不足，至少要留下檔案大小再加 2 GB');
        }

        const id = randomUUID();
        const { original } = mediaPaths(dataDir, { projectId, id, ext });
        let received: { sha256: string; sizeBytes: number };
        try {
          received = await receiveFile(request.raw, original);
        } catch {
          throw new HttpError(400, 'UPLOAD_ABORTED', '上傳中斷');
        }

        const inserted = await db
          .insert(media)
          .values({
            id,
            projectId,
            kind,
            filename,
            ext,
            mimeType: request.headers['content-type'] || null,
            sizeBytes: received.sizeBytes,
            fileLastModified: lastModified === undefined ? null : new Date(lastModified),
            sha256: received.sha256,
          })
          .onConflictDoNothing({ target: [media.projectId, media.sha256] })
          .returning()
          .catch(async (error: unknown) => {
            await rm(original, { force: true });
            throw error;
          });

        const row = inserted[0];
        if (!row) {
          await rm(original, { force: true });
          const [existing] = await db
            .select({ id: media.id, filename: media.filename })
            .from(media)
            .where(and(eq(media.projectId, projectId), eq(media.sha256, received.sha256)));
          throw new HttpError(409, 'DUPLICATE', `與 ${existing?.filename} 重複`, { mediaId: existing?.id });
        }
        enqueueIngest(row.id);
        return reply.code(201).send(mediaDto(row, [row]));
      },
    );
  });

  app.get('/api/projects/:id/media', { schema: { params: IdParams, response: { 200: z.array(Media) } } }, async (request) => {
    const [project] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, request.params.id));
    if (!project) throw new HttpError(404, 'NOT_FOUND', '找不到專案');
    const rows = await db.select().from(media).where(eq(media.projectId, request.params.id));
    return visibleMedia(rows, await latestAnalyses(db, rows.map((row) => row.id)));
  });

  app.get('/api/media/:id', { schema: { params: IdParams, response: { 200: Media } } }, (request) =>
    loadMediaDto(db, request.params.id),
  );

  async function readyPaths(id: string) {
    const row = await findMedia(db, id);
    if (row.status !== 'ready') throw new HttpError(404, 'NOT_READY', '素材還沒處理完成');
    return { row, paths: mediaPaths(dataDir, row) };
  }

  app.get('/api/media/:id/preview', { schema: { params: IdParams } }, async (request, reply) => {
    const { row, paths } = await readyPaths(request.params.id);
    const file = row.kind === 'video' ? paths.preview : paths.photo;
    return reply.sendFile(path.basename(file), paths.derived);
  });

  app.get('/api/media/:id/thumb', { schema: { params: IdParams } }, async (request, reply) => {
    const { paths } = await readyPaths(request.params.id);
    return reply.sendFile(path.basename(paths.thumb), paths.derived);
  });

  app.patch(
    '/api/media/:id',
    { schema: { params: IdParams, body: PatchMediaBody, response: { 200: Media } } },
    async (request) => {
      const updated = await db
        .update(media)
        .set({ ...request.body, updatedAt: sql`now()` })
        .where(eq(media.id, request.params.id))
        .returning({ id: media.id });
      if (updated.length === 0) throw notFound();
      return loadMediaDto(db, request.params.id);
    },
  );

  app.post('/api/media/:id/retry', { schema: { params: IdParams, response: { 200: Media } } }, async (request) => {
    const { id } = request.params;
    const moved = await transitionMedia(db, id, { from: 'failed', to: 'uploaded' }, { error: null });
    if (moved.length === 0) {
      await findMedia(db, id);
      throw new HttpError(409, 'NOT_FAILED', '只有處理失敗的素材可以重試');
    }
    enqueueIngest(id);
    return loadMediaDto(db, id);
  });

  app.delete('/api/media/:id', { schema: { params: IdParams } }, async (request, reply) => {
    const removed = await db.transaction(async (tx) => {
      const [row] = await tx.select().from(media).where(eq(media.id, request.params.id)).for('update');
      if (!row) throw notFound();
      const group =
        row.contentIdentifier === null
          ? [row]
          : await tx
              .select()
              .from(media)
              .where(and(eq(media.projectId, row.projectId), eq(media.contentIdentifier, row.contentIdentifier)))
              .for('update');
      if (group.some((m) => isMediaBusy(m.status))) throw busy();
      await assertProjectIdle(tx, row.projectId);
      await tx.delete(media).where(inArray(media.id, group.map((m) => m.id)));
      return group;
    });
    await Promise.all(
      removed.flatMap((row) => {
        const paths = mediaPaths(dataDir, row);
        return [rm(paths.original, { force: true }), rm(paths.derived, { recursive: true, force: true })];
      }),
    );
    return reply.code(204).send();
  });
};
