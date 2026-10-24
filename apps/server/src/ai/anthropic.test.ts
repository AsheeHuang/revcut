import { describe, expect, it } from 'vitest';
import { fixture, json, replay, sse } from '../test/aiFetch';
import { AiFailure } from './analyzer';
import { anthropicAnalyzer } from './anthropic';
import { buildItems, SYSTEM_PROMPT } from './contract';

const media = [
  { id: '11111111-1111-4111-8111-111111111111', kind: 'photo' as const, durationSec: null, capturedAt: '2026-01-18T20:07:19+08:00' },
  { id: '22222222-2222-4222-8222-222222222222', kind: 'video' as const, durationSec: 6, capturedAt: '2026-01-31T16:56:41+08:00' },
];
const frame = (t: number, bytes: string) => ({ t, jpeg: Buffer.from(bytes), width: 360, height: 640 });
const items = buildItems(media, (item) => (item.kind === 'photo' ? [frame(0, 'photo')] : [frame(1.5, 'early'), frame(4.5, 'late')]));
const never = new AbortController().signal;

function analyzer(responses: (() => Response)[]) {
  const recorded = replay(responses);
  return { ...recorded, analyzer: anthropicAnalyzer({ apiKey: 'test-key', model: 'claude-opus-5-5', effort: 'medium', fetch: recorded.fetch }) };
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

describe('anthropicAnalyzer', () => {
  it('streams one request with adaptive thinking, the configured effort, structured output, and default fallbacks', async () => {
    const { analyzer: claude, sent } = analyzer([sse(fixture('anthropic-success.json'))]);
    await claude.analyze(items, never);

    expect(sent).toHaveLength(1);
    const [{ url, headers, body }] = sent as [(typeof sent)[number]];
    expect(url).toContain('/v1/messages');
    expect(headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(body).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 64000,
      stream: true,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium', format: { type: 'json_schema' } },
      fallbacks: 'default',
      system: SYSTEM_PROMPT,
    });
    const schema = (body.output_config as { format: { schema: { required: string[] } } }).format.schema;
    expect(schema.required).toEqual(['media']);
    const content = (body.messages as { content: { type: string; text?: string; source?: unknown }[] }[])[0]!.content;
    expect(content.slice(0, 6)).toEqual([
      { type: 'text', text: '素材 m1｜照片｜2026-01-18 20:07' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: Buffer.from('photo').toString('base64') } },
      { type: 'text', text: '素材 m2｜影片｜6.0 秒｜2026-01-31 16:56' },
      { type: 'text', text: 't=1.5s' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: Buffer.from('early').toString('base64') } },
      { type: 'text', text: 't=4.5s' },
    ]);
    expect(content.at(-1)).toMatchObject({ type: 'text', text: expect.stringContaining('共 2 個素材') });
  });

  it('returns the validated answer, the model that served it, its usage, and its cost', async () => {
    const output = await analyzer([sse(fixture('anthropic-success.json'))]).analyzer.analyze(items, never);
    expect(output.result.media.map((verdict) => [verdict.ref, verdict.score])).toEqual([
      ['m1', 7],
      ['m2', 8],
    ]);
    expect(output.servedModel).toBe('claude-opus-5-5');
    expect(output.usage).toEqual({ inputTokens: 15000, outputTokens: 3000, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(output.costUsd).toBeCloseTo((15000 * 4 + 3000 * 20) / 1e6, 10);
  });

  it('after a mid-stream fallback, reads only the fallback model’s answer and bills each model at its own rates', async () => {
    const output = await analyzer([sse(fixture('anthropic-fallback.json'), 'claude-opus-5-5')]).analyzer.analyze(items, never);
    expect(output.servedModel).toBe('claude-opus-4-8');
    expect(output.result.media).toHaveLength(2);
    expect(output.usage).toMatchObject({ inputTokens: 30000, outputTokens: 3040 });
    expect(output.costUsd).toBeCloseTo((15000 * 4 + 40 * 20 + 15000 * 5 + 3000 * 25) / 1e6, 10);
  });

  it('fails with the reason when Claude refuses, and keeps what the refusal cost', async () => {
    const error = await failure(analyzer([sse(fixture('anthropic-refusal.json'))]).analyzer.analyze(items, never));
    expect(error.message).toBe('Claude 拒絕分析這批素材（bio）');
    expect(error.spent).toMatchObject({ usage: { inputTokens: 15000 }, costUsd: (15000 * 4) / 1e6 });
  });

  it('fails when the answer was cut off at max_tokens', async () => {
    const error = await failure(analyzer([sse(fixture('anthropic-truncated.json'))]).analyzer.analyze(items, never));
    expect(error.message).toBe('Claude 的輸出被截斷，請減少素材再試');
  });

  it('asks once more when the answer does not fit the schema, and counts both requests', async () => {
    const { analyzer: claude, sent } = analyzer([sse(fixture('anthropic-mismatch.json')), sse(fixture('anthropic-success.json'))]);
    const output = await claude.analyze(items, never);
    expect(sent).toHaveLength(2);
    expect(output.result.media).toHaveLength(2);
    expect(output.usage).toMatchObject({ inputTokens: 30000, outputTokens: 3500 });
  });

  it('gives up after a second answer that does not fit the schema', async () => {
    const { analyzer: claude, sent } = analyzer([sse(fixture('anthropic-mismatch.json')), sse(fixture('anthropic-mismatch.json'))]);
    const error = await failure(claude.analyze(items, never));
    expect(error.message).toBe('AI 回傳的格式不符');
    expect(sent).toHaveLength(2);
    expect(error.spent?.usage.outputTokens).toBe(1000);
  });

  it('says the API key is invalid on a 401', async () => {
    const unauthorized = json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401);
    const error = await failure(analyzer([unauthorized]).analyzer.analyze(items, never));
    expect(error.message).toBe('Claude 的 API key 無效或沒有權限');
  });

  it('refuses a request over 600 images without sending it', async () => {
    const { analyzer: claude, sent } = analyzer([]);
    const many = buildItems(media, () => Array.from({ length: 301 }, (_, i) => frame(i, 'x')));
    const error = await failure(claude.analyze(many, never));
    expect(error.message).toMatch(/^素材太多：602 張畫面/);
    expect(sent).toHaveLength(0);
  });

  it('estimates ⌈w/28⌉ × ⌈h/28⌉ tokens per image', () => {
    expect(analyzer([]).analyzer.imageTokens(640, 360)).toBe(299);
  });
});
