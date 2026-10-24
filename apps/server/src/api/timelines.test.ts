import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ApiError, HealthCheckName, Project } from '@revcut/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { media, musicTracks, projects, renders, timelines } from '../db/schema';
import type { HealthChecks, Probe } from '../health';
import type { DraftRequest } from '../jobs/draft';
import { createTestDb } from '../test/db';
import { apiRoutes } from '.';

const passing: Probe = { required: true, timeoutMs: 1000, run: async () => ({ ok: true, detail: '' }) };
const checks = Object.fromEntries(HealthCheckName.options.map((name) => [name, passing])) as HealthChecks;
const MISSING = '00000000-0000-4000-8000-000000000000';

let testDb: Awaited<ReturnType<typeof createTestDb>>;
let dataDir: string;
let drafts: DraftRequest[];
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(async () => {
  await testDb.close();
});

beforeEach(async () => {
  await testDb.reset();
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'revcut-timelines-'));
  drafts = [];
  app = buildApp({ checks });
  await app.register(apiRoutes, {
    db: testDb.db,
    dataDir,
    freeBytes: async () => 100 * 1024 ** 3,
    enqueueIngest: () => {},
    enqueueAnalyze: () => {},
    enqueueDraft: (request) => drafts.push(request),
  });
  return async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  };
});

function call(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) {
  return app.inject({ method, url, headers: { host: 'localhost' }, ...(payload && { payload }) });
}

const errorCode = (res: { json: () => unknown }) => ApiError.parse(res.json()).error.code;

async function addProject(values: Partial<typeof projects.$inferInsert> = {}) {
  const [row] = await testDb.db.insert(projects).values({ title: '2026 一月', ...values }).returning();
  return row!;
}

async function addTrack(status: typeof musicTracks.$inferInsert.status = 'ready') {
  const beats = Array.from({ length: 400 }, (_, i) => 0.3 + i * 0.5);
  const [row] = await testDb.db
    .insert(musicTracks)
    .values({
      title: 'song',
      filename: 'song.m4a',
      ext: 'm4a',
      sizeBytes: 1,
      status,
      ...(status === 'ready' && {
        beats,
        downbeatIndices: beats.map((_, i) => i).filter((i) => i % 4 === 0),
        energy: Array(400).fill(0.5),
        durationSec: 200,
      }),
    })
    .returning();
  return row!;
}

let sha = 0;
async function addMedia(projectId: string, values: Partial<typeof media.$inferInsert> = {}) {
  const [row] = await testDb.db
    .insert(media)
    .values({
      projectId,
      kind: 'photo',
      status: 'ready',
      filename: 'a.jpg',
      ext: 'jpg',
      sizeBytes: 1,
      sha256: String(++sha),
      width: 3000,
      height: 4000,
      ...values,
    })
    .returning();
  return row!;
}

async function addTimeline(projectId: string) {
  const [row] = await testDb.db.insert(timelines).values({ projectId, seed: 1, data: {} }).returning();
  return row!;
}

