import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ApiError, HealthCheckName, Render, StartRenderResponse } from '@revcut/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp } from '../app';
import { media, musicTracks, projects, renders, timelines } from '../db/schema';
import type { HealthChecks, Probe } from '../health';
import { renderPaths } from '../storage/paths';
import { createTestDb } from '../test/db';
import { providersWith } from '../test/fakeAi';
import { apiRoutes } from '.';

const passing: Probe = { required: true, timeoutMs: 1000, run: async () => ({ ok: true, detail: '' }) };
const checks = Object.fromEntries(HealthCheckName.options.map((name) => [name, passing])) as HealthChecks;
const MISSING = '00000000-0000-4000-8000-000000000000';
const CLIP = '00000000-0000-4000-8000-0000000000c1';

let testDb: Awaited<ReturnType<typeof createTestDb>>;
let dataDir: string;
let queued: string[];
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(async () => {
  await testDb.close();
});

beforeEach(async () => {
  await testDb.reset();
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'revcut-renders-'));
  queued = [];
  app = buildApp({ checks });
  await app.register(apiRoutes, {
    db: testDb.db,
    dataDir,
    ai: providersWith(),
    freeBytes: async () => 100 * 1024 ** 3,
    enqueueIngest: () => {},
    enqueueAnalyze: () => {},
    enqueueDraft: () => {},
    enqueueRender: (id) => queued.push(id),
  });
  return async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  };
});

function call(method: 'GET' | 'POST', url: string, headers: Record<string, string> = {}) {
  return app.inject({ method, url, headers: { host: 'localhost', ...headers } });
}

const errorCode = (res: { json: () => unknown }) => ApiError.parse(res.json()).error.code;

async function setup({ excluded = false, title = '2026 一月：回顧' } = {}) {
  const [project] = await testDb.db.insert(projects).values({ title }).returning();
  const beats = Array.from({ length: 200 }, (_, i) => 0.3 + i * 0.5);
  const [track] = await testDb.db
    .insert(musicTracks)
    .values({
      title: 'song',
      filename: 'song.m4a',
      ext: 'm4a',
      sizeBytes: 1,
      status: 'ready',
      beats,
      downbeatIndices: beats.map((_, i) => i).filter((i) => i % 4 === 0),
      energy: Array(200).fill(0.5),
    })
    .returning();
  const [photo] = await testDb.db
    .insert(media)
    .values({
      projectId: project!.id,
      kind: 'photo',
      status: 'ready',
      excluded,
      filename: 'a.jpg',
      ext: 'jpg',
      sizeBytes: 1,
      sha256: 'p',
      width: 3000,
      height: 4000,
    })
    .returning();
  const data = {
    schemaVersion: 1,
    music: { trackId: track!.id, startBeat: 4, volume: 1, fadeOutSec: 1.5 },
    overlayEnabled: true,
    clips: [
      {
        id: CLIP,
        mediaId: photo!.id,
        beats: 4,
        sourceInSec: 0,
        crop: { focusX: 0.5, focusY: 0.5, zoom: 1 },
        kenBurns: { endZoom: 1.08 },
        date: null,
        originalVolume: 0.35,
      },
    ],
  };
  const [timeline] = await testDb.db.insert(timelines).values({ projectId: project!.id, seed: 1, data }).returning();
  return { project: project!, timeline: timeline!, data };
}

describe('POST /api/timelines/:id/renders', () => {
  it('snapshots the timeline, queues the export, and answers 202 even with warnings', async () => {
    const { timeline, data } = await setup();
    const res = await call('POST', `/api/timelines/${timeline.id}/renders`);
    expect(res.statusCode).toBe(202);
    const { renderId } = StartRenderResponse.parse(res.json());
    expect(queued).toEqual([renderId]);
    const [row] = await testDb.db.select().from(renders).where(eq(renders.id, renderId));
    expect(row).toMatchObject({ timelineId: timeline.id, state: 'queued', progress: 0, snapshot: data });
  });

  it('answers 422 with the errors and queues nothing when a rule blocks the export', async () => {
    const { timeline } = await setup({ excluded: true });
    const res = await call('POST', `/api/timelines/${timeline.id}/renders`);
    expect(res.statusCode).toBe(422);
    const { error } = ApiError.parse(res.json());
    expect(error).toMatchObject({ code: 'VALIDATION_FAILED', details: [expect.objectContaining({ code: 'MEDIA_EXCLUDED', clipId: CLIP })] });
    expect(queued).toEqual([]);
    expect(await testDb.db.select().from(renders)).toEqual([]);
  });

  it('answers 404 for an unknown timeline', async () => {
    expect((await call('POST', `/api/timelines/${MISSING}/renders`)).statusCode).toBe(404);
  });
});

