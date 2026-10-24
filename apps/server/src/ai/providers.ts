import { AI_PROVIDERS, type AiConfig, type AiProvider } from '@revcut/shared';
import type { Config } from '../config';
import type { VisionAnalyzer } from './analyzer';
import { anthropicAnalyzer } from './anthropic';
import { openaiAnalyzer } from './openai';

// Only a provider with an API key (and, for OpenAI, a model) gets an analyzer.
export type AiProviders = {
  preferred: AiProvider;
  models: Record<AiProvider, string>;
  analyzers: Partial<Record<AiProvider, VisionAnalyzer>>;
};

export function createAiProviders({ defaultProvider, anthropic, openai }: Config['ai']): AiProviders {
  return {
    preferred: defaultProvider,
    models: { anthropic: anthropic.model, openai: openai.model ?? '' },
    analyzers: {
      ...(anthropic.apiKey && { anthropic: anthropicAnalyzer({ apiKey: anthropic.apiKey, model: anthropic.model, effort: anthropic.effort }) }),
      ...(openai.apiKey && openai.model && { openai: openaiAnalyzer({ apiKey: openai.apiKey, model: openai.model, effort: openai.effort }) }),
    },
  };
}

// SPEC §7.1: AI_PROVIDER is the default while it is usable; otherwise the first provider that is.
export function aiConfig({ preferred, models, analyzers }: AiProviders): AiConfig {
  const available = AI_PROVIDERS.filter((id) => analyzers[id]);
  return {
    aiProviders: AI_PROVIDERS.map((id) => ({ id, model: models[id], available: available.includes(id) })),
    defaultProvider: analyzers[preferred] ? preferred : (available[0] ?? preferred),
  };
}
