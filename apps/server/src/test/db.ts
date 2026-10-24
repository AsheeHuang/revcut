import path from 'node:path';
import { sql as raw } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { loadConfig } from '../config';
import { createDb } from '../db/client';

// Tests run against a separate revcut_test database in the same Postgres.
export async function createTestDb() {
  const url = new URL(loadConfig().databaseUrl);
  const admin = postgres({ ...adminOptions(url), onnotice: () => {} });
  const [exists] = await admin`select 1 from pg_database where datname = 'revcut_test'`;
  if (!exists) await admin`create database revcut_test`;
  await admin.end();

  url.pathname = '/revcut_test';
  const sql = postgres(url.toString(), { onnotice: () => {} });
  const db = createDb(sql);
  await migrate(db, { migrationsFolder: path.join(import.meta.dirname, '../../drizzle') });
  return {
    db,
    reset: () => db.execute(raw`truncate projects, music_tracks cascade`),
    close: () => sql.end(),
  };
}

function adminOptions(url: URL) {
  return {
    host: url.hostname,
    port: Number(url.port || 5432),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: 'postgres',
  };
}
