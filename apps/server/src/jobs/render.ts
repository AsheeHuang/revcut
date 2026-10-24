import { mkdir, rename, rm, stat } from 'node:fs/promises';
import type { ClipSource } from '@revcut/composition/props';
import { computeTiming, framesToSec, type RenderTransition, sliceWindow, Timeline, validateTimeline } from '@revcut/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import PQueue from 'p-queue';
import { loadTimelineContext } from '../api/timelineContext';
import type { Db } from '../db/client';
import { transitionRender } from '../db/renderState';
import { renders } from '../db/schema';
import type { RenderVideo } from '../render/remotion';
import { cutSlice, sliceSize } from '../render/slice';
import { MIN_FREE_BYTES } from '../storage/disk';
import { mediaPaths, renderPaths } from '../storage/paths';
import { removeRenderStrays } from '../storage/upload';

const TIMEOUT_MS = 60 * 60_000;
const BROWSER_FAILED = /launch the browser/i;

class RenderFailure extends Error {}

type Step = 'preparing' | 'rendering';
const failedFrom = (step: Step): RenderTransition =>
  step === 'preparing' ? { from: 'preparing', to: 'failed' } : { from: 'rendering', to: 'failed' };

function failureMessage(error: unknown, step: Step, timedOut: boolean): string {
  if (error instanceof RenderFailure) return error.message;
  if (timedOut) return '匯出逾時（超過 60 分鐘）';
  if (step === 'preparing') return '準備片段失敗';
  if (error instanceof Error && BROWSER_FAILED.test(error.message)) {
    return 'Remotion 的瀏覽器無法啟動，請安裝 README 列出的 Chrome 系統套件';
  }
  return '算圖失敗';
}

export function createRenderQueue({
  db,
  dataDir,
  baseUrl,
  freeBytes,
  renderVideo,
  log,
}: {
  db: Db;
  dataDir: string;
  baseUrl: string;
  freeBytes: () => Promise<number>;
  renderVideo: RenderVideo;
  log: Pick<FastifyBaseLogger, 'info' | 'error'>;
}) {
  const queue = new PQueue({ concurrency: 1 });
  const shutdown = new AbortController();

  // SPEC §6.5. Everything a run writes stays in renders/{id}.tmp/ until the finished MP4 is
  // renamed into place, so a rerun after any crash starts clean and ends in the same state.
  async function render(id: string) {
    const [row] = await transitionRender(db, id, { from: 'queued', to: 'preparing' }, { progress: 0, error: null });
    if (!row) return;
    const signal = AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), shutdown.signal]);
    const paths = renderPaths(dataDir, row.projectId, id);
    let step: Step = 'preparing';
    let progressWrites = Promise.resolve();
    const setProgress = (progress: number) => {
      const during = step;
      progressWrites = progressWrites.then(async () => {
        await db
          .update(renders)
          .set({ progress })
          .where(and(eq(renders.id, id), eq(renders.state, during)));
      });
    };

    try {
      if ((await freeBytes()) < MIN_FREE_BYTES) throw new RenderFailure('磁碟空間不足，匯出至少需要 2 GB');
      const timeline = Timeline.parse(row.snapshot);
      const { song, media, context } = await loadTimelineContext(db, row.projectId, timeline);
      const [problem] = validateTimeline(timeline, context).errors;
      if (problem || !song) throw new RenderFailure(problem?.message ?? '歌曲還沒分析完成');
      const timing = computeTiming(song.beats, timeline.music.startBeat, timeline.clips)!;
      const byId = new Map(media.map((item) => [item.id, item]));

      await rm(paths.tmp, { recursive: true, force: true });
      await mkdir(paths.tmp, { recursive: true });
      const sources: Record<string, ClipSource> = {};
      const videoCount = timeline.clips.filter((clip) => byId.get(clip.mediaId)!.kind === 'video').length;
      let cut = 0;
      for (const [k, clip] of timeline.clips.entries()) {
        const item = byId.get(clip.mediaId)!;
        const width = item.width!;
        const height = item.height!;
        if (item.kind === 'photo') {
          sources[clip.id] = { kind: 'photo', src: `${baseUrl}/api/media/${item.id}/preview`, startFromSec: 0, width, height };
          continue;
        }
        const window = sliceWindow(clip.sourceInSec, framesToSec(timing.clips[k]!.frames), item.durationSec!);
        const size = sliceSize(width, height, clip.crop.zoom);
        const source = mediaPaths(dataDir, item).original;
        await cutSlice({ source, window, size, hdr: item.isHdr === true, out: paths.slice(clip.id) }, signal);
        const src = `${baseUrl}/api/renders/${id}/slices/${clip.id}.mp4`;
        sources[clip.id] = { kind: 'video', src, startFromSec: window.startFromSec, ...size };
        setProgress(++cut / videoCount);
      }

      await progressWrites;
      await transitionRender(db, id, { from: 'preparing', to: 'rendering' }, { progress: 0 });
      step = 'rendering';
      let reported = 0;
      await renderVideo({
        props: { timeline, music: { src: `${baseUrl}/api/music/${song.id}/audio`, beats: song.beats }, sources },
        output: paths.draft,
        signal,
        onProgress: (progress) => {
          if (progress - reported < 0.01) return;
          reported = progress;
          setProgress(progress);
        },
      });
      await progressWrites;

      await rename(paths.draft, paths.output);
      const { size } = await stat(paths.output);
      await transitionRender(db, id, { from: 'rendering', to: 'done' }, { progress: 1, sizeBytes: size, finishedAt: new Date() });
      await rm(paths.tmp, { recursive: true, force: true });
    } catch (error) {
      if (shutdown.signal.aborted) return;
      log.error({ err: error, renderId: id, projectId: row.projectId, step }, 'timeline.render failed');
      await progressWrites.catch(() => {});
      await rm(paths.tmp, { recursive: true, force: true });
      const message = failureMessage(error, step, signal.aborted);
      await transitionRender(db, id, failedFrom(step), { error: message, finishedAt: new Date() });
    }
  }

  function enqueue(id: string) {
    queue
      .add(() => render(id))
      .catch((error: unknown) => {
        if (!shutdown.signal.aborted) log.error({ err: error, renderId: id }, 'timeline.render crashed');
      });
  }

  return {
    enqueue,

    // SPEC §6.1: an export costs nothing to redo, so whatever a restart interrupted runs again.
    async recover() {
      const removed = await removeRenderStrays(dataDir);
      const restarts = [
        { from: 'preparing', to: 'queued' },
        { from: 'rendering', to: 'queued' },
      ] as const satisfies readonly RenderTransition[];
      await db
        .update(renders)
        .set({ state: 'queued', progress: 0 })
        .where(inArray(renders.state, restarts.map((restart) => restart.from)));
      const pending = await db
        .select({ id: renders.id })
        .from(renders)
        .where(eq(renders.state, 'queued'))
        .orderBy(renders.createdAt);
      for (const { id } of pending) enqueue(id);
      log.info({ removedStrays: removed.length, requeued: pending.length }, 'timeline.render recovered');
    },

    idle: () => queue.onIdle(),

    // Leaves an interrupted render where it was; the next start puts it back in the queue.
    async close() {
      queue.clear();
      shutdown.abort();
      await queue.onIdle();
    },
  };
}
