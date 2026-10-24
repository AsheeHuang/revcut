import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { ApiError, HealthCheckName, Media, Project } from '@revcut/shared';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp } from '../app';
import { media } from '../db/schema';
import type { HealthChecks, Probe } from '../health';
import { mediaPaths, projectDir } from '../storage/paths';
import { createTestDb } from '../test/db';
import { apiRoutes } from '.';

const passing: Probe = { required: true, timeoutMs: 1000, run: async () => ({ ok: true, detail: '' }) };
const checks = Object.fromEntries(HealthCheckName.options.map((name) => [name, passing])) as HealthChecks;
const GB = 1024 ** 3;

let testDb: Awaited<ReturnType<typeof createTestDb>>;
let dataDir: string;
let free: number;
let enqueued: string[];
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(async () => {
  await testDb.close();
});

beforeEach(async () => {
  await testDb.reset();
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'revcut-api-'));
  free = 100 * GB;
  enqueued = [];
  app = buildApp({ checks });
  await app.register(apiRoutes, {
    db: testDb.db,
    dataDir,
    freeBytes: async () => free,
    enqueueIngest: (id) => enqueued.push(id),
  });
  return async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  };
});

const host = { host: 'localhost' };

async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) {
  return app.inject({ method, url, headers: host, ...(payload && { payload }) });
}

async function createProject(title = '2026 秋天') {
  return Project.parse((await call('POST', '/api/projects', { title })).json());
}

