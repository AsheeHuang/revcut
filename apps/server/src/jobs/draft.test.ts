import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Timeline } from '@revcut/shared';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { VisionAnalyzer } from '../ai/analyzer';
import { analysisRuns, media, mediaAnalysis, musicTracks, projects, timelines } from '../db/schema';
import { runProcess } from '../process';
import { mediaPaths } from '../storage/paths';
import { createTestDb } from '../test/db';
import { fakeAnalyzer, providersWith } from '../test/fakeAi';
import { createDraftQueue, type DraftRequest } from './draft';

let testDb: Awaited<ReturnType<typeof createTestDb>>;
let samples: string;
let dataDir: string;

beforeAll(async () => {
  testDb = await createTestDb();
  samples = await mkdtemp(path.join(os.tmpdir(), 'revcut-draft-samples-'));
  await sharp({ create: { width: 400, height: 300, channels: 3, background: '#888' } }).jpeg().toFile(path.join(samples, 'photo.jpg'));
  await runProcess(
    'ffmpeg',
    ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=30', '-t', '8', '-pix_fmt', 'yuv420p', path.join(samples, 'preview.mp4')],
    { signal: new AbortController().signal },
  );
});
afterAll(async () => {
  await testDb.close();
  await rm(samples, { recursive: true, force: true });
});
beforeEach(async () => {
  await testDb.reset();
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'revcut-draft-'));
  return () => rm(dataDir, { recursive: true, force: true });
});

const silent = { info: () => {}, error: () => {} };

async function addProject(draftState: typeof projects.$inferInsert.draftState = 'queued') {
  const [row] = await testDb.db.insert(projects).values({ title: '2026 一月', draftState }).returning();
  return row!;
}

async function addTrack() {
  const beats = Array.from({ length: 400 }, (_, i) => 0.3 + i * 0.5);
  const [row] = await testDb.db
    .insert(musicTracks)
    .values({
      title: 'song',
      filename: 'song.m4a',
      ext: 'm4a',
      sizeBytes: 1,
      status: 'ready',
      bpm: 120,
      beats,
      downbeatIndices: beats.map((_, i) => i).filter((i) => i % 4 === 0),
      energy: Array(400).fill(0.5),
    })
    .returning();
  return row!;
}

let sha = 0;
async function addMedia(projectId: string, n: number, values: Partial<typeof media.$inferInsert> = {}) {
  const rows = Array.from({ length: n }, (_, i) => ({
    projectId,
    kind: 'photo' as const,
    status: 'ready' as const,
    filename: `IMG_${i}.JPG`,
    ext: 'jpg',
    sizeBytes: 1,
    sha256: String(++sha),
    width: 3000,
    height: 4000,
    capturedAt: new Date(Date.UTC(2026, 0, 1 + i, 4)),
    utcOffsetMin: 480,
    ...values,
  }));
  const inserted = await testDb.db.insert(media).values(rows).returning();
  for (const row of inserted) {
    const paths = mediaPaths(dataDir, row);
    await mkdir(paths.derived, { recursive: true });
    if (row.kind === 'video') await copyFile(path.join(samples, 'preview.mp4'), paths.preview);
    else await copyFile(path.join(samples, 'photo.jpg'), paths.photo);
  }
  return inserted;
}

async function run(analyzers: VisionAnalyzer[], request: Omit<DraftRequest, 'provider' | 'reanalyze'> & Partial<DraftRequest>) {
  const queue = createDraftQueue({ db: testDb.db, dataDir, ai: providersWith(...analyzers), log: silent });
  queue.enqueue({ provider: 'openai', reanalyze: false, ...request });
  await queue.idle();
}

const loadProject = async (id: string) => (await testDb.db.select().from(projects).where(eq(projects.id, id)))[0]!;
const requeue = (id: string) => testDb.db.update(projects).set({ draftState: 'queued' }).where(eq(projects.id, id));
const usedMedia = (row: typeof timelines.$inferSelect) => new Set(Timeline.parse(row.data).clips.map((clip) => clip.mediaId));

