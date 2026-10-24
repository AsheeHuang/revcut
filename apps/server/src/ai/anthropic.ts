import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { BetaContentBlockParam, BetaMessage, BetaUsage } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { Effort } from '../config';
import { apiFailure, type ProviderReply, type VisionAnalyzer, visionAnalyzer } from './analyzer';
import { AnalysisResult, type Part, SYSTEM_PROMPT } from './contract';
import type { Frame } from './frames';
import type { Usage } from './pricing';

const MAX_TOKENS = 64_000;
// SPEC §7.1. Frames are at most 640px, well under the 2000px cap for requests over 20 images.
const LIMITS = { maxImages: 600, maxRequestBytes: 32 * 1024 ** 2 };

// Only the schema goes out: with zodOutputFormat itself the SDK parses the answer inside
// finalMessage() and throws on a truncated one before stop_reason can be checked.
const OUTPUT_FORMAT = { type: 'json_schema' as const, schema: zodOutputFormat(AnalysisResult).schema };

const toBlock = (part: Part<Frame>): BetaContentBlockParam =>
  part.type === 'text'
    ? { type: 'text', text: part.text }
    : { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: part.frame.jpeg.toString('base64') } };

type TokenCounts = Pick<BetaUsage, 'input_tokens' | 'output_tokens' | 'cache_read_input_tokens' | 'cache_creation_input_tokens'>;

function toUsage(counts: TokenCounts): Usage {
  const cacheReadTokens = counts.cache_read_input_tokens ?? 0;
  const cacheWriteTokens = counts.cache_creation_input_tokens ?? 0;
  return {
    inputTokens: counts.input_tokens + cacheReadTokens + cacheWriteTokens,
    outputTokens: counts.output_tokens,
    cacheReadTokens,
    cacheWriteTokens,
  };
}

// usage.iterations has one entry per model that ran when a fallback happened; top-level usage covers only the last.
function toReply(message: BetaMessage, requestedModel: string): ProviderReply {
  const iterations = (message.usage.iterations ?? []).flatMap((entry) =>
    entry.type === 'message' || entry.type === 'fallback_message' ? [{ model: entry.model ?? requestedModel, usage: toUsage(entry) }] : [],
  );
  const attempts = iterations.length > 0 ? iterations : [{ model: message.model, usage: toUsage(message.usage) }];
  const reply = { servedModel: message.model, attempts };

  if (message.stop_reason === 'refusal') {
    const category = message.stop_details?.category;
    return { ...reply, outcome: { ok: false, message: `Claude 拒絕分析這批素材${category ? `（${category}）` : ''}` } };
  }
  if (message.stop_reason === 'max_tokens' || message.stop_reason === 'model_context_window_exceeded') {
    return { ...reply, outcome: { ok: false, message: 'Claude 的輸出被截斷，請減少素材再試' } };
  }
  // After a mid-stream fallback the declined model's partial text stays before the fallback block.
  const answer = message.content.slice(message.content.findLastIndex((block) => block.type === 'fallback') + 1);
  const text = answer.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
  return { ...reply, outcome: { ok: true, text } };
}

export function anthropicAnalyzer({
  apiKey,
  model,
  effort,
  fetch,
}: {
  apiKey: string;
  model: string;
  effort: Effort;
  fetch?: typeof globalThis.fetch;
}): VisionAnalyzer {
  const client = new Anthropic({ apiKey, ...(fetch && { fetch }) });
  return visionAnalyzer({
    provider: 'anthropic',
    model,
    effort,
    limits: LIMITS,
    // SPEC §7.5: ⌈w/28⌉ × ⌈h/28⌉ tokens per image.
    imageTokens: (width, height) => Math.ceil(width / 28) * Math.ceil(height / 28),
    async send(parts, signal) {
      try {
        const message = await client.beta.messages
          .stream(
            {
              model,
              max_tokens: MAX_TOKENS,
              thinking: { type: 'adaptive' },
              output_config: { effort, format: OUTPUT_FORMAT },
              betas: ['server-side-fallback-2026-07-01'],
              fallbacks: 'default',
              system: SYSTEM_PROMPT,
              messages: [{ role: 'user', content: parts.map(toBlock) }],
            },
            { signal },
          )
          .finalMessage();
        return toReply(message, model);
      } catch (error) {
        if (signal.aborted || !(error instanceof Anthropic.APIError)) throw error;
        throw apiFailure('Claude', error.status);
      }
    },
  });
}
