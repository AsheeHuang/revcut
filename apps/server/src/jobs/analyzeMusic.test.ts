import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { musicTracks } from '../db/schema';
import { runProcess } from '../process';
import { musicPaths } from '../storage/paths';
import { createTestDb } from '../test/db';
import { type AnalyzeBeats, createMusicQueue } from './analyzeMusic';

const never = new AbortController().signal;
let testDb: Awaited<ReturnType<typeof createTestDb>>;
let samples: string;
let dataDir: string;

beforeAll(async () => {
  testDb = await createTestDb();
  samples = await mkdtemp(path.join(os.tmpdir(), 'revcut-music-samples-'));
  await runProcess(
    'ffmpeg',
    ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4:sample_rate=48000', '-ac', '2', path.join(samples, 'song.m4a')],
    { signal: never },
  );
}, 60_000);

afterAll(async () => {
  await testDb.close();
  await rm(samples, { recursive: true, force: true });
});

beforeEach(async () => {
  await testDb.reset();
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'revcut-music-'));
  return () => rm(dataDir, { recursive: true, force: true });
});

function beatGrid(seconds: number, downbeatEvery = 4) {
  const beats = Array.from({ length: seconds * 2 }, (_, i) => 0.25 + i * 0.5);
  const downbeatIndices = beats.map((_, i) => i).filter((i) => i % downbeatEvery === 0);
  return { bpm: 120, beats, downbeatIndices, energy: { hopSec: 0.5, values: Array(seconds * 2).fill(0.5) } };
}

const answer = (output: unknown): AnalyzeBeats => async () => `${JSON.stringify(output)}\n`;

function queue(analyzeBeats: AnalyzeBeats) {
  return createMusicQueue({ db: testDb.db, dataDir, analyzeBeats, log: { info: () => {}, error: () => {} } });
}

async function addTrack(values: Partial<typeof musicTracks.$inferInsert> = {}) {
  const [row] = await testDb.db
    .insert(musicTracks)
    .values({ title: 'song', filename: 'song.m4a', ext: 'm4a', sizeBytes: 1, ...values })
    .returning();
  const paths = musicPaths(dataDir, row!);
  await mkdir(path.dirname(paths.file), { recursive: true });
  await runProcess('cp', [path.join(samples, 'song.m4a'), paths.file], { signal: never });
  return { row: row!, paths };
}

const load = async (id: string) => (await testDb.db.select().from(musicTracks).where(eq(musicTracks.id, id)))[0]!;

async function run(analyzeBeats: AnalyzeBeats, id: string) {
  const music = queue(analyzeBeats);
  music.enqueue(id);
  await music.idle();
}

describe('music.analyze', () => {
  it('hands the analyzer a 44.1 kHz mono wav and stores its beats', async () => {
    const { row, paths } = await addTrack();
    const output = beatGrid(60);
    let wav: unknown;
    await run(async (file, signal) => {
      const { stdout } = await runProcess(
        'ffprobe',
        ['-v', 'error', '-show_entries', 'stream=codec_name,sample_rate,channels', '-of', 'json', file],
        { signal },
      );
      wav = JSON.parse(stdout).streams[0];
      return JSON.stringify(output);
    }, row.id);

    expect(wav).toEqual({ codec_name: 'pcm_s16le', sample_rate: '44100', channels: 1 });
    const stored = await load(row.id);
    expect(stored).toMatchObject({
      status: 'ready',
      error: null,
      bpm: 120,
      beats: output.beats,
      downbeatIndices: output.downbeatIndices,
      energy: output.energy.values,
    });
    expect(stored.durationSec).toBeCloseTo(4, 1);
    expect(existsSync(paths.tmp)).toBe(false);
  });

  it('fails a song too short for a 20 s section', async () => {
    const { row } = await addTrack();
    await run(answer(beatGrid(18)), row.id);
    expect(await load(row.id)).toMatchObject({ status: 'failed', error: '歌曲太短，湊不出 20 秒', beats: null });
  });

  it('fails a song without downbeats', async () => {
    const { row } = await addTrack();
    await run(answer({ ...beatGrid(60), downbeatIndices: [] }), row.id);
    expect(await load(row.id)).toMatchObject({ status: 'failed', error: '偵測不到重拍' });
  });

  it('fails with a step message when the analyzer output is malformed', async () => {
    const { row, paths } = await addTrack();
    await run(answer({ ...beatGrid(60), beats: [3, 2, 1] }), row.id);
    expect(await load(row.id)).toMatchObject({ status: 'failed', error: '拍點分析失敗' });
    expect(existsSync(paths.tmp)).toBe(false);
  });

  it('fails a file ffmpeg cannot decode', async () => {
    const { row, paths } = await addTrack();
    await writeFile(paths.file, 'not audio');
    await run(answer(beatGrid(60)), row.id);
    expect(await load(row.id)).toMatchObject({ status: 'failed', error: '解碼音樂失敗' });
  });

  it('on startup clears leftovers and finishes tracks a restart left waiting or analyzing', async () => {
    const analyzing = await addTrack({ status: 'analyzing' });
    const waiting = await addTrack();
    await mkdir(analyzing.paths.tmp, { recursive: true });
    await writeFile(analyzing.paths.wav, 'half written');
    await writeFile(`${waiting.paths.file}.part`, 'interrupted upload');

    const music = queue(answer(beatGrid(60)));
    await music.recover();
    await music.idle();

    expect((await load(analyzing.row.id)).status).toBe('ready');
    expect((await load(waiting.row.id)).status).toBe('ready');
    expect(existsSync(`${waiting.paths.file}.part`)).toBe(false);
    expect(existsSync(analyzing.paths.tmp)).toBe(false);
  });

  it('on shutdown leaves the running track analyzing and the waiting one uploaded, logging no errors', async () => {
    const running = await addTrack();
    const waiting = await addTrack();
    const errors: unknown[] = [];
    const music = createMusicQueue({
      db: testDb.db,
      dataDir,
      analyzeBeats: (_file, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
      log: { info: () => {}, error: (...args: unknown[]) => errors.push(args) },
    });
    music.enqueue(running.row.id);
    music.enqueue(waiting.row.id);
    await expect.poll(async () => (await load(running.row.id)).status).toBe('analyzing');
    await music.close();
    expect(await load(running.row.id)).toMatchObject({ status: 'analyzing', error: null });
    expect((await load(waiting.row.id)).status).toBe('uploaded');
    expect(errors).toEqual([]);
  });
});
