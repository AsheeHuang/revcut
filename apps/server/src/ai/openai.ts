import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import type { Response, ResponseInputContent } from 'openai/resources/responses/responses';
import type { Effort } from '../config';
import { apiFailure, type ProviderReply, type VisionAnalyzer, visionAnalyzer } from './analyzer';
import { AnalysisResult, type Part, SYSTEM_PROMPT } from './contract';
import type { Frame } from './frames';

const MAX_OUTPUT_TOKENS = 64_000;
// developers.openai.com/api/docs/guides/images-vision (2026-10-24): up to 1,500 images and a
// 512 MB payload per request. A 640px frame is at most 400 patches, far under the 30,000 per image.
const LIMITS = { maxImages: 1500, maxRequestBytes: 512 * 1024 ** 2 };
// Same guide: GPT-6 Astra and the GPT-5.4+ models bill ⌈w/32⌉ × ⌈h/32⌉ patches at 1.2 tokens each.
const PATCH_PX = 32;
const PATCH_TOKENS = 1.2;

// create() leaves the answer unparsed, so a cut-off or refused response is reported before parsing.
const OUTPUT_FORMAT = zodTextFormat(AnalysisResult, 'analysis');

const toContent = (part: Part<Frame>): ResponseInputContent =>
  part.type === 'text'
    ? { type: 'input_text', text: part.text }
    : { type: 'input_image', detail: 'high', image_url: `data:image/jpeg;base64,${part.frame.jpeg.toString('base64')}` };

const INCOMPLETE = {
  max_output_tokens: 'OpenAI 的輸出被截斷，請減少素材再試',
  content_filter: 'OpenAI 的內容過濾擋下了這批素材',
} as const;

function toReply(response: Response): ProviderReply {
  const usage = response.usage;
  const reply = {
    servedModel: response.model,
    attempts: [
      {
        model: response.model,
        usage: {
          inputTokens: usage?.input_tokens ?? 0,
          outputTokens: usage?.output_tokens ?? 0,
          cacheReadTokens: usage?.input_tokens_details.cached_tokens ?? 0,
          cacheWriteTokens: usage?.input_tokens_details.cache_write_tokens ?? 0,
        },
      },
    ],
  };
  if (response.status !== 'completed') {
    const reason = response.incomplete_details?.reason;
    const message =
      reason === 'max_output_tokens' || reason === 'content_filter' ? INCOMPLETE[reason] : `OpenAI 沒有完成分析（${reason ?? response.status}）`;
    return { ...reply, outcome: { ok: false, message } };
  }
  const content = response.output.flatMap((item) => (item.type === 'message' ? item.content : []));
  const refusal = content.find((part) => part.type === 'refusal');
  if (refusal) return { ...reply, outcome: { ok: false, message: `OpenAI 拒絕分析這批素材：${refusal.refusal}` } };
  const text = content.flatMap((part) => (part.type === 'output_text' ? [part.text] : [])).join('');
  return { ...reply, outcome: { ok: true, text } };
}

export function openaiAnalyzer({
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
  const client = new OpenAI({ apiKey, ...(fetch && { fetch }) });
  return visionAnalyzer({
    provider: 'openai',
    model,
    effort,
    limits: LIMITS,
    imageTokens: (width, height) => Math.ceil(Math.ceil(width / PATCH_PX) * Math.ceil(height / PATCH_PX) * PATCH_TOKENS),
    async send(parts, signal) {
      try {
        const response = await client.responses.create(
          {
            model,
            instructions: SYSTEM_PROMPT,
            input: [{ role: 'user', content: parts.map(toContent) }],
            text: { format: OUTPUT_FORMAT },
            reasoning: { effort },
            max_output_tokens: MAX_OUTPUT_TOKENS,
            // SPEC §7.6: nothing reads a response back, so OpenAI need not keep the frames.
            store: false,
          },
          { signal },
        );
        return toReply(response);
      } catch (error) {
        if (signal.aborted || !(error instanceof OpenAI.APIError)) throw error;
        throw apiFailure('OpenAI', error.status);
      }
    },
  });
}
