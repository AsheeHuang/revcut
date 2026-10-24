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

  it('treats an empty API key as not configured', () => {
    expect(parseConfig({ ...env, ANTHROPIC_API_KEY: '' }).anthropicApiKey).toBeUndefined();
  });
});