function upload(projectId: string, filename: string, body: Buffer, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/media?filename=${encodeURIComponent(filename)}&lastModified=1759472530000`,
    headers: { ...host, 'content-type': 'application/octet-stream', ...headers },
    payload: body,
  });
}

async function uploaded(projectId: string, filename: string, body = randomBytes(64)) {
  const res = await upload(projectId, filename, body);
  expect(res.statusCode).toBe(201);
  return Media.parse(res.json());
}

const errorCode = (res: { json: () => unknown }) => ApiError.parse(res.json()).error.code;
const originals = async (projectId: string) =>
  readdir(path.join(projectDir(dataDir, projectId), 'originals')).catch(() => []);

async function setRow(id: string, values: Partial<typeof media.$inferInsert>) {
  await testDb.db.update(media).set(values).where(eq(media.id, id));
}

describe('projects', () => {
  it('creates, lists, renames and reads a project', async () => {
    const project = await createProject();
    expect(project).toMatchObject({
      title: '2026 秋天',
      dateRange: null,
      draftState: 'idle',
      mediaCounts: { total: 0, ready: 0, processing: 0, failed: 0, excluded: 0 },
    });
    const renamed = await call('PATCH', `/api/projects/${project.id}`, { title: '冬天' });
    expect(Project.parse(renamed.json()).title).toBe('冬天');
    const list = z.array(Project).parse((await call('GET', '/api/projects')).json());
    expect(list.map((p) => p.title)).toEqual(['冬天']);
  });

  it('rejects an empty title', async () => {
    const res = await call('POST', '/api/projects', { title: '  ' });
    expect(res.statusCode).toBe(400);
  });

  it('answers an unknown project with 404', async () => {
    const res = await call('GET', '/api/projects/00000000-0000-4000-8000-000000000000');
    expect(res.statusCode).toBe(404);
  });

  it('summarizes media counts and the local capture dates', async () => {
    const { id } = await createProject();
    const a = await uploaded(id, 'a.jpg');
    const b = await uploaded(id, 'b.mov');
    const c = await uploaded(id, 'c.jpg');
    await setRow(a.id, { status: 'ready', capturedAt: new Date('2026-09-01T17:00:00Z'), utcOffsetMin: 480 });
    await setRow(b.id, { status: 'failed', capturedAt: new Date('2026-11-28T10:00:00Z'), utcOffsetMin: -480 });
    await setRow(c.id, { excluded: true });
    const project = Project.parse((await call('GET', `/api/projects/${id}`)).json());
    expect(project.dateRange).toEqual({ from: '2026-09-02', to: '2026-11-28' });
    expect(project.mediaCounts).toEqual({ total: 3, ready: 1, processing: 1, failed: 1, excluded: 1 });
  });

  it('refuses to delete a project while media is processing, then deletes it and its files', async () => {
    const { id } = await createProject();
    const item = await uploaded(id, 'a.jpg');
    expect(errorCode(await call('DELETE', `/api/projects/${id}`))).toBe('BUSY');

    await setRow(item.id, { status: 'ready' });
    expect((await call('DELETE', `/api/projects/${id}`)).statusCode).toBe(204);
    expect(existsSync(projectDir(dataDir, id))).toBe(false);
    expect((await call('GET', `/api/projects/${id}`)).statusCode).toBe(404);
  });
});

describe('upload', () => {
  it('stores the file under its id, records the row as uploaded, and queues ingest', async () => {
    const { id: projectId } = await createProject();
    const body = randomBytes(1000);
    const item = await uploaded(projectId, 'IMG_1234.MOV', body);
    expect(item).toMatchObject({ kind: 'video', status: 'uploaded', filename: 'IMG_1234.MOV', thumbUrl: null });
    expect(enqueued).toEqual([item.id]);
    expect(await originals(projectId)).toEqual([`${item.id}.mov`]);
    const [row] = await testDb.db.select().from(media).where(eq(media.id, item.id));
    expect(row).toMatchObject({ sizeBytes: 1000, ext: 'mov', fileLastModified: new Date(1759472530000) });
  });

  it('accepts a body sent without a Content-Type', async () => {
    const { id } = await createProject();
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${id}/media?filename=a.heic`,
      headers: host,
      payload: randomBytes(10),
    });
    expect(res.statusCode).toBe(201);
  });

  it('answers a duplicate with 409, names the existing media, and keeps no second copy', async () => {
    const { id: projectId } = await createProject();
    const body = randomBytes(256);
    const first = await uploaded(projectId, 'IMG_1200.MOV', body);
    const res = await upload(projectId, 'copy.MOV', body);
    expect(res.statusCode).toBe(409);
    expect(ApiError.parse(res.json()).error).toMatchObject({
      code: 'DUPLICATE',
      message: '與 IMG_1200.MOV 重複',
      details: { mediaId: first.id },
    });
    expect(await originals(projectId)).toEqual([`${first.id}.mov`]);
  });

  it('allows the same file in another project', async () => {
    const body = randomBytes(256);
    await uploaded((await createProject('a')).id, 'a.jpg', body);
    await uploaded((await createProject('b')).id, 'a.jpg', body);
  });

  it('rejects an extension outside the whitelist without writing', async () => {
    const { id } = await createProject();
    const res = await upload(id, 'song.mp3', randomBytes(10));
    expect(res.statusCode).toBe(400);
    expect(errorCode(res)).toBe('UNSUPPORTED_FILE');
    expect(await originals(id)).toEqual([]);
  });

  it('answers 507 when free space is under file size plus 2 GB', async () => {
    const { id } = await createProject();
    free = 2 * GB + 50;
    const res = await upload(id, 'a.jpg', randomBytes(100));
    expect(res.statusCode).toBe(507);
    expect(await originals(id)).toEqual([]);
    free = 2 * GB + 100;
    expect((await upload(id, 'a.jpg', randomBytes(100))).statusCode).toBe(201);
  });

  it('answers 404 for a missing project', async () => {
    const res = await upload('00000000-0000-4000-8000-000000000000', 'a.jpg', randomBytes(10));
    expect(res.statusCode).toBe(404);
  });

  it('leaves no row and no .part file when the client hangs up mid-upload', async () => {
    const { id: projectId } = await createProject();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as AddressInfo;
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: `/api/projects/${projectId}/media?filename=big.mov`,
      headers: { host: 'localhost', 'content-length': 10_000_000, 'content-type': 'application/octet-stream' },
    });
    req.on('error', () => {});
    req.write(randomBytes(1_000_000));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await originals(projectId)).some((name) => name.endsWith('.part'))).toBe(true);
    req.destroy();

    await expect.poll(() => originals(projectId)).toEqual([]);
    expect(await testDb.db.select().from(media)).toEqual([]);
  });
});

