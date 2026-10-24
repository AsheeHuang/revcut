import { z } from 'zod';
import { AiProvider } from './status';

const Score = z.number().int().min(1).max(10);
const Unit = z.number().min(0).max(1);

// SPEC §7.4 after post-processing: refs resolved to media ids and every number clamped into range.
export const Moment = z.object({ t: z.number().min(0), score: Score, focusX: Unit, focusY: Unit });
export type Moment = z.infer<typeof Moment>;

export const MediaAnalysis = z.object({
  usable: z.boolean(),
  score: Score,
  description: z.string(),
  moments: z.array(Moment),
  duplicateOf: z.uuid().nullable(),
});
export type MediaAnalysis = z.infer<typeof MediaAnalysis>;

export const AiProviderInfo = z.object({ id: AiProvider, model: z.string(), available: z.boolean() });
export type AiProviderInfo = z.infer<typeof AiProviderInfo>;

export const AiConfig = z.object({ aiProviders: z.array(AiProviderInfo), defaultProvider: AiProvider });
export type AiConfig = z.infer<typeof AiConfig>;

export const DraftEstimateQuery = z.object({ provider: AiProvider.optional() });

// estimatedUsd is null for a model without a known price.
export const DraftEstimate = z.object({
  reuse: z.boolean(),
  estimatedUsd: z.number().min(0).nullable(),
  mediaCount: z.number().int(),
  imageCount: z.number().int(),
});
export type DraftEstimate = z.infer<typeof DraftEstimate>;
