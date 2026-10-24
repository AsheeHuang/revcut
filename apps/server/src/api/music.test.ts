import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ApiError, HealthCheckName, MusicTrack, MusicTrackDetail } from '@revcut/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp } from '../app';
import { musicTracks } from '../db/schema';
import type { HealthChecks, Probe } from '../health';
import { createMusicQueue } from '../jobs/analyzeMusic';
import { runProcess } from '../process';
import { musicPaths } from '../storage/paths';
import { createTestDb } from '../test/db';
import { apiRoutes } from '.';

const passing: Probe = { required: true, timeoutMs: 1000, run: async () => ({ ok: true, detail: '' }) };
const checks = Object.fromEntries(HealthCheckName.options.map((name) => [name, passing])) as HealthChecks;
const GB = 1024 ** 3;
const host = { host: 'localhost' };

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

async function start(enqueueAnalyze: (id: string) => void) {
  app = buildApp({ checks });
  await app.register(apiRoutes, {
    db: testDb.db,
    dataDir,
    freeBytes: async () => free,
    enqueueIngest: () => {},
    enqueueAnalyze,
    enqueueDraft: () => {},
  });
}

beforeEach(async () => {
  await testDb.reset();
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'revcut-music-api-'));
  free = 100 * GB;
  enqueued = [];
  await start((id) => enqueued.push(id));
  return async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  };
});

function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) {
  return app.inject({ method, url, headers: host, ...(payload && { payload }) });
}

function upload(filename: string, body: Buffer, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: `/api/music?filename=${encodeURIComponent(filename)}`,
    headers: { ...host, 'content-type': 'audio/mpeg', ...headers },
    payload: body,
  });
}

async function uploaded(filename = 'New Light.mp3', body = randomBytes(64)) {
  const res = await upload(filename, body);
  expect(res.statusCode).toBe(201);
  return MusicTrack.parse(res.json());
}

const errorCode = (res: { json: () => unknown }) => ApiError.parse(res.json()).error.code;
const musicFiles = () => readdir(path.join(dataDir, 'music')).catch(() => []);
const detail = async (id: string) => MusicTrackDetail.parse((await call('GET', `/api/music/${id}`)).json());

async function setRow(id: string, values: Partial<typeof musicTracks.$inferInsert>) {
  await testDb.db.update(musicTracks).set(values).where(eq(musicTracks.id, id));
}

const beatsAt120 = (seconds: number) => Array.from({ length: seconds * 2 }, (_, i) => 0.25 + i * 0.5);

describe('music upload', () => {
  it('stores the file under its id, titles it by filename, and queues analysis', async () => {
    const body = randomBytes(1000);
    const track = await uploaded('John Mayer - New Light.mp3', body);
    expect(track).toMatchObject({
      title: 'John Mayer - New Light',
      artist: null,
      status: 'uploaded',
      error: null,
      bpm: null,
      audioUrl: `/api/music/${track.id}/audio`,
    });
    expect(enqueued).toEqual([track.id]);
    expect(await musicFiles()).toEqual([`${track.id}.mp3`]);
    expect(await readFile(musicPaths(dataDir, { id: track.id, ext: 'mp3' }).file)).toEqual(body);
  });

  it('accepts the same song twice', async () => {
    const body = randomBytes(64);
    const a = await uploaded('a.mp3', body);
    const b = await uploaded('a.mp3', body);
    expect(a.id).not.toBe(b.id);
  });

  it('rejects an extension outside the whitelist without writing', async () => {
    const res = await upload('clip.mov', randomBytes(10));
    expect(res.statusCode).toBe(400);
    expect(errorCode(res)).toBe('UNSUPPORTED_FILE');
    expect(await musicFiles()).toEqual([]);
  });

  it('rejects a file over 50 MB before reading it', async () => {
    const res = await upload('big.wav', randomBytes(10), { 'content-length': String(50 * 1024 ** 2 + 1) });
    expect(res.statusCode).toBe(413);
    expect(errorCode(res)).toBe('FILE_TOO_LARGE');
    expect(await musicFiles()).toEqual([]);
  });

  it('answers 507 when free space is under file size plus 2 GB', async () => {
    free = 2 * GB + 50;
    const res = await upload('a.flac', randomBytes(100));
    expect(res.statusCode).toBe(507);
    expect(await musicFiles()).toEqual([]);
  });

  it('lists the newest track first', async () => {
    await uploaded('first.mp3');
    await uploaded('second.m4a');
    const list = z.array(MusicTrack).parse((await call('GET', '/api/music')).json());
    expect(list.map((t) => t.title)).toEqual(['second', 'first']);
  });
});

