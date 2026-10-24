import { defineConfig } from 'drizzle-kit';

process.loadEnvFile('../../.env');
const url = process.env.DATABASE_URL;
if (!url) throw new Error('.env 沒有設定 DATABASE_URL');

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url },
});
