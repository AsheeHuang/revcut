import { type AiProvider, type BusyDraftState, ENERGY_HOP_SEC, type Media, plan, type PlannerMedia } from '@revcut/shared';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import PQueue from 'p-queue';
import { AiFailure, type VisionAnalyzer } from '../ai/analyzer';
import { buildItems, resolveVerdicts } from '../ai/contract';
import { budgetFrames, extractFrames, type Frame } from '../ai/frames';
import type { AiProviders } from '../ai/providers';
import { draftMedia } from '../api/dto';
import { findReusableRun, runAnalyses } from '../db/analysis';
import type { Db } from '../db/client';
import { transitionDraft } from '../db/draftState';
import { analysisRuns, media, mediaAnalysis, musicTracks, projects, timelines } from '../db/schema';
import { mediaPaths } from '../storage/paths';

export type DraftRequest = {
  projectId: string;
  trackId: string;
  startBeat?: number;
  seed: number;
  provider: AiProvider;
  reanalyze: boolean;
};

class DraftFailure extends Error {}

const ANALYSIS_TIMEOUT_MS = 10 * 60_000;

const toPlannerMedia = ({ id, kind, capturedAt, durationSec }: Media): PlannerMedia => ({ id, kind, capturedAt, durationSec });

export function createDraftQueue({
  db,
  dataDir,
  ai,
  log,
}: {
  db: Db;
  dataDir: string;
  ai: AiProviders;
  log: Pick<FastifyBaseLogger, 'info' | 'error'>;
}) {
  const queue = new PQueue({ concurrency: 1 });
  const shutdown = new AbortController();

  // SPEC §6.4 step 1.
  async function analyze(
    projectId: string,
    items: Media[],
    files: Map<string, ReturnType<typeof mediaPaths>>,
    analyzer: VisionAnalyzer,
    signal: AbortSignal,
  ): Promise<string> {
    const budget = budgetFrames(items, analyzer);
    if (!budget) throw new DraftFailure('素材太多：每支影片只送 2 張畫面，仍超過 AI 供應商單次分析的上限');

    const [run] = await db
      .insert(analysisRuns)
      .values({
        projectId,
        mediaIds: items.map((item) => item.id),
        provider: analyzer.provider,
        model: analyzer.model,
        effort: analyzer.effort,
        status: 'running',
      })
      .returning({ id: analysisRuns.id });
    const runId = run!.id;
    try {
      const frames = new Map<string, Frame[]>();
      for (const [i, item] of items.entries()) {
        const paths = files.get(item.id)!;
        const file = item.kind === 'video' ? paths.preview : paths.photo;
        frames.set(item.id, await extractFrames({ kind: item.kind, file, durationSec: item.durationSec }, budget.counts[i]!, paths.analysis, signal));
      }
      const analysisItems = buildItems(items, (item) => frames.get(item.id)!);
      const output = await analyzer.analyze(analysisItems, signal);
      const analyses = resolveVerdicts(output.result, analysisItems);

      await db.transaction(async (tx) => {
        await tx
          .update(analysisRuns)
          .set({
            status: 'done',
            model: output.servedModel,
            inputTokens: output.usage.inputTokens,
            outputTokens: output.usage.outputTokens,
            costUsd: output.costUsd?.toFixed(4) ?? null,
            response: output.result,
          })
          .where(eq(analysisRuns.id, runId));
        await tx.insert(mediaAnalysis).values([...analyses].map(([mediaId, analysis]) => ({ analysisRunId: runId, mediaId, ...analysis })));
        const [planning] = await transitionDraft(tx, projectId, { from: 'analyzing', to: 'planning' });
        if (!planning) throw new Error('draft state changed while analyzing');
      });
      return runId;
    } catch (error) {
      const spent = error instanceof AiFailure ? error.spent : null;
      await db
        .update(analysisRuns)
        .set({
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
          inputTokens: spent?.usage.inputTokens ?? null,
          outputTokens: spent?.usage.outputTokens ?? null,
          costUsd: spent?.costUsd?.toFixed(4) ?? null,
        })
        .where(eq(analysisRuns.id, runId));
      throw error;
    }
  }

  // SPEC §6.4: analyzing (unless an earlier run covers every media) → planning → done.
  async function draft({ projectId, trackId, startBeat, seed, provider, reanalyze }: DraftRequest) {
    let state: BusyDraftState = 'queued';
    const timeout = AbortSignal.timeout(ANALYSIS_TIMEOUT_MS);
    try {
      const [track] = await db.select().from(musicTracks).where(eq(musicTracks.id, trackId));
      if (!track || track.status !== 'ready' || !track.beats || !track.downbeatIndices || !track.energy) {
        throw new DraftFailure('找不到歌曲，或歌曲還沒分析完成');
      }
      const analyzer = ai.analyzers[provider];
      if (!analyzer) throw new DraftFailure(`沒有設定 ${provider} 的 API key`);
      const rows = await db.select().from(media).where(eq(media.projectId, projectId));
      const usable = draftMedia(rows);
      const mediaIds = usable.map((item) => item.id);

      let runId = reanalyze ? null : await findReusableRun(db, { projectId, provider, model: analyzer.model, mediaIds });
      if (runId) {
        const [claimed] = await transitionDraft(db, projectId, { from: 'queued', to: 'planning' });
        if (!claimed) return;
        state = 'planning';
      } else {
        const [claimed] = await transitionDraft(db, projectId, { from: 'queued', to: 'analyzing' });
        if (!claimed) return;
        state = 'analyzing';
        const files = new Map(rows.map((row) => [row.id, mediaPaths(dataDir, row)]));
        runId = await analyze(projectId, usable, files, analyzer, AbortSignal.any([shutdown.signal, timeout]));
        state = 'planning';
      }

      const analyses = await runAnalyses(db, runId, mediaIds);
      const result = plan(
        {
          media: usable.map((item) => ({ ...toPlannerMedia(item), analysis: analyses.get(item.id) ?? null })),
          track: {
            id: track.id,
            beats: track.beats,
            downbeatIndices: track.downbeatIndices,
            energy: { hopSec: ENERGY_HOP_SEC, values: track.energy },
          },
          startBeat,
        },
        seed,
      );
      if (!result.ok) throw new DraftFailure(result.message);

      await db.transaction(async (tx) => {
        const [timeline] = await tx.insert(timelines).values({ projectId, analysisRunId: runId, seed, data: result.timeline }).returning();
        const [done] = await transitionDraft(tx, projectId, { from: 'planning', to: 'done' }, { currentTimelineId: timeline!.id });
        if (!done) throw new Error('draft state changed while planning');
      });
    } catch (error) {
      if (shutdown.signal.aborted) return;
      log.error({ err: error, projectId }, 'project.draft failed');
      const message =
        error instanceof DraftFailure || error instanceof AiFailure
          ? error.message
          : timeout.aborted
            ? 'AI 分析逾時（超過 10 分鐘）'
            : state === 'analyzing'
              ? 'AI 分析失敗'
              : '排版失敗';
      await transitionDraft(db, projectId, { from: state, to: 'failed' }, { draftError: message });
    }
  }

  return {
    enqueue(request: DraftRequest) {
      queue
        .add(() => draft(request))
        .catch((error: unknown) => {
          if (!shutdown.signal.aborted) log.error({ err: error, projectId: request.projectId }, 'project.draft crashed');
        });
    },

    // SPEC §6.1: a draft costs money, so one a restart interrupted fails instead of rerunning.
    async recover() {
      const interrupted = await db
        .update(projects)
        .set({ draftState: 'failed', draftError: '伺服器重啟中斷，請重試' })
        .where(inArray(projects.draftState, ['queued', 'analyzing', 'planning']))
        .returning({ id: projects.id });
      await db.update(analysisRuns).set({ status: 'failed', error: '伺服器重啟中斷' }).where(eq(analysisRuns.status, 'running'));
      log.info({ failed: interrupted.length }, 'project.draft recovered');
    },

    idle: () => queue.onIdle(),

    async close() {
      queue.clear();
      shutdown.abort();
      await queue.onIdle();
    },
  };
}
