import { Timeline } from '@revcut/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { media, musicTracks, projects, timelines } from '../db/schema';
import { createTestDb } from '../test/db';
import { createDraftQueue } from './draft';

let testDb: Awaited<ReturnType<typeof createTestDb>>;

beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(async () => {
  await testDb.close();
});
beforeEach(async () => {
  await testDb.reset();
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

async function addMedia(projectId: string, n: number, values: Partial<typeof media.$inferInsert> = {}) {
  const rows = Array.from({ length: n }, (_, i) => ({
    projectId,
    kind: 'photo' as const,
    status: 'ready' as const,
    filename: `IMG_${i}.JPG`,
    ext: 'jpg',
    sizeBytes: 1,
    sha256: `${projectId}-${i}`,
    width: 3000,
    height: 4000,
    capturedAt: new Date(Date.UTC(2026, 0, 1 + i, 4)),
    utcOffsetMin: 480,
    ...values,
  }));
  return testDb.db.insert(media).values(rows).returning();
}

async function run(request: Parameters<ReturnType<typeof createDraftQueue>['enqueue']>[0]) {
  const queue = createDraftQueue({ db: testDb.db, log: silent });
  queue.enqueue(request);
  await queue.idle();
}

const loadProject = async (id: string) => (await testDb.db.select().from(projects).where(eq(projects.id, id)))[0]!;

describe('project.draft', () => {
  it('plans a queued project into a new current timeline that remembers its seed', async () => {
    const project = await addProject();
    const track = await addTrack();
    const items = await addMedia(project.id, 30);
    await run({ projectId: project.id, trackId: track.id, seed: 1234 });

    const done = await loadProject(project.id);
    expect(done).toMatchObject({ draftState: 'done', draftError: null });
    const [row] = await testDb.db.select().from(timelines).where(eq(timelines.projectId, project.id));
    expect(row).toMatchObject({ id: done.currentTimelineId, seed: 1234, analysisRunId: null });
    const timeline = Timeline.parse(row!.data);
    expect(timeline.music.trackId).toBe(track.id);
    expect(timeline.clips.every((clip) => items.some((m) => m.id === clip.mediaId))).toBe(true);
    expect(timeline.clips[0]!.date).toBe('2026.01.01');
  });

  it('plans the same timeline again from the same seed', async () => {
    const project = await addProject();
    const track = await addTrack();
    await addMedia(project.id, 30);
    await run({ projectId: project.id, trackId: track.id, seed: 7 });
    await testDb.db.update(projects).set({ draftState: 'queued' }).where(eq(projects.id, project.id));
    await run({ projectId: project.id, trackId: track.id, seed: 7 });

    const rows = await testDb.db.select().from(timelines).where(eq(timelines.projectId, project.id));
    expect(rows).toHaveLength(2);
    expect(rows[0]!.data).toEqual(rows[1]!.data);
  });

  it('leaves out excluded media and photos hidden behind their Live Photo video', async () => {
    const project = await addProject();
    const track = await addTrack();
    const [kept] = await addMedia(project.id, 1);
    await addMedia(project.id, 1, { sha256: 'excluded', excluded: true });
    const [heic] = await addMedia(project.id, 1, { sha256: 'heic', contentIdentifier: 'LIVE' });
    const [mov] = await addMedia(project.id, 1, { sha256: 'mov', kind: 'video', ext: 'mov', durationSec: 3, contentIdentifier: 'LIVE' });
    await run({ projectId: project.id, trackId: track.id, seed: 1 });

    const [row] = await testDb.db.select().from(timelines);
    const used = new Set(Timeline.parse(row!.data).clips.map((clip) => clip.mediaId));
    expect(used).toEqual(new Set([kept!.id, mov!.id]));
    expect(used.has(heic!.id)).toBe(false);
  });

  it('fails with the planner’s reason when nothing can be planned', async () => {
    const project = await addProject();
    const track = await addTrack();
    await addMedia(project.id, 2, { excluded: true });
    await run({ projectId: project.id, trackId: track.id, seed: 1 });

    expect(await loadProject(project.id)).toMatchObject({ draftState: 'failed', draftError: '素材不足', currentTimelineId: null });
    expect(await testDb.db.select().from(timelines)).toEqual([]);
  });

  it('fails when the song was deleted after the draft was queued', async () => {
    const project = await addProject();
    await addMedia(project.id, 3);
    await run({ projectId: project.id, trackId: '00000000-0000-4000-8000-000000000000', seed: 1 });
    expect(await loadProject(project.id)).toMatchObject({ draftState: 'failed', draftError: '找不到歌曲，或歌曲還沒分析完成' });
  });

  it('does nothing for a project that is not queued', async () => {
    const project = await addProject('done');
    const track = await addTrack();
    await addMedia(project.id, 3);
    await run({ projectId: project.id, trackId: track.id, seed: 1 });
    expect(await testDb.db.select().from(timelines)).toEqual([]);
  });

  it('on startup fails drafts a restart interrupted instead of paying for them twice', async () => {
    const states = ['idle', 'queued', 'analyzing', 'planning', 'done', 'failed'] as const;
    const rows = await Promise.all(states.map((state) => addProject(state)));
    await createDraftQueue({ db: testDb.db, log: silent }).recover();

    const after = await Promise.all(rows.map((row) => loadProject(row.id)));
    expect(after.map((p) => [p.draftState, p.draftError])).toEqual([
      ['idle', null],
      ['failed', '伺服器重啟中斷，請重試'],
      ['failed', '伺服器重啟中斷，請重試'],
      ['failed', '伺服器重啟中斷，請重試'],
      ['done', null],
      ['failed', null],
    ]);
  });
});
