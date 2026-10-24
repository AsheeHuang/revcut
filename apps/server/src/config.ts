import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

const optionalKey = z
  .string()
  .optional()
  .transform((value) => value || undefined);

const Env = z
  .object({
    DATABASE_URL: z.string({ error: '必須設定' }).min(1, '必須設定'),
    DATA_DIR: z
      .string()
      .default('')
      .refine((value) => value === '' || path.isAbsolute(value), {
        error: '必須是絕對路徑（.env 不會展開 ~），或留空使用 ~/.revcut/data',
      }),
    HOST_DRIVE: z.string().min(1).default('/mnt/c'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    ANTHROPIC_API_KEY: optionalKey,
    OPENAI_API_KEY: optionalKey,
    GOOGLE_MAPS_API_KEY: optionalKey,
  })
  .transform((env) => ({
    databaseUrl: env.DATABASE_URL,
    dataDir: env.DATA_DIR || path.join(os.homedir(), '.revcut', 'data'),
    hostDrive: env.HOST_DRIVE,
    port: env.PORT,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    openaiApiKey: env.OPENAI_API_KEY,
    googleMapsApiKey: env.GOOGLE_MAPS_API_KEY,
  }));

export type Config = z.output<typeof Env>;

export function parseConfig(env: Record<string, string | undefined>): Config {
  const result = Env.safeParse(env);
  if (!result.success) throw new Error(`.env 設定錯誤：\n${z.prettifyError(result.error)}`);
  return result.data;
}

export const repoRoot = path.resolve(import.meta.dirname, '../../..');

export function loadConfig(): Config {
  const envFile = path.join(repoRoot, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  return parseConfig(process.env);
}
