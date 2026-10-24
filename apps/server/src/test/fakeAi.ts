import type { AiProvider } from '@revcut/shared';
import { AiFailure, type AnalysisOutput, type VisionAnalyzer } from '../ai/analyzer';
import type { AnalysisItem, AnalysisResult } from '../ai/contract';
import type { Frame } from '../ai/frames';
import type { AiProviders } from '../ai/providers';

type Verdict = AnalysisResult['media'][number];

// A VisionAnalyzer that answers from a script instead of a provider, and keeps what it was asked.
export function fakeAnalyzer({
  provider = 'openai',
  model = provider === 'openai' ? 'gpt-6-astra' : 'claude-opus-5-5',
  verdict = () => ({}),
  fail,
  onAnalyze,
}: {
  provider?: AiProvider;
  model?: string;
  verdict?: (item: AnalysisItem<Frame>) => Partial<Verdict>;
  fail?: string;
  onAnalyze?: () => Promise<void>;
} = {}) {
  const calls: AnalysisItem<Frame>[][] = [];
  const analyzer: VisionAnalyzer = {
    provider,
    model,
    effort: 'medium',
    limits: { maxImages: 600, maxRequestBytes: 32 * 1024 ** 2 },
    imageTokens: () => 300,
    async analyze(items) {
      calls.push(items);
      await onAnalyze?.();
      const spent = { usage: { inputTokens: 12000, outputTokens: 2500, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0.245 };
      if (fail) throw new AiFailure(fail, spent);
      const media = items.map((item) => ({
        ref: item.ref,
        usable: true,
        score: 5,
        description: `素材 ${item.ref}`,
        moments: [{ t: item.kind === 'video' ? (item.durationSec ?? 0) / 2 : 0, score: 5, focusX: 0.5, focusY: 0.5 }],
        duplicateOf: null,
        ...verdict(item),
      }));
      return { result: { media }, servedModel: model, ...spent } satisfies AnalysisOutput;
    },
  };
  return { analyzer, calls };
}

export const providersWith = (...analyzers: VisionAnalyzer[]): AiProviders => ({
  preferred: 'anthropic',
  models: { anthropic: 'claude-opus-5-5', openai: 'gpt-6-astra' },
  analyzers: Object.fromEntries(analyzers.map((analyzer) => [analyzer.provider, analyzer])),
});