describe('renders', () => {
  async function finished(title?: string) {
    const { project, timeline, data } = await setup({ title });
    const [row] = await testDb.db
      .insert(renders)
      .values({ projectId: project.id, timelineId: timeline.id, snapshot: data, state: 'done', progress: 1, sizeBytes: 1000, finishedAt: new Date() })
      .returning();
    const paths = renderPaths(dataDir, project.id, row!.id);
    await mkdir(path.dirname(paths.output), { recursive: true });
    await writeFile(paths.output, Buffer.alloc(1000, 7));
    return { project, row: row! };
  }

  it('reports progress, and a download link only once done', async () => {
    const { project, timeline, data } = await setup();
    const [running] = await testDb.db
      .insert(renders)
      .values({ projectId: project.id, timelineId: timeline.id, snapshot: data, state: 'rendering', progress: 0.42 })
      .returning();
    const res = Render.parse((await call('GET', `/api/renders/${running!.id}`)).json());
    expect(res).toMatchObject({ timelineId: timeline.id, state: 'rendering', progress: 0.42, error: null, downloadUrl: null, finishedAt: null });
    expect(errorCode(await call('GET', `/api/renders/${running!.id}/download`))).toBe('NOT_READY');

    await testDb.db.update(renders).set({ state: 'done', progress: 1, finishedAt: new Date() }).where(eq(renders.id, running!.id));
    const done = Render.parse((await call('GET', `/api/renders/${running!.id}`)).json());
    expect(done.downloadUrl).toBe(`/api/renders/${running!.id}/download`);
    expect((await call('GET', `/api/renders/${MISSING}`)).statusCode).toBe(404);
  });

  it('downloads the MP4 named after the project, in UTF-8 per RFC 5987, with byte ranges', async () => {
    const { row } = await finished('2026 一月 (回顧)');
    const res = await call('GET', `/api/renders/${row.id}/download`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('video/mp4');
    expect(res.headers['content-disposition']).toBe(
      "attachment; filename=\"2026 __ (__).mp4\"; filename*=UTF-8''2026%20%E4%B8%80%E6%9C%88%20%28%E5%9B%9E%E9%A1%A7%29.mp4",
    );
    expect(res.rawPayload).toHaveLength(1000);
    const part = await call('GET', `/api/renders/${row.id}/download`, { range: 'bytes=0-99' });
    expect([part.statusCode, part.rawPayload.length]).toEqual([206, 100]);
  });

  it('serves a slice to the renderer by clip id and nothing else', async () => {
    const { project, row } = await finished();
    const paths = renderPaths(dataDir, project.id, row.id);
    await mkdir(paths.tmp, { recursive: true });
    await writeFile(paths.slice(CLIP), Buffer.alloc(500, 1));
    await writeFile(path.join(paths.tmp, 'notes.txt'), 'x');

    const res = await call('GET', `/api/renders/${row.id}/slices/${CLIP}.mp4`, { range: 'bytes=0-9' });
    expect([res.statusCode, res.headers['content-type'], res.rawPayload.length]).toEqual([206, 'video/mp4', 10]);
    expect((await call('GET', `/api/renders/${row.id}/slices/notes.txt`)).statusCode).toBe(400);
    expect((await call('GET', `/api/renders/${row.id}/slices/..%2F..%2Fsecret.mp4`)).statusCode).toBe(400);
    expect((await call('GET', `/api/renders/${row.id}/slices/${MISSING}.mp4`)).statusCode).toBe(404);
  });

  it('lists a project’s exports newest first', async () => {
    const { project, row } = await finished();
    const [later] = await testDb.db
      .insert(renders)
      .values({ projectId: project.id, snapshot: {}, state: 'failed', error: '算圖失敗', createdAt: new Date(Date.now() + 1000) })
      .returning();
    const list = z.array(Render).parse((await call('GET', `/api/projects/${project.id}/renders`)).json());
    expect(list.map((r) => [r.id, r.state])).toEqual([
      [later!.id, 'failed'],
      [row.id, 'done'],
    ]);
    expect((await call('GET', `/api/projects/${MISSING}/renders`)).statusCode).toBe(404);
  });
});
