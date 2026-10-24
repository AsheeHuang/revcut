import { AiConfig, type AiProvider, DraftEstimate, DraftEstimateQuery } from '@revcut/shared';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { budgetFrames } from '../ai/frames';
import { estimateUsd } from '../ai/pricing';
import { aiConfig, type AiProviders } from '../ai/providers';
import { HttpError } from '../app';
import { findReusableRun } from '../db/analysis';
import { media, projects } from '../db/schema';
import type { ApiDeps } from './deps';
import { draftMedia } from './dto';
import { IdParams } from './projects';

export function configuredProvider(ai: AiProviders, requested: AiProvider | undefined): AiProvider {
  const provider = requested ?? aiConfig(ai).defaultProvider;
  if (!ai.analyzers[provider]) throw new HttpError(422, 'PROVIDER_NOT_CONFIGURED', `沒有設定 ${provider} 的 API key`);
  return provider;
}

export const aiRoutes: FastifyPluginAsyncZod<ApiDeps> = async (app, { db, ai }) => {
  app.get('/api/config', { schema: { response: { 200: AiConfig } } }, () => aiConfig(ai));

  // SPEC §6.4: what the next draft would send and cost; nothing when an earlier analysis covers it.
  app.get(
    '/api/projects/:id/draft-estimate',
    { schema: { params: IdParams, querystring: DraftEstimateQuery, response: { 200: DraftEstimate } } },
    async (request) => {
      const projectId = request.params.id;
      const [project] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId));
      if (!project) throw new HttpError(404, 'NOT_FOUND', '找不到專案');
      const provider = configuredProvider(ai, request.query.provider);
      const analyzer = ai.analyzers[provider]!;

      const usable = draftMedia(await db.select().from(media).where(eq(media.projectId, projectId)));
      const mediaIds = usable.map((item) => item.id);
      if (await findReusableRun(db, { projectId, provider, model: analyzer.model, mediaIds })) {
        return { reuse: true, estimatedUsd: 0, mediaCount: usable.length, imageCount: 0 };
      }
      const budget = budgetFrames(usable, analyzer);
      if (!budget) throw new HttpError(422, 'TOO_MANY_MEDIA', '素材太多：每支影片只送 2 張畫面，仍超過 AI 供應商單次分析的上限');
      return {
        reuse: false,
        estimatedUsd: estimateUsd(analyzer.model, budget.inputTokens, usable.length),
        mediaCount: usable.length,
        imageCount: budget.imageCount,
      };
    },
  );
};
