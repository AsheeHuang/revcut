import { ApiError } from '@revcut/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp } from './app';

async function get(url: string, host = 'localhost:3000', app = buildApp()) {
  const res = await app.inject({ method: 'GET', url, headers: { host } });
  return { status: res.statusCode, body: ApiError.parse(res.json()) };
}

describe('Host check', () => {
  it.each(['evil.example', 'localhost.evil.example', '127.0.0.1.nip.io:3000'])(
    'answers Host %s with 403',
    async (host) => {
      const res = await get('/api/anything', host);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN_HOST');
    },
  );

  it.each(['localhost:5173', '127.0.0.1:3000', 'localhost'])('lets Host %s reach routing', async (host) => {
    expect((await get('/api/anything', host)).status).toBe(404);
  });
});

describe('error envelope', () => {
  it('answers an unknown route with 404', async () => {
    const res = await get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('answers a schema violation with 400 and the failing fields', async () => {
    const app = buildApp();
    app.get('/api/echo', { schema: { querystring: z.object({ n: z.coerce.number() }) } }, async () => ({}));
    const res = await get('/api/echo?n=abc', undefined, app);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(res.body.error.details)).toContain('n');
  });

  it('answers a thrown error with 500', async () => {
    const app = buildApp();
    app.get('/api/boom', async () => {
      throw new Error('boom');
    });
    const res = await get('/api/boom', undefined, app);
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL');
  });
});
