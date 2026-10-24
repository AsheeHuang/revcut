import type { Media } from '@revcut/shared';
import { type ReactNode, useEffect } from 'react';

const byScore = (a: Media, b: Media) =>
  (b.analysis?.score ?? 0) - (a.analysis?.score ?? 0) || (a.capturedAt ?? '').localeCompare(b.capturedAt ?? '');

const formatDate = (capturedAt: string | null) => (capturedAt ? capturedAt.slice(0, 10).replaceAll('-', '.') : '日期不明');

// SPEC §11.3: candidates sorted by AI score, each with its description and whether the timeline already uses it.
export function MediaPicker({
  title,
  media,
  used,
  header,
  onPick,
  onClose,
}: {
  title: string;
  media: Media[];
  used: ReadonlySet<string>;
  header?: ReactNode;
  onPick: (mediaId: string) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const candidates = media.filter((m) => m.status === 'ready' && !m.excluded).sort(byScore);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-8" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex max-h-full w-full max-w-2xl flex-col rounded-lg bg-white shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h2 className="font-semibold">{title}</h2>
          <button type="button" onClick={onClose} className="text-sm text-slate-500 hover:text-slate-900">
            關閉
          </button>
        </div>
        {header && <div className="border-b border-slate-200 px-5 py-3 text-sm">{header}</div>}
        <ul className="divide-y divide-slate-100 overflow-y-auto" data-testid="media-candidates">
          {candidates.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                onClick={() => onPick(m.id)}
                className="flex w-full items-center gap-4 px-5 py-2 text-left hover:bg-slate-50"
                data-media-id={m.id}
              >
                {m.thumbUrl && <img src={m.thumbUrl} alt="" className="h-16 w-16 shrink-0 rounded object-cover" />}
                <div className="min-w-0 flex-1 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="font-medium tabular-nums">{m.analysis ? `${m.analysis.score} 分` : '未分析'}</span>
                    <span className="text-slate-500 tabular-nums">
                      {m.kind === 'video' ? `影片 ${m.durationSec?.toFixed(1)} 秒` : '照片'}・{formatDate(m.capturedAt)}
                    </span>
                    {used.has(m.id) && (
                      <span className="rounded bg-slate-200 px-1.5 py-0.5 text-xs text-slate-700" data-testid="used-badge">
                        已使用
                      </span>
                    )}
                  </div>
                  <p className="truncate text-slate-700">{m.analysis?.description ?? m.filename}</p>
                </div>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
