import { drizzle } from 'drizzle-orm/postgres-js';
import type { Sql } from 'postgres';
import * as schema from './schema';

export function createDb(sql: Sql) {
  return drizzle(sql, { schema });
}

export type Db = ReturnType<typeof createDb>;
