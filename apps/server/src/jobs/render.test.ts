import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CompositionProps } from '@revcut/composition/props';
import type { Timeline } from '@revcut/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { media, musicTracks, projects, renders } from '../db/schema';
import { runProcess } from '../process';
import type { RenderVideo } from '../render/remotion';
import { mediaPaths, renderPaths } from '../storage/paths';
import { createTestDb } from '../test/db';
import { createRenderQueue } from './render';

const BASE = 'http://127.0.0.1:3999';
const GB = 1024 ** 3;
const never = new AbortController().signal;

let testDb: Awaited<ReturnType<typeof createTestDb>>;
let samples: string;
let dataDir: string;
let free: number;
let errors: unknown[];

beforeAll(async () => {
  testDb = await createTestDb();
  samples = await mkdtemp(path.join(os.tmpdir(), 'revcut-render-samples-'));
  await runProcess(
    'ffmpeg',
    [
      ...['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=720x1280:rate=30', '-f', 'lavfi', '-i', 'sine', '-t', '6'],
      ...['-c:v', 'libx264', '-c:a', 'aac', path.join(samples, 'clip.mp4')],
    ],
    { signal: never },
  );
}, 60_000);

afterAll(async () => {
  await testDb.close();
  await rm(samples, { recursive: true, force: true });
});

beforeEach(async () => {
  await testDb.reset();
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'revcut-render-'));
  free = 100 * GB;
  errors = [];
  return () => rm(dataDir, { recursive: true, force: true });
});

function queue(renderVideo: RenderVideo) {
  return createRenderQueue({
    db: testDb.db,
    dataDir,
    baseUrl: BASE,
    freeBytes: async () => free,
    renderVideo,
    log: { info: () => {}, error: (entry: unknown) => errors.push(entry) },
  });
}

async function setup() {
  const [project] = await testDb.db.insert(projects).values({ title: '2026 一月' }).returning();
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
  const common = { projectId: project!.id, status: 'ready' as const, sizeBytes: 1 };
  const [video] = await testDb.db
    .insert(media)
    .values({ ...common, kind: 'video', filename: 'clip.mp4', ext: 'mp4', sha256: 'v', width: 720, height: 1280, durationSec: 6, isHdr: false })
    .returning();
  const [photo] = await testDb.db
    .insert(media)
    .values({ ...common, kind: 'photo', filename: 'a.jpg', ext: 'jpg', sha256: 'p', width: 3000, height: 4000 })
    .returning();
  const original = mediaPaths(dataDir, video!).original;
  await mkdir(path.dirname(original), { recursive: true });
  await copyFile(path.join(samples, 'clip.mp4'), original);

  const clip = (id: string, mediaId: string, sourceInSec: number) => ({
    id,
    mediaId,
    beats: 2,
    sourceInSec,
    crop: { focusX: 0.5, focusY: 0.5, zoom: 1 },
    kenBurns: null,
    date: null,
    originalVolume: 0.35,
  });
  const snapshot: Timeline = {
    schemaVersion: 1,
    music: { trackId: track!.id, startBeat: 4, volume: 1, fadeOutSec: 1.5 },
    overlayEnabled: true,
    clips: [
      clip('00000000-0000-4000-8000-00000000000a', video!.id, 2),
      clip('00000000-0000-4000-8000-00000000000b', photo!.id, 0),
      clip('00000000-0000-4000-8000-00000000000c', video!.id, 0.2),
    ],
  };
  const [render] = await testDb.db.insert(renders).values({ projectId: project!.id, snapshot }).returning();
  return { project: project!, track: track!, video: video!, photo: photo!, render: render!, snapshot };
}

const load = async (id: string) => (await testDb.db.select().from(renders).where(eq(renders.id, id)))[0]!;

async function run(renderVideo: RenderVideo, id: string) {
  const renderQueue = queue(renderVideo);
  renderQueue.enqueue(id);
  await renderQueue.idle();
}

const writes: RenderVideo = async ({ output }) => writeFile(output, 'mp4-bytes');