describe('media list', () => {
  it('shows a Live Photo pair as one LIVE card once the video is ready, sorted by capture time', async () => {
    const { id } = await createProject();
    const heic = await uploaded(id, 'IMG_0242.HEIC');
    const mov = await uploaded(id, 'IMG_0242.MOV');
    const later = await uploaded(id, 'IMG_0300.JPG');
    await setRow(heic.id, { status: 'ready', contentIdentifier: 'C356', capturedAt: new Date('2026-01-08T11:31:37Z'), utcOffsetMin: 480 });
    await setRow(mov.id, { status: 'processing', contentIdentifier: 'C356' });
    await setRow(later.id, { status: 'ready', capturedAt: new Date('2026-01-09T00:00:00Z'), utcOffsetMin: 480 });

    const list = async () => z.array(Media).parse((await call('GET', `/api/projects/${id}/media`)).json());
    expect((await list()).map((m) => [m.filename, m.livePhoto])).toEqual([
      ['IMG_0242.HEIC', false],
      ['IMG_0300.JPG', false],
      ['IMG_0242.MOV', false],
    ]);

    await setRow(mov.id, { status: 'ready' });
    const ready = await list();
    expect(ready.map((m) => [m.filename, m.livePhoto])).toEqual([
      ['IMG_0242.MOV', true],
      ['IMG_0300.JPG', false],
    ]);
    expect(ready[0]).toMatchObject({ capturedAt: '2026-01-08T19:31:37+08:00', thumbUrl: `/api/media/${mov.id}/thumb` });
  });
});

describe('media changes', () => {
  it('toggles excluded', async () => {
    const { id } = await createProject();
    const item = await uploaded(id, 'a.jpg');
    const res = await call('PATCH', `/api/media/${item.id}`, { excluded: true });
    expect(Media.parse(res.json()).excluded).toBe(true);
    expect(Media.parse((await call('GET', `/api/media/${item.id}`)).json()).excluded).toBe(true);
  });

  it('retries only failed media and queues it again', async () => {
    const { id } = await createProject();
    const item = await uploaded(id, 'a.jpg');
    enqueued = [];
    expect(errorCode(await call('POST', `/api/media/${item.id}/retry`))).toBe('NOT_FAILED');

    await setRow(item.id, { status: 'failed', error: '產生照片失敗' });
    const res = await call('POST', `/api/media/${item.id}/retry`);
    expect(Media.parse(res.json())).toMatchObject({ status: 'uploaded', error: null });
    expect(enqueued).toEqual([item.id]);
  });

  it('refuses to delete while processing', async () => {
    const { id } = await createProject();
    const item = await uploaded(id, 'a.jpg');
    await setRow(item.id, { status: 'processing' });
    const res = await call('DELETE', `/api/media/${item.id}`);
    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe('BUSY');
  });

  it('deletes a whole Live Photo group with its files', async () => {
    const { id: projectId } = await createProject();
    const heic = await uploaded(projectId, 'a.heic');
    const mov = await uploaded(projectId, 'a.mov');
    const other = await uploaded(projectId, 'b.jpg');
    for (const item of [heic, mov]) await setRow(item.id, { status: 'ready', contentIdentifier: 'X' });
    await setRow(other.id, { status: 'ready' });
    const heicPaths = mediaPaths(dataDir, { projectId, id: heic.id, ext: 'heic' });
    await mkdir(heicPaths.derived, { recursive: true });

    expect((await call('DELETE', `/api/media/${mov.id}`)).statusCode).toBe(204);
    const left = await testDb.db.select({ id: media.id }).from(media).where(inArray(media.id, [heic.id, mov.id, other.id]));
    expect(left).toEqual([{ id: other.id }]);
    expect(await originals(projectId)).toEqual([`${other.id}.jpg`]);
    expect(existsSync(heicPaths.derived)).toBe(false);
  });
});

describe('preview and thumb', () => {
  it('serves byte ranges with an ETag once ready', async () => {
    const { id: projectId } = await createProject();
    const item = await uploaded(projectId, 'a.mov');
    expect((await call('GET', `/api/media/${item.id}/preview`)).statusCode).toBe(404);

    const paths = mediaPaths(dataDir, { projectId, id: item.id, ext: 'mov' });
    await mkdir(paths.derived, { recursive: true });
    await writeFile(paths.preview, randomBytes(1000));
    await writeFile(paths.thumb, randomBytes(10));
    await setRow(item.id, { status: 'ready' });

    const res = await app.inject({ method: 'GET', url: `/api/media/${item.id}/preview`, headers: { ...host, range: 'bytes=0-99' } });
    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 0-99/1000');
    expect(res.headers['content-type']).toBe('video/mp4');
    expect(res.rawPayload).toHaveLength(100);

    const etag = String(res.headers.etag);
    const cached = await app.inject({
      method: 'GET',
      url: `/api/media/${item.id}/preview`,
      headers: { ...host, 'if-none-match': etag },
    });
    expect(cached.statusCode).toBe(304);

    const thumb = await call('GET', `/api/media/${item.id}/thumb`);
    expect(thumb.statusCode).toBe(200);
    expect(thumb.headers['content-type']).toBe('image/webp');
  });
});
