import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AiConfig, ApiError, DraftEstimate, HealthCheckName } from '@revcut/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AiProviders } from '../ai/providers';
import { buildApp } from '../app';
import { analysisRuns, media, projects } from '../db/schema';
import type { HealthChecks, Probe } from '../health';
import { createTestDb } from '../test/db';
import { fakeAnalyzer, providersWith } from '../test/fakeAi';
import { apiRoutes } from '.';

const passing: Probe = { required: true, timeoutMs: 1000, run: async () => ({ ok: true, detail: '' }) };
const checks = Object.fromEntries(HealthCheckName.options.map((name) => [name, passing])) as HealthChecks;
const MISSING = '00000000-0000-4000-8000-000000000000';

let testDb: Awaited<ReturnType<typeof createTestDb>>;
let dataDir: string;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(async () => {
  await testDb.close();
});
beforeEach(async () => {
  await testDb.reset();
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'revcut-ai-'));
  return async () => {
    await app?.close();
    await rm(dataDir, { recursive: true, force: true });
  };
});

async function start(ai: AiProviders) {
  app = buildApp({ checks });
  await app.register(apiRoutes, {
    db: testDb.db,
    dataDir,
    ai,
    freeBytes: async () => 100 * 1024 ** 3,
    enqueueIngest: () => {},
    enqueueAnalyze: () => {},
    enqueueDraft: () => {},
    enqueueRender: () => {},
  });
}

const get = (url: string) => app.inject({ method: 'GET', url, headers: { host: 'localhost' } });
const errorCode = (res: { json: () => unknown }) => ApiError.parse(res.json()).error.code;

async function addProject() {
  const [row] = await testDb.db.insert(projects).values({ title: '2026 一月' }).returning();
  return row!;
}

let sha = 0;
async function addMedia(projectId: string, values: Partial<typeof media.$inferInsert> = {}) {
  const [row] = await testDb.db
    .insert(media)
    .values({ projectId, kind: 'photo', status: 'ready', filename: 'a.jpg', ext: 'jpg', sizeBytes: 1, sha256: String(++sha), width: 3000, height: 4000, ...values })
    .returning();
  return row!;
}

describe('GET /api/config', () => {
  it('lists both providers with their models, marks which have a key, and keeps AI_PROVIDER as the default when usable', async () => {
    await start(providersWith(fakeAnalyzer({ provider: 'anthropic' }).analyzer, fakeAnalyzer().analyzer));
    expect(AiConfig.parse((await get('/api/config')).json())).toEqual({
      aiProviders: [
        { id: 'anthropic', model: 'claude-opus-5-5', available: true },
        { id: 'openai', model: 'gpt-6-astra', available: true },
      ],
      defaultProvider: 'anthropic',
    });
  });

  it('falls back to a provider that has a key when AI_PROVIDER has none', async () => {
    await start(providersWith(fakeAnalyzer().analyzer));
    const config = AiConfig.parse((await get('/api/config')).json());
    expect(config.aiProviders.map((p) => [p.id, p.available])).toEqual([
      ['anthropic', false],
      ['openai', true],
    ]);
    expect(config.defaultProvider).toBe('openai');
  });
});

describe('GET /api/projects/:id/draft-estimate', () => {
  it('counts the frames a new analysis would send and prices them', async () => {
    await start(providersWith(fakeAnalyzer().analyzer));
    const project = await addProject();
    await addMedia(project.id);
    await addMedia(project.id, { kind: 'video', ext: 'mov', durationSec: 6, width: 1080, height: 1920 });
    await addMedia(project.id, { excluded: true });

    const estimate = DraftEstimate.parse((await get(`/api/projects/${project.id}/draft-estimate?provider=openai`)).json());
    expect(estimate).toMatchObject({ reuse: false, mediaCount: 2, imageCount: 5 });
    expect(estimate.estimatedUsd).toBeGreaterThan(0);
  });

  it('costs nothing when the latest run of the provider and model covers every media', async () => {
    await start(providersWith(fakeAnalyzer().analyzer));
    const project = await addProject();
    const items = [await addMedia(project.id), await addMedia(project.id)];
    await testDb.db.insert(analysisRuns).values({
      projectId: project.id,
      mediaIds: items.map((item) => item.id),
      provider: 'openai',
      model: 'gpt-6-astra',
      effort: 'medium',
      status: 'done',
    });
    expect(DraftEstimate.parse((await get(`/api/projects/${project.id}/draft-estimate`)).json())).toEqual({
      reuse: true,
      estimatedUsd: 0,
      mediaCount: 2,
      imageCount: 0,
    });
  });

  it('answers 422 for a provider without a key and 404 for an unknown project', async () => {
    await start(providersWith(fakeAnalyzer().analyzer));
    const project = await addProject();
    const res = await get(`/api/projects/${project.id}/draft-estimate?provider=anthropic`);
    expect([res.statusCode, errorCode(res)]).toEqual([422, 'PROVIDER_NOT_CONFIGURED']);
    expect((await get(`/api/projects/${MISSING}/draft-estimate`)).statusCode).toBe(404);
  });
});
