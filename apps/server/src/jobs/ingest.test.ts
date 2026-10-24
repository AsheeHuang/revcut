import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { media, projects } from '../db/schema';
import { runProcess } from '../process';
import { mediaPaths } from '../storage/paths';
import { createTestDb } from '../test/db';
import { createIngestQueue } from './ingest';

const never = new AbortController().signal;
let testDb: Awaited<ReturnType<typeof createTestDb>>;
let samples: string;
let dataDir: string;
let projectId: string;

beforeAll(async () => {
  testDb = await createTestDb();
  samples = await mkdtemp(path.join(os.tmpdir(), 'revcut-samples-'));
  const ff = (args: string[]) => runProcess('ffmpeg', ['-y', '-v', 'error', ...args], { signal: never });
  await ff([
    ...['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=60', '-f', 'lavfi', '-i', 'sine', '-t', '2'],
    ...['-c:v', 'libx264', '-c:a', 'aac', '-metadata', 'creation_time=2026-10-03T06:22:10Z'],
    path.join(samples, 'clip.mp4'),
  ]);
  await ff(['-f', 'lavfi', '-i', 'testsrc2=size=4000x3000', '-frames:v', '1', path.join(samples, 'photo.jpg')]);
}, 60_000);

afterAll(async () => {
  await testDb.close();
  await rm(samples, { recursive: true, force: true });
});

beforeEach(async () => {
  await testDb.reset();
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'revcut-ingest-'));
  const [project] = await testDb.db.insert(projects).values({ title: 't' }).returning();
  projectId = project!.id;
  return () => rm(dataDir, { recursive: true, force: true });
});

function queue() {
  return createIngestQueue({ db: testDb.db, dataDir, defaultTz: 'Asia/Taipei', log: { info: () => {}, error: () => {} } });
}

async function addMedia(sample: string, filename: string, values: Partial<typeof media.$inferInsert> = {}) {
  const ext = path.extname(filename).slice(1).toLowerCase();
  const kind = ext === 'jpg' ? 'photo' : 'video';
  const [row] = await testDb.db
    .insert(media)
    .values({ projectId, kind, filename, ext, sizeBytes: 1, sha256: filename, ...values })
    .returning();
  const paths = mediaPaths(dataDir, row!);
  await mkdir(path.dirname(paths.original), { recursive: true });
  if (sample) await copyFile(path.join(samples, sample), paths.original);
  return { row: row!, paths };
}

const load = async (id: string) => (await testDb.db.select().from(media).where(eq(media.id, id)))[0]!;

async function probe(file: string) {
  const { stdout } = await runProcess(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,avg_frame_rate,color_transfer', '-of', 'json', file],
    { signal: never },
  );
  return JSON.parse(stdout).streams[0];
}

describe('media.ingest', () => {
  it('turns an uploaded video into a ready one with a 30 fps SDR preview and a thumb', async () => {
    const { row, paths } = await addMedia('clip.mp4', 'clip.mp4');
    const ingest = queue();
    ingest.enqueue(row.id);
    await ingest.idle();

    expect(await load(row.id)).toMatchObject({
      status: 'ready',
      error: null,
      width: 640,
      height: 360,
      isHdr: false,
      hasAudio: true,
      capturedAt: new Date('2026-10-03T06:22:10Z'),
      utcOffsetMin: 480,
    });
    expect(await probe(paths.preview)).toMatchObject({ width: 640, height: 360, avg_frame_rate: '30/1', color_transfer: 'bt709' });
    expect((await readdir(paths.derived)).sort()).toEqual(['preview.mp4', 'thumb.webp']);
  });

  it('makes a photo capped at 3072 on the long edge, dated by lastModified when EXIF has no date', async () => {
    const lastModified = new Date('2026-10-05T00:00:00Z');
    const { row, paths } = await addMedia('photo.jpg', 'photo.jpg', { fileLastModified: lastModified });
    const ingest = queue();
    ingest.enqueue(row.id);
    await ingest.idle();

    expect(await load(row.id)).toMatchObject({ status: 'ready', width: 4000, height: 3000, capturedAt: lastModified });
    expect(await probe(paths.photo)).toMatchObject({ width: 3072, height: 2304 });
    expect(await probe(paths.thumb)).toMatchObject({ width: 360, height: 270 });
  });

  it('fails with a Traditional Chinese message when the content does not match the extension', async () => {
    const { row, paths } = await addMedia('', 'fake.mov');
    await writeFile(paths.original, 'not a video');
    const ingest = queue();
    ingest.enqueue(row.id);
    await ingest.idle();
    expect(await load(row.id)).toMatchObject({ status: 'failed', error: '檔案內容不是影片，請確認副檔名' });
    expect(existsSync(paths.derivedTmp)).toBe(false);
  });

  it('runs a queued id once even when it is queued twice', async () => {
    const { row } = await addMedia('photo.jpg', 'photo.jpg');
    const ingest = queue();
    ingest.enqueue(row.id);
    ingest.enqueue(row.id);
    await ingest.idle();
    expect((await load(row.id)).status).toBe('ready');
  });

  it('on startup clears leftovers and finishes media a crash left in processing', async () => {
    const { row, paths } = await addMedia('photo.jpg', 'photo.jpg', { status: 'processing' });
    const waiting = await addMedia('clip.mp4', 'clip.mp4');
    await mkdir(paths.derivedTmp, { recursive: true });
    await writeFile(path.join(paths.derivedTmp, 'photo.jpg'), 'half written');
    await writeFile(`${waiting.paths.original}.part`, 'interrupted upload');

    const ingest = queue();
    await ingest.recover();
    await ingest.idle();

    expect((await load(row.id)).status).toBe('ready');
    expect((await load(waiting.row.id)).status).toBe('ready');
    expect(existsSync(`${waiting.paths.original}.part`)).toBe(false);
    expect(existsSync(paths.derivedTmp)).toBe(false);
  });
});
