import path from 'node:path';
import { ensureBrowser, openBrowser } from '@remotion/renderer';
import { HealthCheckName, type HealthResponse } from '@revcut/shared';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { type Config, repoRoot } from './config';
import { runProcess } from './process';
import { freeBytes, MIN_FREE_BYTES } from './storage/disk';

type ProbeResult = { ok: boolean; detail: string };
export type Probe = { required: boolean; timeoutMs: number; run: (signal: AbortSignal) => Promise<ProbeResult> };
export type HealthChecks = Record<HealthCheckName, Probe>;

async function runProbe(probe: Probe): Promise<ProbeResult> {
  const signal = AbortSignal.timeout(probe.timeoutMs);
  const timedOut = new Promise<never>((_, reject) => signal.addEventListener('abort', reject, { once: true }));
  try {
    return await Promise.race([probe.run(signal), timedOut]);
  } catch (error) {
    if (signal.aborted) return { ok: false, detail: `逾時（超過 ${probe.timeoutMs / 1000} 秒）` };
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

export async function runHealthChecks(checks: HealthChecks): Promise<HealthResponse> {
  const results = await Promise.all(
    HealthCheckName.options.map(async (name) => {
      const { required } = checks[name];
      return { name, required, ...(await runProbe(checks[name])) };
    }),
  );
  return { ok: results.every((check) => check.ok || !check.required), checks: results };
}

async function toolOutput(command: string, args: string[], installHint: string, signal: AbortSignal) {
  try {
    return (await runProcess(command, args, { signal })).stdout;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`找不到 ${command}，${installHint}`);
    throw error;
  }
}

const firstLine = (text: string) => text.trim().split('\n')[0] ?? '';

function apiKey(value: string | undefined, envName: string): Probe {
  return {
    required: false,
    timeoutMs: 1000,
    run: async () => (value ? { ok: true, detail: '已設定' } : { ok: false, detail: `未設定 ${envName}` }),
  };
}

const DoctorOutput = z.object({ ok: z.boolean(), python: z.string() });
const GB = 1024 ** 3;

export function createHealthChecks(config: Config, sql: Sql): HealthChecks {
  return {
    database: {
      required: true,
      timeoutMs: 3000,
      run: async () => {
        await sql`select 1`;
        return { ok: true, detail: '已連線' };
      },
    },
    disk: {
      required: true,
      timeoutMs: 3000,
      run: async () => {
        const bytes = await freeBytes(config.dataDir, config.hostDrive);
        const ok = bytes >= MIN_FREE_BYTES;
        const where = `${config.dataDir} 與 ${config.hostDrive} 取較小值`;
        return { ok, detail: `剩餘 ${(bytes / GB).toFixed(1)} GB（${where}）${ok ? '' : '，至少需要 2 GB'}` };
      },
    },
    ffmpeg: {
      required: true,
      timeoutMs: 5000,
      run: async (signal) => {
        const filters = await toolOutput('ffmpeg', ['-hide_banner', '-filters'], '請安裝：sudo apt install ffmpeg', signal);
        const missing = ['zscale', 'tonemap'].filter((name) => !new RegExp(`^\\s*\\S+\\s+${name}\\s`, 'm').test(filters));
        if (missing.length > 0) {
          return { ok: false, detail: `ffmpeg 缺少 ${missing.join('、')} 濾鏡，需要含 libzimg 的版本` };
        }
        return { ok: true, detail: '含 zscale、tonemap 濾鏡' };
      },
    },
    ffprobe: {
      required: true,
      timeoutMs: 5000,
      run: async (signal) => ({
        ok: true,
        detail: firstLine(await toolOutput('ffprobe', ['-version'], '請安裝：sudo apt install ffmpeg', signal)),
      }),
    },
    exiftool: {
      required: true,
      timeoutMs: 5000,
      run: async (signal) => {
        const version = await toolOutput('exiftool', ['-ver'], '請安裝：sudo apt install libimage-exiftool-perl', signal);
        return { ok: true, detail: `exiftool ${version.trim()}` };
      },
    },
    heifConvert: {
      required: true,
      timeoutMs: 5000,
      run: async (signal) => {
        await toolOutput('heif-convert', ['-h'], '請安裝：sudo apt install libheif-examples', signal);
        return { ok: true, detail: '已安裝' };
      },
    },
    analyzer: {
      required: true,
      timeoutMs: 60_000,
      run: async (signal) => {
        const project = path.join(repoRoot, 'analyzer');
        const stdout = await toolOutput(
          'uv',
          ['run', '--project', project, 'python', '-m', 'analyzer', 'doctor'],
          '請安裝 uv：https://docs.astral.sh/uv/',
          signal,
        );
        const doctor = DoctorOutput.parse(JSON.parse(stdout.trim().split('\n').at(-1) ?? ''));
        return { ok: doctor.ok, detail: `Python ${doctor.python}` };
      },
    },
    remotionBrowser: {
      required: true,
      timeoutMs: 180_000,
      run: async () => {
        try {
          await ensureBrowser();
          const browser = await openBrowser('chrome');
          await browser.close({ silent: true });
          return { ok: true, detail: '可以啟動' };
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(`Remotion 的瀏覽器無法啟動，請安裝 README 列出的 Chrome 系統套件。原因：${reason}`);
        }
      },
    },
    anthropicKey: apiKey(config.anthropicApiKey, 'ANTHROPIC_API_KEY'),
    openaiKey: apiKey(config.openaiApiKey, 'OPENAI_API_KEY'),
    googleMapsKey: apiKey(config.googleMapsApiKey, 'GOOGLE_MAPS_API_KEY'),
  };
}
