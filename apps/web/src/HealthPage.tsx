import { ApiError, type HealthCheck, type HealthCheckName, HealthResponse } from '@revcut/shared';
import { useCallback, useEffect, useState } from 'react';

const LABELS: Record<HealthCheckName, string> = {
  database: '資料庫',
  disk: '剩餘空間',
  ffmpeg: 'ffmpeg',
  ffprobe: 'ffprobe',
  exiftool: 'exiftool',
  heifConvert: 'heif-convert',
  analyzer: 'Python analyzer',
  remotionBrowser: 'Remotion 瀏覽器',
  anthropicKey: 'Anthropic API key',
  openaiKey: 'OpenAI API key',
  googleMapsKey: 'Google Maps API key',
};

const MARKS = {
  passed: { text: '✓ 通過', className: 'text-green-700' },
  failed: { text: '✗ 失敗', className: 'text-red-700' },
  skipped: { text: '– 未設定', className: 'text-slate-500' },
};

function markOf(check: HealthCheck): keyof typeof MARKS {
  if (check.ok) return 'passed';
  return check.required ? 'failed' : 'skipped';
}

type State =
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | { status: 'loaded'; health: HealthResponse };

async function fetchHealth(): Promise<HealthResponse> {
  const res = await fetch('/api/health');
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const parsed = ApiError.safeParse(body);
    throw new Error(parsed.success ? parsed.data.error.message : `伺服器回應 ${res.status}`);
  }
  return HealthResponse.parse(body);
}

export function HealthPage() {
  const [state, setState] = useState<State>({ status: 'loading' });

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      setState({ status: 'loaded', health: await fetchHealth() });
    } catch (error) {
      setState({ status: 'failed', message: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="mx-auto max-w-3xl p-8 text-slate-900">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">系統檢查</h1>
        <button
          type="button"
          onClick={load}
          disabled={state.status === 'loading'}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          {state.status === 'loading' ? '檢查中…' : '重新檢查'}
        </button>
      </header>

      {state.status === 'failed' && (
        <p className="rounded-md bg-red-50 p-4 text-red-700">無法取得檢查結果：{state.message}</p>
      )}

      {state.status === 'loaded' && (
        <>
          <p
            className={`mb-4 rounded-md p-4 font-medium ${
              state.health.ok ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-700'
            }`}
          >
            {state.health.ok ? '所有必要項目都通過' : '有必要項目沒有通過，請依說明處理'}
          </p>
          <ul className="divide-y divide-slate-200 rounded-md border border-slate-200">
            {state.health.checks.map((check) => (
              <li key={check.name} className="flex gap-4 p-4">
                <span className={`w-16 shrink-0 font-medium ${MARKS[markOf(check)].className}`}>
                  {MARKS[markOf(check)].text}
                </span>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{LABELS[check.name]}</span>
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
                      {check.required ? '必要' : '選用'}
                    </span>
                  </div>
                  <p className="mt-1 break-words text-sm text-slate-600">{check.detail}</p>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
