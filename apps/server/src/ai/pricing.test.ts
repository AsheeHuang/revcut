import { describe, expect, it } from 'vitest';
import { costUsd, estimateUsd } from './pricing';

const usage = (inputTokens: number, outputTokens: number, cacheReadTokens = 0, cacheWriteTokens = 0) => ({
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheWriteTokens,
});

describe('costUsd', () => {
  it('prices Claude Opus 5.5 at $4 in and $20 out per million tokens', () => {
    expect(costUsd('claude-opus-5-5', usage(100_000, 10_000))).toBeCloseTo(0.6, 10);
  });

  it('prices the fallback models at their own rates', () => {
    expect(costUsd('claude-opus-4-8', usage(100_000, 10_000))).toBeCloseTo(0.75, 10);
    expect(costUsd('claude-opus-5', usage(100_000, 10_000))).toBeCloseTo(0.75, 10);
  });

  it('prices GPT-6 Astra at $10 in and $50 out, with cache reads and writes at their own rates', () => {
    expect(costUsd('gpt-6-astra', usage(100_000, 10_000))).toBeCloseTo(1.5, 10);
    expect(costUsd('gpt-6-astra', usage(100_000, 0, 40_000, 20_000))).toBeCloseTo((40_000 * 10 + 40_000 * 1 + 20_000 * 12.5) / 1e6, 10);
  });

  it('prices a whole GPT-6 Astra request over 272k input tokens at the long-context rates', () => {
    expect(costUsd('gpt-6-astra', usage(300_000, 10_000))).toBeCloseTo((300_000 * 20 + 10_000 * 75) / 1e6, 10);
  });

  it('reads a dated snapshot at its model’s price and knows nothing of other models', () => {
    expect(costUsd('gpt-6-astra-2026-08-27', usage(100_000, 0))).toBeCloseTo(1, 10);
    expect(costUsd('gpt-4o', usage(1e6, 0))).toBeNull();
  });
});

describe('estimateUsd', () => {
  it('prices the prompt as a cache write for GPT-6 Astra, which writes one on every request, and as plain input for Claude', () => {
    expect(estimateUsd('gpt-6-astra', 10_000, 9)! - estimateUsd('gpt-6-astra', 0, 9)!).toBeCloseTo((10_000 * 12.5) / 1e6, 10);
    expect(estimateUsd('claude-opus-5-5', 10_000, 9)! - estimateUsd('claude-opus-5-5', 0, 9)!).toBeCloseTo((10_000 * 4) / 1e6, 10);
  });

  it('adds the expected output of thinking plus one verdict per media to the input', () => {
    const inputOnly = costUsd('claude-opus-5-5', usage(20_000, 0))!;
    const estimate = estimateUsd('claude-opus-5-5', 20_000, 9)!;
    expect(estimate).toBeGreaterThan(inputOnly);
    expect(estimateUsd('claude-opus-5-5', 20_000, 80)!).toBeGreaterThan(estimate);
  });
});