describe('project.draft', () => {
  it('analyzes the media, records the run and its per-media rows, and plans a timeline from them', async () => {
    const project = await addProject();
    const track = await addTrack();
    const items = await addMedia(project.id, 30);
    const states: string[] = [];
    const ai = fakeAnalyzer({ onAnalyze: async () => void states.push((await loadProject(project.id)).draftState) });
    await run([ai.analyzer], { projectId: project.id, trackId: track.id, seed: 1234 });

    const done = await loadProject(project.id);
    expect(done).toMatchObject({ draftState: 'done', draftError: null });
    expect(states).toEqual(['analyzing']);

    const [runRow] = await testDb.db.select().from(analysisRuns);
    expect(runRow).toMatchObject({
      projectId: project.id,
      provider: 'openai',
      model: 'gpt-6-astra',
      effort: 'medium',
      status: 'done',
      inputTokens: 12000,
      outputTokens: 2500,
      costUsd: '0.2450',
    });
    expect(new Set(runRow!.mediaIds)).toEqual(new Set(items.map((item) => item.id)));
    expect((runRow!.response as { media: unknown[] }).media).toHaveLength(30);
    expect(await testDb.db.select().from(mediaAnalysis)).toHaveLength(30);

    const [row] = await testDb.db.select().from(timelines).where(eq(timelines.projectId, project.id));
    expect(row).toMatchObject({ id: done.currentTimelineId, seed: 1234, analysisRunId: runRow!.id });
    const timeline = Timeline.parse(row!.data);
    expect(timeline.music.trackId).toBe(track.id);
    expect(timeline.clips[0]!.date).toBe('2026.01.01');
  });

  it('sends each media in capture order with its frames: one per photo, clamp(ceil(dur / 1.5), 2, 8) per video', async () => {
    const project = await addProject();
    const track = await addTrack();
    await addMedia(project.id, 1, { kind: 'video', ext: 'mov', durationSec: 6, width: 1080, height: 1920, capturedAt: new Date(Date.UTC(2026, 0, 3)) });
    await addMedia(project.id, 1, { capturedAt: new Date(Date.UTC(2026, 0, 2)) });
    const ai = fakeAnalyzer();
    await run([ai.analyzer], { projectId: project.id, trackId: track.id, seed: 1 });

    const [items] = ai.calls;
    expect(items!.map((item) => [item.ref, item.kind, item.frames.length])).toEqual([
      ['m1', 'photo', 1],
      ['m2', 'video', 4],
    ]);
    expect(items![1]!.frames.map((frame) => frame.t)).toEqual([0.75, 2.25, 3.75, 5.25]);
    expect(items![1]!.frames.every((frame) => frame.width === 360 && frame.height === 640)).toBe(true);
  });

  it('plans with the analysis: unusable media and duplicates stay out, focus comes from the best moment', async () => {
    const project = await addProject();
    const track = await addTrack();
    const items = await addMedia(project.id, 6);
    const ai = fakeAnalyzer({
      verdict: (item) => {
        if (item.ref === 'm1') return { usable: false };
        if (item.ref === 'm2') return { duplicateOf: 'm3' };
        return { moments: [{ t: 0, score: 9, focusX: 0.2, focusY: 0.7 }] };
      },
    });
    await run([ai.analyzer], { projectId: project.id, trackId: track.id, seed: 1 });

    const [row] = await testDb.db.select().from(timelines);
    const clips = Timeline.parse(row!.data).clips;
    expect(usedMedia(row!)).toEqual(new Set(items.slice(2).map((item) => item.id)));
    expect(clips.every((clip) => clip.crop.focusX === 0.2 && clip.crop.focusY === 0.7)).toBe(true);
  });

  it('reuses the analysis for a new seed: no second run, no second call', async () => {
    const project = await addProject();
    const track = await addTrack();
    await addMedia(project.id, 8);
    const ai = fakeAnalyzer();
    await run([ai.analyzer], { projectId: project.id, trackId: track.id, seed: 1 });
    await requeue(project.id);
    await run([ai.analyzer], { projectId: project.id, trackId: track.id, seed: 2 });

    expect(ai.calls).toHaveLength(1);
    const runs = await testDb.db.select().from(analysisRuns);
    expect(runs).toHaveLength(1);
    const versions = await testDb.db.select().from(timelines);
    expect(versions.map((version) => version.analysisRunId)).toEqual([runs[0]!.id, runs[0]!.id]);
    expect(await loadProject(project.id)).toMatchObject({ draftState: 'done' });
  });

  it('reuses the analysis after a media is excluded, and analyzes again after one is added', async () => {
    const project = await addProject();
    const track = await addTrack();
    const [first] = await addMedia(project.id, 6);
    const ai = fakeAnalyzer();
    await run([ai.analyzer], { projectId: project.id, trackId: track.id, seed: 1 });

    await testDb.db.update(media).set({ excluded: true }).where(eq(media.id, first!.id));
    await requeue(project.id);
    await run([ai.analyzer], { projectId: project.id, trackId: track.id, seed: 1 });
    expect(ai.calls).toHaveLength(1);

    await addMedia(project.id, 1, { capturedAt: new Date(Date.UTC(2026, 1, 1)) });
    await requeue(project.id);
    await run([ai.analyzer], { projectId: project.id, trackId: track.id, seed: 1 });
    expect(ai.calls).toHaveLength(2);
    expect(ai.calls[1]).toHaveLength(6);
  });

  it('analyzes again when asked to, or for another provider', async () => {
    const project = await addProject();
    const track = await addTrack();
    await addMedia(project.id, 6);
    const gpt = fakeAnalyzer();
    const claude = fakeAnalyzer({ provider: 'anthropic' });
    await run([gpt.analyzer, claude.analyzer], { projectId: project.id, trackId: track.id, seed: 1 });
    await requeue(project.id);
    await run([gpt.analyzer, claude.analyzer], { projectId: project.id, trackId: track.id, seed: 1, reanalyze: true });
    await requeue(project.id);
    await run([gpt.analyzer, claude.analyzer], { projectId: project.id, trackId: track.id, seed: 1, provider: 'anthropic' });

    expect([gpt.calls.length, claude.calls.length]).toEqual([2, 1]);
    const runs = await testDb.db.select().from(analysisRuns);
    expect(runs.map((r) => r.provider).sort()).toEqual(['anthropic', 'openai', 'openai']);
  });

  it('fails the draft and the run with the AI’s reason, keeping what the failed call cost', async () => {
    const project = await addProject();
    const track = await addTrack();
    await addMedia(project.id, 3);
    await run([fakeAnalyzer({ fail: 'OpenAI 拒絕分析這批素材：no' }).analyzer], { projectId: project.id, trackId: track.id, seed: 1 });

    expect(await loadProject(project.id)).toMatchObject({ draftState: 'failed', draftError: 'OpenAI 拒絕分析這批素材：no', currentTimelineId: null });
    expect(await testDb.db.select().from(analysisRuns)).toMatchObject([
      { status: 'failed', error: 'OpenAI 拒絕分析這批素材：no', inputTokens: 12000, outputTokens: 2500, costUsd: '0.2450' },
    ]);
    expect(await testDb.db.select().from(mediaAnalysis)).toEqual([]);
    expect(await testDb.db.select().from(timelines)).toEqual([]);
  });

  it('fails without calling the AI when two frames per video would still be too many', async () => {
    const project = await addProject();
    const track = await addTrack();
    await addMedia(project.id, 4, { kind: 'video', ext: 'mov', durationSec: 8, width: 1080, height: 1920 });
    const ai = fakeAnalyzer();
    ai.analyzer.limits = { maxImages: 7, maxRequestBytes: 32 * 1024 ** 2 };
    await run([ai.analyzer], { projectId: project.id, trackId: track.id, seed: 1 });

    expect(ai.calls).toEqual([]);
    expect((await loadProject(project.id)).draftError).toMatch(/^素材太多/);
  });

  it('fails with the planner’s reason when nothing can be planned', async () => {
    const project = await addProject();
    const track = await addTrack();
    await addMedia(project.id, 2);
    await run([fakeAnalyzer({ verdict: () => ({ usable: false }) }).analyzer], { projectId: project.id, trackId: track.id, seed: 1 });

    expect(await loadProject(project.id)).toMatchObject({ draftState: 'failed', draftError: '素材不足', currentTimelineId: null });
    expect(await testDb.db.select().from(timelines)).toEqual([]);
  });

  it('fails when the song was deleted after the draft was queued', async () => {
    const project = await addProject();
    await addMedia(project.id, 3);
    await run([fakeAnalyzer().analyzer], { projectId: project.id, trackId: '00000000-0000-4000-8000-000000000000', seed: 1 });
    expect(await loadProject(project.id)).toMatchObject({ draftState: 'failed', draftError: '找不到歌曲，或歌曲還沒分析完成' });
  });

  it('does nothing for a project that is not queued', async () => {
    const project = await addProject('done');
    const track = await addTrack();
    await addMedia(project.id, 3);
    const ai = fakeAnalyzer();
    await run([ai.analyzer], { projectId: project.id, trackId: track.id, seed: 1 });
    expect(ai.calls).toEqual([]);
    expect(await testDb.db.select().from(analysisRuns)).toEqual([]);
    expect(await testDb.db.select().from(timelines)).toEqual([]);
  });

  it('on startup fails drafts and analyses a restart interrupted instead of paying for them twice', async () => {
    const states = ['idle', 'queued', 'analyzing', 'planning', 'done', 'failed'] as const;
    const rows = await Promise.all(states.map((state) => addProject(state)));
    await testDb.db.insert(analysisRuns).values({
      projectId: rows[2]!.id,
      mediaIds: [],
      provider: 'openai',
      model: 'gpt-6-astra',
      effort: 'medium',
      status: 'running',
    });
    await createDraftQueue({ db: testDb.db, dataDir, ai: providersWith(), log: silent }).recover();

    const after = await Promise.all(rows.map((row) => loadProject(row.id)));
    expect(after.map((p) => [p.draftState, p.draftError])).toEqual([
      ['idle', null],
      ['failed', '伺服器重啟中斷，請重試'],
      ['failed', '伺服器重啟中斷，請重試'],
      ['failed', '伺服器重啟中斷，請重試'],
      ['done', null],
      ['failed', null],
    ]);
    expect(await testDb.db.select({ status: analysisRuns.status, error: analysisRuns.error }).from(analysisRuns)).toEqual([
      { status: 'failed', error: '伺服器重啟中斷' },
    ]);
  });
});
