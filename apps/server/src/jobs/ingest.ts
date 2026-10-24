import { mkdir, rename, rm } from 'node:fs/promises';
import type { MediaTransition } from '@revcut/shared';
import { eq, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import PQueue from 'p-queue';
import type { Db } from '../db/client';
import { transitionMedia } from '../db/mediaStatus';
import { media } from '../db/schema';
import { makePhotoDerivatives, makeVideoDerivatives } from '../media/derive';
import { isHdr, parseExiftool, parseFfprobe, resolveCaptureTime } from '../media/metadata';
import { runProcess } from '../process';
import { mediaPaths } from '../storage/paths';
import { removeStrays } from '../storage/upload';

const TIMEOUT_MS = 30 * 60_000;

class IngestFailure extends Error {}

async function readJson(command: string, args: string[], signal: AbortSignal): Promise<unknown> {
  return JSON.parse((await runProcess(command, args, { signal })).stdout);
}

export function createIngestQueue({
  db,
  dataDir,
  defaultTz,
  log,
}: {
  db: Db;
  dataDir: string;
  defaultTz: string;
  log: Pick<FastifyBaseLogger, 'info' | 'error'>;
}) {
  const queue = new PQueue({ concurrency: 2 });
  const shutdown = new AbortController();

  // SPEC §6.2. Outputs go to derived/{id}.tmp and replace derived/{id} in one rename,
  // so a rerun after any crash starts from the original and ends in the same state.
  async function ingest(id: string) {
    const [row] = await transitionMedia(db, id, { from: 'uploaded', to: 'processing' }, { error: null });
    if (!row) return;
    const signal = AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), shutdown.signal]);
    const paths = mediaPaths(dataDir, row);
    let step = '讀取檔案資訊';
    try {
      const exif = parseExiftool(await readJson('exiftool', ['-json', '-n', '-G1', paths.original], signal));
      const expected = row.kind === 'video' ? 'video/' : 'image/';
      if (!exif.mimeType?.startsWith(expected)) {
        throw new IngestFailure(row.kind === 'video' ? '檔案內容不是影片，請確認副檔名' : '檔案內容不是照片，請確認副檔名');
      }
      const video =
        row.kind === 'video'
          ? parseFfprobe(
              await readJson(
                'ffprobe',
                ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', paths.original],
                signal,
              ),
            )
          : null;
      const capture = resolveCaptureTime({
        tags: exif.captureTags,
        gps: exif.gps,
        fileLastModified: row.fileLastModified,
        defaultTz,
      });
      // Written before the derivatives so a photo that fails to convert still pairs with its Live Photo video.
      await db
        .update(media)
        .set({
          capturedAt: capture?.capturedAt ?? null,
          utcOffsetMin: capture?.utcOffsetMin ?? null,
          lat: exif.gps?.lat ?? null,
          lng: exif.gps?.lng ?? null,
          contentIdentifier: exif.contentIdentifier,
          updatedAt: sql`now()`,
        })
        .where(eq(media.id, id));

      await rm(paths.derivedTmp, { recursive: true, force: true });
      await mkdir(paths.derivedTmp, { recursive: true });
      let size: { width: number; height: number };
      if (video) {
        step = '產生預覽檔';
        await makeVideoDerivatives(paths.original, paths.derivedTmp, video, signal);
        size = video;
      } else {
        step = '產生照片';
        size = await makePhotoDerivatives(paths.original, row.ext, paths.derivedTmp);
      }
      await rm(paths.derived, { recursive: true, force: true });
      await rename(paths.derivedTmp, paths.derived);

      await transitionMedia(
        db,
        id,
        { from: 'processing', to: 'ready' },
        {
          width: size.width,
          height: size.height,
          durationSec: video?.durationSec ?? null,
          fps: video?.fps ?? null,
          isHdr: video ? isHdr(video.colorTransfer) : null,
          hasAudio: video?.hasAudio ?? null,
        },
      );
    } catch (error) {
      if (shutdown.signal.aborted) return;
      log.error({ err: error, mediaId: id, projectId: row.projectId, step }, 'media.ingest failed');
      await rm(paths.derivedTmp, { recursive: true, force: true });
      const message =
        error instanceof IngestFailure ? error.message : signal.aborted ? '處理逾時（超過 30 分鐘）' : `${step}失敗`;
      await transitionMedia(db, id, { from: 'processing', to: 'failed' }, { error: message });
    }
  }

  function enqueue(id: string) {
    queue
      .add(() => ingest(id))
      .catch((error: unknown) => log.error({ err: error, mediaId: id }, 'media.ingest crashed'));
  }

  return {
    enqueue,

    async recover() {
      const removed = await removeStrays(dataDir);
      const restart = { from: 'processing', to: 'uploaded' } as const satisfies MediaTransition;
      await db.update(media).set({ status: restart.to }).where(eq(media.status, restart.from));
      const pending = await db
        .select({ id: media.id })
        .from(media)
        .where(eq(media.status, 'uploaded'))
        .orderBy(media.createdAt);
      for (const { id } of pending) enqueue(id);
      log.info({ removedStrays: removed.length, requeued: pending.length }, 'media.ingest recovered');
    },

    idle: () => queue.onIdle(),

    // Leaves interrupted media in processing; the next start puts it back in the queue.
    async close() {
      queue.clear();
      shutdown.abort();
      await queue.onIdle();
    },
  };
}
