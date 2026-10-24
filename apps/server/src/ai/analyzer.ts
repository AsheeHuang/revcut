import type { AiProvider } from '@revcut/shared';
import type { Effort } from '../config';
import { type AnalysisItem, AnalysisResult, buildParts, type Part, SYSTEM_PROMPT } from './contract';
import type { Frame, FrameBudget } from './frames';
import { costUsd, type Usage } from './pricing';

export type Spend = { usage: Usage; costUsd: number | null };

export class AiFailure extends Error {
  constructor(
    message: string,
    readonly spent: Spend | null = null,
  ) {
    super(message);
  }
}

export type AnalysisOutput = Spend & { result: AnalysisResult; servedModel: string };

// SPEC §7.1. limits and imageTokens let the draft budget frames before it extracts them.
export interface VisionAnalyzer extends FrameBudget {
  provider: AiProvider;
  model: string;
  effort: Effort;
  analyze(items: AnalysisItem<Frame>[], signal: AbortSignal): Promise<AnalysisOutput>;
}

// With a fallback, each model that ran is one attempt, billed at its own rates.
export type ProviderReply = {
  servedModel: string;
  attempts: { model: string; usage: Usage }[];
  outcome: { ok: true; text: string } | { ok: false; message: string };
};

type ProviderSpec = Omit<VisionAnalyzer, 'analyze'> & {
  send: (parts: Part<Frame>[], signal: AbortSignal) => Promise<ProviderReply>;
};

const NOTHING_SPENT: Spend = { usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0 };

function addAttempts(spent: Spend, attempts: ProviderReply['attempts']): Spend {
  return attempts.reduce(
    ({ usage, costUsd: total }, attempt) => {
      const cost = costUsd(attempt.model, attempt.usage);
      return {
        usage: {
          inputTokens: usage.inputTokens + attempt.usage.inputTokens,
          outputTokens: usage.outputTokens + attempt.usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens + attempt.usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens + attempt.usage.cacheWriteTokens,
        },
        costUsd: total === null || cost === null ? null : total + cost,
      };
    },
    spent,
  );
}

function parseResult(text: string): AnalysisResult | null {
  try {
    const parsed = AnalysisResult.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const base64Length = (bytes: number) => Math.ceil(bytes / 3) * 4;

// SPEC §7.1, §7.4.
export function visionAnalyzer({ send, ...spec }: ProviderSpec): VisionAnalyzer {
  return {
    ...spec,
    async analyze(items, signal) {
      const parts = buildParts(items);
      let imageCount = 0;
      let requestBytes = Buffer.byteLength(SYSTEM_PROMPT);
      for (const part of parts) {
        if (part.type === 'image') imageCount++;
        requestBytes += part.type === 'image' ? base64Length(part.frame.jpeg.length) : Buffer.byteLength(part.text);
      }
      if (imageCount > spec.limits.maxImages || requestBytes > spec.limits.maxRequestBytes) {
        throw new AiFailure(`素材太多：${imageCount} 張畫面、${(requestBytes / 1024 ** 2).toFixed(1)} MB，超過單次分析的上限`);
      }

      let spent = NOTHING_SPENT;
      for (let attempt = 1; ; attempt++) {
        let reply: ProviderReply;
        try {
          reply = await send(parts, signal);
        } catch (error) {
          throw error instanceof AiFailure ? new AiFailure(error.message, spent) : error;
        }
        spent = addAttempts(spent, reply.attempts);
        if (!reply.outcome.ok) throw new AiFailure(reply.outcome.message, spent);
        const result = parseResult(reply.outcome.text);
        if (result) return { result, servedModel: reply.servedModel, ...spent };
        if (attempt === 2) throw new AiFailure('AI 回傳的格式不符', spent);
      }
    },
  };
}

// The SDKs' API errors carry the HTTP status; a missing status means the request never got an answer.
export function apiFailure(name: string, status: number | undefined): AiFailure {
  if (status === 401 || status === 403) return new AiFailure(`${name} 的 API key 無效或沒有權限`);
  if (status === 429) return new AiFailure(`${name} 流量限制或額度不足，請稍後再試`);
  if (status === undefined) return new AiFailure(`無法連線到 ${name}`);
  return new AiFailure(`${name} 回應錯誤（HTTP ${status}）`);
}