describe('music detail', () => {
  it('has no analysis until ready, then beats with a suggested section', async () => {
    const track = await uploaded();
    expect((await detail(track.id)).analysis).toBeNull();

    const beats = beatsAt120(60);
    const downbeatIndices = beats.map((_, i) => i).filter((i) => i % 4 === 0);
    const energy = Array.from({ length: 120 }, (_, i) => (i >= 40 && i < 100 ? 1 : 0.2));
    await setRow(track.id, { status: 'ready', bpm: 120, durationSec: 60, beats, downbeatIndices, energy });

    const ready = await detail(track.id);
    expect(ready).toMatchObject({ status: 'ready', bpm: 120, durationSec: 60 });
    expect(ready.analysis).toMatchObject({ beats, downbeatIndices, energy: { hopSec: 0.5, values: energy } });
    expect(ready.analysis?.suggestedSection).toEqual({
      startBeat: 40,
      bars: 11,
      beatsPerBar: 4,
      totalBeats: 44,
      startSec: 20.25,
      durationSec: 22,
    });
  });

  it('answers an unknown track with 404', async () => {
    expect((await call('GET', '/api/music/00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
  });
});

describe('music audio', () => {
  it('serves byte ranges with an ETag', async () => {
    const track = await uploaded('a.mp3', randomBytes(1000));
    const res = await app.inject({ method: 'GET', url: track.audioUrl, headers: { ...host, range: 'bytes=0-99' } });
    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 0-99/1000');
    expect(res.headers['content-type']).toBe('audio/mpeg');
    expect(res.rawPayload).toHaveLength(100);

    const cached = await app.inject({ method: 'GET', url: track.audioUrl, headers: { ...host, 'if-none-match': String(res.headers.etag) } });
    expect(cached.statusCode).toBe(304);
  });
});

describe('music changes', () => {
  it('renames and sets the artist, and clears a blank artist', async () => {
    const track = await uploaded();
    const res = await call('PATCH', `/api/music/${track.id}`, { title: ' 新的光 ', artist: 'John Mayer' });
    expect(MusicTrack.parse(res.json())).toMatchObject({ title: '新的光', artist: 'John Mayer' });
    const cleared = await call('PATCH', `/api/music/${track.id}`, { artist: '' });
    expect(MusicTrack.parse(cleared.json())).toMatchObject({ title: '新的光', artist: null });
  });

  it('rejects a blank title and answers an unknown track with 404', async () => {
    const track = await uploaded();
    expect((await call('PATCH', `/api/music/${track.id}`, { title: ' ' })).statusCode).toBe(400);
    expect((await call('PATCH', '/api/music/00000000-0000-4000-8000-000000000000', { title: 'x' })).statusCode).toBe(404);
  });

  it('retries only a failed track and queues it again', async () => {
    const track = await uploaded();
    enqueued = [];
    expect(errorCode(await call('POST', `/api/music/${track.id}/retry`))).toBe('NOT_FAILED');

    await setRow(track.id, { status: 'failed', error: '偵測不到重拍' });
    const res = await call('POST', `/api/music/${track.id}/retry`);
    expect(MusicTrack.parse(res.json())).toMatchObject({ status: 'uploaded', error: null });
    expect(enqueued).toEqual([track.id]);
  });

  it('refuses to delete while analyzing, then deletes the row and its files', async () => {
    const track = await uploaded();
    const paths = musicPaths(dataDir, { id: track.id, ext: 'mp3' });
    await setRow(track.id, { status: 'analyzing' });
    await mkdir(paths.tmp, { recursive: true });
    const busy = await call('DELETE', `/api/music/${track.id}`);
    expect(busy.statusCode).toBe(409);
    expect(errorCode(busy)).toBe('BUSY');

    await setRow(track.id, { status: 'ready' });
    expect((await call('DELETE', `/api/music/${track.id}`)).statusCode).toBe(204);
    expect(await musicFiles()).toEqual([]);
    expect((await call('GET', `/api/music/${track.id}`)).statusCode).toBe(404);
  });

  it('deletes a track that is still waiting for analysis', async () => {
    const track = await uploaded();
    expect((await call('DELETE', `/api/music/${track.id}`)).statusCode).toBe(204);
  });
});

describe('music upload to ready', () => {
  it('decodes the upload, runs the analyzer, and serves the suggested section', async () => {
    const song = path.join(dataDir, 'sine.mp3');
    await runProcess('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', song], {
      signal: new AbortController().signal,
    });
    const beats = beatsAt120(40);
    const output = { bpm: 120, beats, downbeatIndices: beats.map((_, i) => i).filter((i) => i % 4 === 0), energy: { hopSec: 0.5, values: Array(80).fill(0.5) } };
    const queue = createMusicQueue({
      db: testDb.db,
      dataDir,
      analyzeBeats: async () => `${JSON.stringify(output)}\n`,
      log: { info: () => {}, error: () => {} },
    });
    await app.close();
    await start(queue.enqueue);

    const track = await uploaded('sine.mp3', await readFile(song));
    await queue.idle();

    const ready = await detail(track.id);
    expect(ready).toMatchObject({ status: 'ready', bpm: 120, error: null });
    expect(ready.durationSec).toBeCloseTo(3, 1);
    expect(ready.analysis?.suggestedSection).toMatchObject({ startBeat: 0, bars: 11, totalBeats: 44, durationSec: 22 });
    expect(existsSync(musicPaths(dataDir, { id: track.id, ext: 'mp3' }).tmp)).toBe(false);
    await queue.close();
  });
});
