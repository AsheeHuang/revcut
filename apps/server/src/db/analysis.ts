import type { AiProvider, MediaAnalysis } from '@revcut/shared';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Db } from './client';
import { analysisRuns, mediaAnalysis } from './schema';

type AnalysisRow = typeof mediaAnalysis.$inferSelect;

const toAnalysis = ({ usable, score, description, moments, duplicateOf }: AnalysisRow): MediaAnalysis => ({
  usable,
  score,
  description,
  moments,
  duplicateOf,
});

// SPEC §6.4: the latest finished run of this provider and model is reused when it analyzed every media drafted now.
export async function findReusableRun(
  db: Db,
  { projectId, provider, model, mediaIds }: { projectId: string; provider: AiProvider; model: string; mediaIds: string[] },
): Promise<string | null> {
  const [latest] = await db
    .select({ id: analysisRuns.id, mediaIds: analysisRuns.mediaIds })
    .from(analysisRuns)
    .where(
      and(
        eq(analysisRuns.projectId, projectId),
        eq(analysisRuns.status, 'done'),
        eq(analysisRuns.provider, provider),
        eq(analysisRuns.model, model),
      ),
    )
    .orderBy(desc(analysisRuns.createdAt))
    .limit(1);
  if (!latest) return null;
  const analyzed = new Set(latest.mediaIds);
  return mediaIds.every((id) => analyzed.has(id)) ? latest.id : null;
}

// One run's analyses of the given media; a duplicate of a media outside them is no duplicate (SPEC §6.4).
export async function runAnalyses(db: Db, runId: string, mediaIds: string[]): Promise<Map<string, MediaAnalysis>> {
  const rows = await db
    .select()
    .from(mediaAnalysis)
    .where(and(eq(mediaAnalysis.analysisRunId, runId), inArray(mediaAnalysis.mediaId, mediaIds)));
  const ids = new Set(mediaIds);
  return new Map(
    rows.map((row) => [row.mediaId, { ...toAnalysis(row), duplicateOf: row.duplicateOf && ids.has(row.duplicateOf) ? row.duplicateOf : null }]),
  );
}

// SPEC §10.3: each media shows its analysis from the latest finished run that covered it.
export async function latestAnalyses(db: Db, mediaIds: string[]): Promise<Map<string, MediaAnalysis>> {
  if (mediaIds.length === 0) return new Map();
  const rows = await db
    .select({ analysis: mediaAnalysis })
    .from(mediaAnalysis)
    .innerJoin(analysisRuns, eq(analysisRuns.id, mediaAnalysis.analysisRunId))
    .where(and(eq(analysisRuns.status, 'done'), inArray(mediaAnalysis.mediaId, mediaIds)))
    .orderBy(desc(analysisRuns.createdAt));
  const latest = new Map<string, MediaAnalysis>();
  for (const { analysis } of rows) if (!latest.has(analysis.mediaId)) latest.set(analysis.mediaId, toAnalysis(analysis));
  return latest;
}
