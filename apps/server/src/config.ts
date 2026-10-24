import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AiProvider } from '@revcut/shared';
import { z } from 'zod';

const optionalKey = z
  .string()
  .optional()
  .transform((value) => value || undefined);

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];
const Effort = z.enum(EFFORTS).default('medium');

function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

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
    DEFAULT_TZ: z
      .string()
      .default('Asia/Taipei')
      .refine(isTimeZone, { error: '不是有效的 IANA 時區' }),
    AI_PROVIDER: AiProvider.default('anthropic'),
    ANTHROPIC_API_KEY: optionalKey,
    ANTHROPIC_MODEL: z.string().min(1).default('claude-opus-5-5'),
    ANTHROPIC_EFFORT: Effort,
    OPENAI_API_KEY: optionalKey,
    OPENAI_MODEL: optionalKey,
    OPENAI_REASONING_EFFORT: Effort,
  })
  .transform((env) => ({
    databaseUrl: env.DATABASE_URL,
    dataDir: env.DATA_DIR || path.join(os.homedir(), '.revcut', 'data'),
    hostDrive: env.HOST_DRIVE,
    port: env.PORT,
    defaultTz: env.DEFAULT_TZ,
    ai: {
      defaultProvider: env.AI_PROVIDER,
      anthropic: { apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL, effort: env.ANTHROPIC_EFFORT },
      openai: { apiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL, effort: env.OPENAI_REASONING_EFFORT },
    },
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