describe('timeline.render', () => {
  it('cuts each video clip from its original, renders from the slices, and keeps only the MP4', async () => {
    const { track, video, photo, render } = await setup();
    const paths = renderPaths(dataDir, render.projectId, render.id);
    let props: CompositionProps | undefined;
    let slicesDuringRender: string[] = [];
    await run(async (job) => {
      props = job.props;
      slicesDuringRender = ['a', 'c'].map((n) => paths.slice(`00000000-0000-4000-8000-00000000000${n}`)).filter((file) => existsSync(file));
      await writes(job);
    }, render.id);

    expect(await load(render.id)).toMatchObject({ state: 'done', progress: 1, error: null, sizeBytes: 9 });
    expect((await load(render.id)).finishedAt).toBeInstanceOf(Date);
    expect(await readFile(paths.output, 'utf8')).toBe('mp4-bytes');
    expect(existsSync(paths.tmp)).toBe(false);
    expect(slicesDuringRender).toHaveLength(2);
    expect(props!.music).toEqual({ src: `${BASE}/api/music/${track.id}/audio`, beats: expect.any(Array) });
    expect(props!.sources).toEqual({
      '00000000-0000-4000-8000-00000000000a': {
        kind: 'video',
        src: `${BASE}/api/renders/${render.id}/slices/00000000-0000-4000-8000-00000000000a.mp4`,
        startFromSec: 0.5,
        width: 720,
        height: 1280,
      },
      '00000000-0000-4000-8000-00000000000b': {
        kind: 'photo',
        src: `${BASE}/api/media/${photo.id}/preview`,
        startFromSec: 0,
        width: 3000,
        height: 4000,
      },
      '00000000-0000-4000-8000-00000000000c': expect.objectContaining({ startFromSec: expect.closeTo(0.2, 9) }),
    });
    expect(video.id).toBeDefined();
  });

  it('writes render progress as it goes', async () => {
    const { render } = await setup();
    const seen: number[] = [];
    await run(async (job) => {
      job.onProgress(0.5);
      await expect.poll(async () => (await load(render.id)).progress).toBe(0.5);
      seen.push((await load(render.id)).progress);
      await writes(job);
    }, render.id);
    expect(seen).toEqual([0.5]);
  });

  it('fails before cutting anything when less than 2 GB is free', async () => {
    const { render } = await setup();
    free = 2 * GB - 1;
    let called = false;
    await run(async () => {
      called = true;
    }, render.id);
    expect(await load(render.id)).toMatchObject({ state: 'failed', error: '磁碟空間不足，匯出至少需要 2 GB' });
    expect(called).toBe(false);
  });

  it('fails with the validation message when a clip’s media was deleted after the snapshot', async () => {
    const { render, photo } = await setup();
    await testDb.db.delete(media).where(eq(media.id, photo.id));
    await run(writes, render.id);
    expect(await load(render.id)).toMatchObject({ state: 'failed', error: '素材已刪除' });
  });

  it('fails a broken render, removes its slices, and points at the Chrome packages when the browser cannot start', async () => {
    const { render } = await setup();
    const paths = renderPaths(dataDir, render.projectId, render.id);
    await run(async () => {
      throw new Error('boom');
    }, render.id);
    expect(await load(render.id)).toMatchObject({ state: 'failed', error: '算圖失敗' });
    expect(existsSync(paths.tmp)).toBe(false);
    expect(errors).toHaveLength(1);

    const [again] = await testDb.db.insert(renders).values({ projectId: render.projectId, snapshot: render.snapshot }).returning();
    await run(async () => {
      throw new Error('Failed to launch the browser process!');
    }, again!.id);
    expect((await load(again!.id)).error).toBe('Remotion 的瀏覽器無法啟動，請安裝 README 列出的 Chrome 系統套件');
  });

  it('on startup clears leftover slices and renders again what a restart interrupted', async () => {
    const { render } = await setup();
    const states = ['preparing', 'rendering', 'done', 'failed'] as const;
    const rows = await testDb.db
      .insert(renders)
      .values(states.map((state) => ({ projectId: render.projectId, snapshot: render.snapshot, state })))
      .returning();
    const stray = renderPaths(dataDir, render.projectId, rows[2]!.id).tmp;
    await mkdir(stray, { recursive: true });

    const renderQueue = queue(writes);
    await renderQueue.recover();
    await renderQueue.idle();

    expect(existsSync(stray)).toBe(false);
    const after = await Promise.all([render, ...rows].map((row) => load(row.id)));
    expect(after.map((row) => row.state)).toEqual(['done', 'done', 'done', 'done', 'failed']);
  });

  it('on shutdown leaves the running render for the next start, logging no error', async () => {
    const { render } = await setup();
    const renderQueue = queue(
      ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')))),
    );
    renderQueue.enqueue(render.id);
    await expect.poll(async () => (await load(render.id)).state).toBe('rendering');
    await renderQueue.close();
    expect((await load(render.id)).state).toBe('rendering');
    expect(errors).toEqual([]);
  });
});