describe('POST /api/projects/:id/draft', () => {
  it('claims the draft, queues it with the given start and seed, and answers 202', async () => {
    const project = await addProject();
    const track = await addTrack();
    await addMedia(project.id);
    const res = await call('POST', `/api/projects/${project.id}/draft`, { trackId: track.id, startBeat: 8, seed: 42 });
    expect(res.statusCode).toBe(202);
    expect(Project.parse(res.json()).draftState).toBe('queued');
    expect(drafts).toEqual([{ projectId: project.id, trackId: track.id, startBeat: 8, seed: 42 }]);
  });

  it('picks a 31-bit seed when none is given, and drafts again once done or failed', async () => {
    const project = await addProject({ draftState: 'failed', draftError: '素材不足' });
    const track = await addTrack();
    await addMedia(project.id);
    const res = await call('POST', `/api/projects/${project.id}/draft`, { trackId: track.id });
    expect(Project.parse(res.json())).toMatchObject({ draftState: 'queued', draftError: null });
    expect(Number.isInteger(drafts[0]!.seed)).toBe(true);
    expect(drafts[0]!.seed).toBeGreaterThanOrEqual(0);
    expect(drafts[0]!.seed).toBeLessThan(2 ** 31);
  });

  it('answers 409 while a draft for the project is already running', async () => {
    const project = await addProject();
    const track = await addTrack();
    await addMedia(project.id);
    expect((await call('POST', `/api/projects/${project.id}/draft`, { trackId: track.id })).statusCode).toBe(202);
    const again = await call('POST', `/api/projects/${project.id}/draft`, { trackId: track.id });
    expect(again.statusCode).toBe(409);
    expect(errorCode(again)).toBe('DRAFT_RUNNING');
    expect(drafts).toHaveLength(1);
  });

  it('answers 409 for a song that is missing or not analyzed yet', async () => {
    const project = await addProject();
    await addMedia(project.id);
    const analyzing = await addTrack('analyzing');
    for (const trackId of [MISSING, analyzing.id]) {
      const res = await call('POST', `/api/projects/${project.id}/draft`, { trackId });
      expect([res.statusCode, errorCode(res)]).toEqual([409, 'TRACK_NOT_READY']);
    }
    expect((await testDb.db.select().from(projects))[0]!.draftState).toBe('idle');
  });

  it('answers 409 while any media is still uploading or processing', async () => {
    const project = await addProject();
    const track = await addTrack();
    await addMedia(project.id);
    await addMedia(project.id, { status: 'processing' });
    const res = await call('POST', `/api/projects/${project.id}/draft`, { trackId: track.id });
    expect([res.statusCode, errorCode(res)]).toEqual([409, 'MEDIA_BUSY']);
  });

  it('answers 422 without a single ready, included media', async () => {
    const project = await addProject();
    const track = await addTrack();
    await addMedia(project.id, { excluded: true });
    await addMedia(project.id, { status: 'failed' });
    const res = await call('POST', `/api/projects/${project.id}/draft`, { trackId: track.id });
    expect([res.statusCode, errorCode(res)]).toEqual([422, 'NO_MEDIA']);
  });

  it('answers 404 for an unknown project', async () => {
    const track = await addTrack();
    expect((await call('POST', `/api/projects/${MISSING}/draft`, { trackId: track.id })).statusCode).toBe(404);
  });
});

describe('PATCH /api/projects/:id currentTimelineId', () => {
  it('switches to another version of the same project only', async () => {
    const project = await addProject();
    const mine = await addTimeline(project.id);
    const other = await addTimeline((await addProject()).id);

    const res = await call('PATCH', `/api/projects/${project.id}`, { currentTimelineId: mine.id });
    expect(Project.parse(res.json()).currentTimelineId).toBe(mine.id);

    const foreign = await call('PATCH', `/api/projects/${project.id}`, { currentTimelineId: other.id });
    expect([foreign.statusCode, errorCode(foreign)]).toEqual([422, 'TIMELINE_NOT_FOUND']);
    expect((await call('PATCH', `/api/projects/${MISSING}`, { currentTimelineId: mine.id })).statusCode).toBe(404);
  });
});

describe('deleting while a draft or export runs', () => {
  it('refuses to delete the project or its media until the draft is done', async () => {
    const project = await addProject({ draftState: 'planning' });
    const item = await addMedia(project.id);
    expect(errorCode(await call('DELETE', `/api/projects/${project.id}`))).toBe('BUSY');
    expect(errorCode(await call('DELETE', `/api/media/${item.id}`))).toBe('BUSY');

    await testDb.db.update(projects).set({ draftState: 'done' }).where(eq(projects.id, project.id));
    expect((await call('DELETE', `/api/media/${item.id}`)).statusCode).toBe(204);
  });

  it('refuses to delete the project while an export is rendering', async () => {
    const project = await addProject();
    const [render] = await testDb.db
      .insert(renders)
      .values({ projectId: project.id, snapshot: {}, state: 'rendering' })
      .returning();
    expect(errorCode(await call('DELETE', `/api/projects/${project.id}`))).toBe('BUSY');

    await testDb.db.update(renders).set({ state: 'failed' }).where(eq(renders.id, render!.id));
    expect((await call('DELETE', `/api/projects/${project.id}`)).statusCode).toBe(204);
  });
});
