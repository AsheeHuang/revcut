import postgres from 'postgres';
import { apiRoutes } from './api';
import { buildApp } from './app';
import { loadConfig } from './config';
import { createDb } from './db/client';
import { createHealthChecks } from './health';
import { analyzeBeatsWithUv, createMusicQueue } from './jobs/analyzeMusic';
import { createDraftQueue } from './jobs/draft';
import { createIngestQueue } from './jobs/ingest';
import { createRenderQueue } from './jobs/render';
import { renderWithRemotion } from './render/remotion';
import { freeBytes } from './storage/disk';

const config = loadConfig();
const sql = postgres(config.databaseUrl);
const db = createDb(sql);
const app = buildApp({ checks: createHealthChecks(config, sql), logger: true });
const ingest = createIngestQueue({ db, dataDir: config.dataDir, defaultTz: config.defaultTz, log: app.log });
const music = createMusicQueue({ db, dataDir: config.dataDir, analyzeBeats: analyzeBeatsWithUv, log: app.log });
const draft = createDraftQueue({ db, log: app.log });
const render = createRenderQueue({
  db,
  dataDir: config.dataDir,
  baseUrl: `http://127.0.0.1:${config.port}`,
  freeBytes: () => freeBytes(config.dataDir, config.hostDrive),
  renderVideo: renderWithRemotion,
  log: app.log,
});

await app.register(apiRoutes, {
  db,
  dataDir: config.dataDir,
  freeBytes: () => freeBytes(config.dataDir, config.hostDrive),
  enqueueIngest: ingest.enqueue,
  enqueueAnalyze: music.enqueue,
  enqueueDraft: draft.enqueue,
  enqueueRender: render.enqueue,
});
app.addHook('onClose', async () => {
  await Promise.all([ingest.close(), music.close(), draft.close(), render.close()]);
  await sql.end();
});

await ingest.recover();
await music.recover();
await draft.recover();
await app.listen({ host: '127.0.0.1', port: config.port });
// After listen: an export fetches its slices and music from this server.
await render.recover();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void app.close());
}
