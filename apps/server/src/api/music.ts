import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import {
  extensionOf,
  isMusicExtension,
  MAX_MUSIC_BYTES,
  MusicTrack,
  MusicTrackDetail,
  PatchMusicBody,
  titleFromFilename,
  UploadMusicQuery,
} from '@revcut/shared';
import { desc, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod, ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { HttpError } from '../app';
import type { Db } from '../db/client';
import { transitionMusic } from '../db/musicStatus';
import { musicTracks } from '../db/schema';
import { MIN_FREE_BYTES } from '../storage/disk';
import { musicPaths } from '../storage/paths';
import { receiveFile } from '../storage/upload';
import type { ApiDeps } from './deps';
import { musicDetailDto, musicDto } from './dto';
import { IdParams } from './projects';

const notFound = () => new HttpError(404, 'NOT_FOUND', '找不到曲目');

async function findTrack(db: Db, id: string) {
  const [row] = await db.select().from(musicTracks).where(eq(musicTracks.id, id));
  if (!row) throw notFound();
  return row;
}

export const musicRoutes: FastifyPluginAsyncZod<ApiDeps> = async (app, { db, dataDir, freeBytes, enqueueAnalyze }) => {
  await app.register(fastifyStatic, { root: dataDir, serve: false });

  // The upload body is the file itself, so this scope reads the raw stream instead of parsing it.
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', (_request, _payload, done) => done(null));

    scope.withTypeProvider<ZodTypeProvider>().post(
      '/api/music',
      { schema: { querystring: UploadMusicQuery, response: { 201: MusicTrack } } },
      async (request, reply) => {
        const { filename } = request.query;
        if (!isMusicExtension(filename)) throw new HttpError(400, 'UNSUPPORTED_FILE', `不支援的檔案格式：${filename}`);

        const size = Number(request.headers['content-length']);
        if (!Number.isInteger(size) || size <= 0) throw new HttpError(411, 'LENGTH_REQUIRED', '缺少檔案大小');
        if (size > MAX_MUSIC_BYTES) throw new HttpError(413, 'FILE_TOO_LARGE', '單檔上限 50 MB');
        if ((await freeBytes()) < size + MIN_FREE_BYTES) {
          throw new HttpError(507, 'INSUFFICIENT_STORAGE', '磁碟空間不足，至少要留下檔案大小再加 2 GB');
        }

        const id = randomUUID();
        const ext = extensionOf(filename);
        const { file } = musicPaths(dataDir, { id, ext });
        let sizeBytes: number;
        try {
          ({ sizeBytes } = await receiveFile(request.raw, file));
        } catch {
          throw new HttpError(400, 'UPLOAD_ABORTED', '上傳中斷');
        }

        const [row] = await db
          .insert(musicTracks)
          .values({ id, title: titleFromFilename(filename), filename, ext, sizeBytes })
          .returning()
          .catch(async (error: unknown) => {
            await rm(file, { force: true });
            throw error;
          });
        enqueueAnalyze(id);
        return reply.code(201).send(musicDto(row!));
      },
    );
  });

  app.get('/api/music', { schema: { response: { 200: z.array(MusicTrack) } } }, async () =>
    (await db.select().from(musicTracks).orderBy(desc(musicTracks.createdAt))).map(musicDto),
  );

  app.get('/api/music/:id', { schema: { params: IdParams, response: { 200: MusicTrackDetail } } }, async (request) =>
    musicDetailDto(await findTrack(db, request.params.id)),
  );

  app.get('/api/music/:id/audio', { schema: { params: IdParams } }, async (request, reply) => {
    const { file } = musicPaths(dataDir, await findTrack(db, request.params.id));
    return reply.sendFile(path.basename(file), path.dirname(file));
  });

  app.patch(
    '/api/music/:id',
    { schema: { params: IdParams, body: PatchMusicBody, response: { 200: MusicTrack } } },
    async (request) => {
      const [row] = await db
        .update(musicTracks)
        .set({ ...request.body, updatedAt: sql`now()` })
        .where(eq(musicTracks.id, request.params.id))
        .returning();
      if (!row) throw notFound();
      return musicDto(row);
    },
  );

  app.post('/api/music/:id/retry', { schema: { params: IdParams, response: { 200: MusicTrack } } }, async (request) => {
    const { id } = request.params;
    const [row] = await transitionMusic(db, id, { from: 'failed', to: 'uploaded' }, { error: null });
    if (!row) {
      await findTrack(db, id);
      throw new HttpError(409, 'NOT_FAILED', '只有分析失敗的曲目可以重試');
    }
    enqueueAnalyze(id);
    return musicDto(row);
  });

  // SPEC §18 item 11: a song a timeline uses may be deleted; only a running analysis blocks it.
  app.delete('/api/music/:id', { schema: { params: IdParams } }, async (request, reply) => {
    const row = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(musicTracks).where(eq(musicTracks.id, request.params.id)).for('update');
      if (!locked) throw notFound();
      if (locked.status === 'analyzing') throw new HttpError(409, 'BUSY', '分析中，請稍後再刪');
      await tx.delete(musicTracks).where(eq(musicTracks.id, locked.id));
      return locked;
    });
    const paths = musicPaths(dataDir, row);
    await Promise.all([rm(paths.file, { force: true }), rm(paths.tmp, { recursive: true, force: true })]);
    return reply.code(204).send();
  });
};
