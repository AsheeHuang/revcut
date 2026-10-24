import { AiConfig, type AiProvider, DraftEstimate, type Project } from '@revcut/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, messageOf } from './api';

const PROVIDER_NAMES = { anthropic: 'Claude', openai: 'OpenAI' } as const satisfies Record<AiProvider, string>;

// SPEC §11.2: only providers with an API key are offered, AI_PROVIDER first; the estimate follows the choice.
export function useAiChoice(project: Project) {
  const config = useQuery({ queryKey: ['config'], queryFn: () => api(AiConfig, '/api/config') });
  const available = config.data?.aiProviders.filter((provider) => provider.available) ?? [];
  const [chosen, setChosen] = useState<AiProvider | null>(null);
  const provider =
    available.find((p) => p.id === chosen)?.id ?? available.find((p) => p.id === config.data?.defaultProvider)?.id ?? available[0]?.id;
  const estimate = useQuery({
    queryKey: ['project', project.id, 'draft-estimate', provider, project.draftState, project.mediaCounts],
    queryFn: () => api(DraftEstimate, `/api/projects/${project.id}/draft-estimate?provider=${provider}`),
    enabled: provider !== undefined,
  });
  return { config, available, provider, choose: setChosen, estimate };
}

export type AiChoiceState = ReturnType<typeof useAiChoice>;

function formatUsd(usd: number): string {
  return usd < 0.01 ? '不到 US$0.01' : `約 US$${usd.toFixed(2)}`;
}

function EstimateHint({ estimate }: { estimate: AiChoiceState['estimate'] }) {
  if (estimate.isError) return <span className="text-amber-700">{messageOf(estimate.error)}</span>;
  if (!estimate.data) return null;
  const { reuse, estimatedUsd, mediaCount, imageCount } = estimate.data;
  if (reuse) return <span className="text-slate-500">會重用上次的 AI 分析，不另外花費</span>;
  return (
    <span className="text-slate-600 tabular-nums" data-testid="cost-hint">
      需要 AI 分析 {mediaCount} 個素材（{imageCount} 張畫面），{estimatedUsd === null ? '費用未知' : `預估${formatUsd(estimatedUsd)}`}
    </span>
  );
}

export function AiChoice({ choice, disabled }: { choice: AiChoiceState; disabled: boolean }) {
  const { config, available, provider, choose, estimate } = choice;
  if (config.isError) return <span className="text-red-700">無法載入 AI 設定：{messageOf(config.error)}</span>;
  if (!config.data) return null;
  if (!provider) {
    return <span className="text-red-700">沒有可用的 AI 供應商：請在 .env 設定 ANTHROPIC_API_KEY 或 OPENAI_API_KEY</span>;
  }
  return (
    <>
      <label className="flex items-center gap-2">
        <span className="text-slate-600">AI</span>
        <select
          value={provider}
          onChange={(event) => choose(event.target.value as AiProvider)}
          disabled={disabled}
          className="rounded border border-slate-300 bg-white px-2 py-1"
          data-testid="provider-picker"
        >
          {available.map((p) => (
            <option key={p.id} value={p.id}>
              {PROVIDER_NAMES[p.id]}（{p.model}）
            </option>
          ))}
        </select>
      </label>
      <EstimateHint estimate={estimate} />
    </>
  );
}

const STEPS = [
  { state: 'analyzing', label: 'AI 分析' },
  { state: 'planning', label: '排版' },
] as const;

// SPEC §11.2: queued → AI 分析中 → 排版中. A draft that reuses an analysis skips straight to 排版.
export function DraftProgress({ state }: { state: Project['draftState'] }) {
  if (state !== 'queued' && state !== 'analyzing' && state !== 'planning') return null;
  if (state === 'queued') return <span className="text-slate-600">排隊中…</span>;
  const current = STEPS.findIndex((step) => step.state === state);
  return (
    <ol className="flex items-center gap-2 text-slate-400" data-testid="draft-progress">
      {STEPS.map((step, i) => (
        <li key={step.state} className="flex items-center gap-2">
          {i > 0 && <span aria-hidden>→</span>}
          <span className={i < current ? 'text-green-700' : i === current ? 'animate-pulse font-medium text-slate-900' : ''}>
            {step.label}
            {i < current ? ' ✓' : i === current ? '中…' : ''}
          </span>
        </li>
      ))}
    </ol>
  );
}
