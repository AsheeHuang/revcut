import { ApiError, HealthCheckName, HealthResponse } from '@revcut/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp } from './app';
import type { HealthChecks, Probe } from './health';

const passing: Probe = { required: true, timeoutMs: 1000, run: async () => ({ ok: true, detail: '正常' }) };

function registry(overrides: Partial<HealthChecks> = {}): HealthChecks {
  const all = Object.fromEntries(HealthCheckName.options.map((name) => [name, passing])) as HealthChecks;
  return { ...all, ...overrides };
}

function inject(url: string, host = 'localhost:3000', app = buildApp({ checks: registry() })) {
  return app.inject({ method: 'GET', url, headers: { host } });
}

async function health(checks: HealthChecks) {
  const res = await inject('/api/health', undefined, buildApp({ checks }));
  expect(res.statusCode).toBe(200);
  const body = HealthResponse.parse(res.json());
  return { ok: body.ok, check: (name: HealthCheckName) => body.checks.find((c) => c.name === name), body };
}

describe('Host check', () => {
  it.each(['evil.example', 'localhost.evil.example', '127.0.0.1.nip.io:3000'])(
    'answers Host %s with 403',
    async (host) => {
      const res = await inject('/api/health', host);
      expect(res.statusCode).toBe(403);
      expect(ApiError.parse(res.json()).error.code).toBe('FORBIDDEN_HOST');
    },
  );

  it.each(['localhost:5173', '127.0.0.1:3000', 'localhost'])('lets Host %s through', async (host) => {
    expect((await inject('/api/health', host)).statusCode).toBe(200);
  });
});

describe('error envelope', () => {
  it('answers an unknown route with 404', async () => {
    const res = await inject('/api/nope');
    expect(res.statusCode).toBe(404);
    expect(ApiError.parse(res.json()).error.code).toBe('NOT_FOUND');
  });

  it('answers a schema violation with 400 and the failing fields', async () => {
    const app = buildApp({ checks: registry() });
    app.get('/api/echo', { schema: { querystring: z.object({ n: z.coerce.number() }) } }, async () => ({}));
    const res = await inject('/api/echo?n=abc', undefined, app);
    expect(res.statusCode).toBe(400);
    const { error } = ApiError.parse(res.json());
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(error.details)).toContain('n');
  });

  it('answers a thrown error with 500', async () => {
    const app = buildApp({ checks: registry() });
    app.get('/api/boom', async () => {
      throw new Error('boom');
    });
    const res = await inject('/api/boom', undefined, app);
    expect(res.statusCode).toBe(500);
    expect(ApiError.parse(res.json()).error.code).toBe('INTERNAL');
  });
});

describe('GET /api/health', () => {
  it('reports every check, in order, and ok when all pass', async () => {
    const res = await health(registry());
    expect(res.ok).toBe(true);
    expect(res.body.checks.map((c) => c.name)).toEqual(HealthCheckName.options);
  });

  it('is not ok when a required check fails', async () => {
    const res = await health(
      registry({ exiftool: { ...passing, run: async () => ({ ok: false, detail: '找不到 exiftool' }) } }),
    );
    expect(res.ok).toBe(false);
    expect(res.check('exiftool')).toEqual({ name: 'exiftool', required: true, ok: false, detail: '找不到 exiftool' });
  });

  it('stays ok when only an optional check fails', async () => {
    const res = await health(
      registry({ openaiKey: { required: false, timeoutMs: 1000, run: async () => ({ ok: false, detail: '未設定' }) } }),
    );
    expect(res.ok).toBe(true);
    expect(res.check('openaiKey')).toMatchObject({ required: false, ok: false });
  });

  it('turns a thrown error into a failed check', async () => {
    const res = await health(
      registry({
        database: {
          ...passing,
          run: async () => {
            throw new Error('connect ECONNREFUSED');
          },
        },
      }),
    );
    expect(res.ok).toBe(false);
    expect(res.check('database')).toMatchObject({ ok: false, detail: expect.stringContaining('ECONNREFUSED') });
  });

  it('fails a check that exceeds its timeout instead of hanging', async () => {
    const res = await health(registry({ analyzer: { required: true, timeoutMs: 50, run: () => new Promise(() => {}) } }));
    expect(res.ok).toBe(false);
    expect(res.check('analyzer')).toMatchObject({ ok: false, detail: expect.stringContaining('逾時') });
  });
});
