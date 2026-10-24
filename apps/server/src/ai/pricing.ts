export type Usage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };

// USD per million tokens. inputTokens counts every input token, cache reads and writes included.
type Price = {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  longContext?: { aboveInputTokens: number; inputMultiplier: number; outputMultiplier: number };
};

// Anthropic: claude-api skill model table (2026-10-06); 5-minute cache writes are 1.25x input.
// claude-opus-5 and claude-opus-4-8 are where fallbacks: "default" sends a declined request.
// OpenAI: developers.openai.com/api/docs/models/gpt-6-astra and /api/docs/pricing (2026-10-24).
const PRICES: Record<string, Price> = {
  'claude-opus-5-5': { input: 4, cacheRead: 0.2, cacheWrite: 5, output: 20 },
  'claude-opus-5': { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25 },
  'claude-opus-4-8': { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25 },
  'gpt-6-astra': {
    input: 10,
    cacheRead: 1,
    cacheWrite: 12.5,
    output: 50,
    longContext: { aboveInputTokens: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 },
  },
};

const priceOf = (model: string): Price | undefined => PRICES[model] ?? PRICES[model.replace(/-\d{4}-\d{2}-\d{2}$/, '')];

export function costUsd(model: string, usage: Usage): number | null {
  const price = priceOf(model);
  if (!price) return null;
  const long = price.longContext && usage.inputTokens > price.longContext.aboveInputTokens ? price.longContext : null;
  const inputScale = long?.inputMultiplier ?? 1;
  const uncached = usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens;
  const input = (uncached * price.input + usage.cacheReadTokens * price.cacheRead + usage.cacheWriteTokens * price.cacheWrite) * inputScale;
  const output = usage.outputTokens * price.output * (long?.outputMultiplier ?? 1);
  return (input + output) / 1e6;
}

// Thinking plus one JSON verdict per media; checked against the live runs recorded in SPEC §7.5.
const OUTPUT_TOKENS_BASE = 3000;
const OUTPUT_TOKENS_PER_MEDIA = 200;

export function estimateUsd(model: string, inputTokens: number, mediaCount: number): number | null {
  const outputTokens = OUTPUT_TOKENS_BASE + OUTPUT_TOKENS_PER_MEDIA * mediaCount;
  return costUsd(model, { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 });
}
