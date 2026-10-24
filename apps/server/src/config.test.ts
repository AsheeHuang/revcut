import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from './config';

const env = { DATABASE_URL: 'postgres://revcut:revcut@localhost:5432/revcut' };

describe('parseConfig', () => {
  it('resolves an empty DATA_DIR to ~/.revcut/data', () => {
    expect(parseConfig({ ...env, DATA_DIR: '' }).dataDir).toBe(path.join(os.homedir(), '.revcut', 'data'));
  });

  it('keeps an absolute DATA_DIR', () => {
    expect(parseConfig({ ...env, DATA_DIR: '/srv/revcut' }).dataDir).toBe('/srv/revcut');
  });

  it.each(['~/x', 'data', './data'])('rejects the relative DATA_DIR %s', (dataDir) => {
    expect(() => parseConfig({ ...env, DATA_DIR: dataDir })).toThrow(/DATA_DIR/);
  });

  it('defaults HOST_DRIVE and PORT', () => {
    expect(parseConfig(env)).toMatchObject({ hostDrive: '/mnt/c', port: 3000 });
  });

  it('requires DATABASE_URL', () => {
    expect(() => parseConfig({})).toThrow(/DATABASE_URL/);
  });

  it('defaults DEFAULT_TZ to Asia/Taipei and rejects an unknown zone', () => {
    expect(parseConfig(env).defaultTz).toBe('Asia/Taipei');
    expect(parseConfig({ ...env, DEFAULT_TZ: 'Asia/Tokyo' }).defaultTz).toBe('Asia/Tokyo');
    expect(() => parseConfig({ ...env, DEFAULT_TZ: 'Mars/Olympus' })).toThrow(/DEFAULT_TZ/);
  });

  it('treats an empty API key as not configured', () => {
    expect(parseConfig({ ...env, ANTHROPIC_API_KEY: '' }).ai.anthropic.apiKey).toBeUndefined();
  });

  it('defaults the AI provider to Anthropic on claude-opus-5-5 at medium effort', () => {
    expect(parseConfig(env).ai).toEqual({
      defaultProvider: 'anthropic',
      anthropic: { apiKey: undefined, model: 'claude-opus-5-5', effort: 'medium' },
      openai: { apiKey: undefined, model: undefined, effort: 'medium' },
    });
  });

  it('reads the OpenAI model and effort, and rejects an unknown provider or effort', () => {
    const ai = parseConfig({ ...env, AI_PROVIDER: 'openai', OPENAI_MODEL: 'gpt-6-astra', OPENAI_REASONING_EFFORT: 'high' }).ai;
    expect(ai.defaultProvider).toBe('openai');
    expect(ai.openai).toMatchObject({ model: 'gpt-6-astra', effort: 'high' });
    expect(() => parseConfig({ ...env, AI_PROVIDER: 'gemini' })).toThrow(/AI_PROVIDER/);
    expect(() => parseConfig({ ...env, ANTHROPIC_EFFORT: 'extreme' })).toThrow(/ANTHROPIC_EFFORT/);
  });
});
