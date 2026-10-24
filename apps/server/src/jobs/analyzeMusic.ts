import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { Energy, type MusicTransition, SECTION_ERROR_MESSAGES, suggestSection } from '@revcut/shared';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import PQueue from 'p-queue';
import { z } from 'zod';
import { repoRoot } from '../config';
import type { Db } from '../db/client';
import { transitionMusic } from '../db/musicStatus';
import { musicTracks } from '../db/schema';
import { runProcess } from '../process';
import { musicPaths } from '../storage/paths';
import { removeMusicStrays } from '../storage/upload';

const TIMEOUT_MS = 15 * 60_000;

export type AnalyzeBeats = (wavPath: string, signal: AbortSignal) => Promise<string>;

export const analyzeBeatsWithUv: AnalyzeBeats = async (wavPath, signal) =>
  (
    await runProcess(
      'uv',
      ['run', '--project', path.join(repoRoot, 'analyzer'), 'python', '-m', 'analyzer', 'beats', '--input', wavPath],
      { signal },
    )
  ).stdout;

const increasing = (values: number[]) => values.every((value, i) => i === 0 || value > values[i - 1]!);

const BeatsOutput = z
  .object({
    bpm: z.number().positive().nullable(),
    beats: z.array(z.number().nonnegative()).refine(increasing, '拍點必須遞增'),
    downbeatIndices: z.array(z.number().int().nonnegative()).refine(increasing, '重拍索引必須遞增'),
    energy: Energy,
  })
  .refine((output) => output.downbeatIndices.every((index) => index < output.beats.length), '重拍索引超出拍點範圍');

class AnalyzeFailure extends Error {}

export function createMusicQueue({
  db,
  dataDir,
  analyzeBeats,
  log,
}: {
  db: Db;
  dataDir: string;
  analyzeBeats: AnalyzeBeats;
  log: Pick<FastifyBaseLogger, 'info' | 'error'>;
}) {
  const queue = new PQueue({ concurrency: 1 });
  const shutdown = new AbortController();

  // SPEC §6.3. The decoded wav lives in music/{id}.tmp/, which a rerun recreates from the upload.
  async function analyze(id: string) {
    const [row] = await transitionMusic(db, id, { from: 'uploaded', to: 'analyzing' }, { error: null });
    if (!row) return;
    const signal = AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), shutdown.signal]);
    const paths = musicPaths(dataDir, row);
    let step = '解碼音樂';
    try {
      await rm(paths.tmp, { recursive: true, force: true });
      await mkdir(paths.tmp, { recursive: true });
      await runProcess('ffmpeg', ['-v', 'error', '-i', paths.file, '-vn', '-ac', '1', '-ar', '44100', paths.wav], { signal });
      const probe = await runProcess('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', paths.wav], {
        signal,
      });

      step = '拍點分析';
      const stdout = await analyzeBeats(paths.wav, signal);
      const output = BeatsOutput.parse(JSON.parse(stdout.trim().split('\n').at(-1) ?? ''));
      const section = suggestSection(output.beats, output.downbeatIndices, output.energy);
      if (!section.ok) throw new AnalyzeFailure(SECTION_ERROR_MESSAGES[section.error]);

      await transitionMusic(
        db,
        id,
        { from: 'analyzing', to: 'ready' },
        {
          durationSec: Number(probe.stdout),
          bpm: output.bpm,
          beats: output.beats,
          downbeatIndices: output.downbeatIndices,
          energy: output.energy.values,
        },
      );
    } catch (error) {
      if (shutdown.signal.aborted) return;
      log.error({ err: error, trackId: id, step }, 'music.analyze failed');
      const message =
        error instanceof AnalyzeFailure ? error.message : signal.aborted ? '分析逾時（超過 15 分鐘）' : `${step}失敗`;
      await transitionMusic(db, id, { from: 'analyzing', to: 'failed' }, { error: message });
    } finally {
      await rm(paths.tmp, { recursive: true, force: true });
    }
  }

  function enqueue(id: string) {
    queue
      .add(() => analyze(id))
      .catch((error: unknown) => log.error({ err: error, trackId: id }, 'music.analyze crashed'));
  }

  return {
    enqueue,

    async recover() {
      const removed = await removeMusicStrays(dataDir);
      const restart = { from: 'analyzing', to: 'uploaded' } as const satisfies MusicTransition;
      await db.update(musicTracks).set({ status: restart.to }).where(eq(musicTracks.status, restart.from));
      const pending = await db
        .select({ id: musicTracks.id })
        .from(musicTracks)
        .where(eq(musicTracks.status, 'uploaded'))
        .orderBy(musicTracks.createdAt);
      for (const { id } of pending) enqueue(id);
      log.info({ removedStrays: removed.length, requeued: pending.length }, 'music.analyze recovered');
    },

    idle: () => queue.onIdle(),

    // Leaves an interrupted track in analyzing; the next start puts it back in the queue.
    async close() {
      queue.clear();
      shutdown.abort();
      await queue.onIdle();
    },
  };
}
