import { describe, expect, it } from 'vitest';
import { fixture, json, replay } from '../test/aiFetch';
import { AiFailure } from './analyzer';
import { buildItems, SYSTEM_PROMPT } from './contract';
import { openaiAnalyzer } from './openai';

const media = [
  { id: '11111111-1111-4111-8111-111111111111', kind: 'photo' as const, durationSec: null, capturedAt: '2026-01-18T20:07:19+08:00' },
  { id: '22222222-2222-4222-8222-222222222222', kind: 'video' as const, durationSec: 6, capturedAt: '2026-01-31T16:56:41+08:00' },
];
const frame = (t: number, bytes: string) => ({ t, jpeg: Buffer.from(bytes), width: 360, height: 640 });
const items = buildItems(media, (item) => (item.kind === 'photo' ? [frame(0, 'photo')] : [frame(1.5, 'early'), frame(4.5, 'late')]));
const never = new AbortController().signal;

function analyzer(responses: (() => Response)[]) {
  const recorded = replay(responses);
  return { ...recorded, analyzer: openaiAnalyzer({ apiKey: 'test-key', model: 'gpt-6-astra', effort: 'medium', fetch: recorded.fetch }) };
}

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('expected the analysis to fail');
    },
    (error: unknown) => {
      if (!(error instanceof AiFailure)) throw error;
      return error;
    },
  );

describe('openaiAnalyzer', () => {
  it('sends one Responses request with data-URL images, a strict JSON schema, the reasoning effort, and no storage', async () => {
    const { analyzer: gpt, sent } = analyzer([json(fixture('openai-success.json'))]);
    await gpt.analyze(items, never);

    expect(sent).toHaveLength(1);
    const [{ url, body }] = sent as [(typeof sent)[number]];
    expect(url).toMatch(/\/responses$/);
    expect(body).toMatchObject({
      model: 'gpt-6-astra',
      instructions: SYSTEM_PROMPT,
      reasoning: { effort: 'medium' },
      max_output_tokens: 64000,
      store: false,
      text: { format: { type: 'json_schema', name: 'analysis', strict: true } },
    });
    const content = (body.input as { content: unknown[] }[])[0]!.content;
    expect(content.slice(0, 5)).toEqual([
      { type: 'input_text', text: '素材 m1｜照片｜2026-01-18 20:07' },
      { type: 'input_image', detail: 'high', image_url: `data:image/jpeg;base64,${Buffer.from('photo').toString('base64')}` },
      { type: 'input_text', text: '素材 m2｜影片｜6.0 秒｜2026-01-31 16:56' },
      { type: 'input_text', text: 't=1.5s' },
      { type: 'input_image', detail: 'high', image_url: `data:image/jpeg;base64,${Buffer.from('early').toString('base64')}` },
    ]);
  });

  it('returns the validated answer, the served model, its usage, and its cost with cache reads at their own rate', async () => {
    const output = await analyzer([json(fixture('openai-success.json'))]).analyzer.analyze(items, never);
    expect(output.result.media.map((verdict) => verdict.ref)).toEqual(['m1', 'm2']);
    expect(output.servedModel).toBe('gpt-6-astra');
    expect(output.usage).toEqual({ inputTokens: 12000, outputTokens: 2500, cacheReadTokens: 2000, cacheWriteTokens: 0 });
    expect(output.costUsd).toBeCloseTo((10000 * 10 + 2000 * 1 + 2500 * 50) / 1e6, 10);
  });

  it('replays the recorded GPT-6 Astra analysis of nine media, billing its automatic cache write', async () => {
    const output = await analyzer([json(fixture('openai-recorded.json'))]).analyzer.analyze(items, never);
    expect(output.result.media.map((verdict) => verdict.ref)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9']);
    expect(output.servedModel).toBe('gpt-6-astra');
    expect(output.usage).toEqual({ inputTokens: 10674, outputTokens: 1216, cacheReadTokens: 0, cacheWriteTokens: 10671 });
    expect(output.costUsd).toBeCloseTo((3 * 10 + 10671 * 12.5 + 1216 * 50) / 1e6, 10);
  });

  it('fails with OpenAI’s words when the model refuses', async () => {
    const error = await failure(analyzer([json(fixture('openai-refusal.json'))]).analyzer.analyze(items, never));
    expect(error.message).toBe("OpenAI 拒絕分析這批素材：I'm sorry, I can't help with that.");
    expect(error.spent?.usage.outputTokens).toBe(50);
  });

  it('fails when the answer stopped at max_output_tokens', async () => {
    const error = await failure(analyzer([json(fixture('openai-incomplete.json'))]).analyzer.analyze(items, never));
    expect(error.message).toBe('OpenAI 的輸出被截斷，請減少素材再試');
  });

  it('says the API key is invalid on a 401', async () => {
    const unauthorized = json({ error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } }, 401);
    const error = await failure(analyzer([unauthorized]).analyzer.analyze(items, never));
    expect(error.message).toBe('OpenAI 的 API key 無效或沒有權限');
  });

  it('estimates ⌈w/32⌉ × ⌈h/32⌉ patches at 1.2 tokens per image', () => {
    expect(analyzer([]).analyzer.imageTokens(640, 360)).toBe(288);
    expect(analyzer([]).analyzer.imageTokens(360, 640)).toBe(288);
  });
});
