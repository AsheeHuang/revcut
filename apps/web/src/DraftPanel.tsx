import { isDraftBusy, MusicTrack, Project } from '@revcut/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { api, messageOf } from './api';
import { SectionPlayer } from './SectionPlayer';

const PROGRESS = { queued: '排隊中…', analyzing: 'AI 分析中…', planning: '排版中…' } as const;

export function DraftPanel({ project }: { project: Project }) {
  const queryClient = useQueryClient();
  const tracks = useQuery({ queryKey: ['music'], queryFn: () => api(MusicTrack.array(), '/api/music') });
  const ready = tracks.data?.filter((track) => track.status === 'ready') ?? [];
  const [chosen, setChosen] = useState<string | null>(null);
  const track = ready.find((t) => t.id === chosen) ?? ready[0];
  const draft = useMutation({
    mutationFn: (trackId: string) =>
      api(Project, `/api/projects/${project.id}/draft`, { method: 'POST', body: { trackId } }),
    onSuccess: (updated) => queryClient.setQueryData(['project', project.id], updated),
  });

  const { draftState, draftError, mediaCounts } = project;
  const running = isDraftBusy(draftState) || draft.isPending;
  const blocker =
    mediaCounts.processing > 0 ? '還有素材在處理，處理完才能產生初版' : mediaCounts.ready === 0 ? '還沒有處理完成的素材' : null;

  return (
    <section className="mb-8 rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="mb-3 font-semibold">產生初版</h2>
      {tracks.isError && <p className="text-red-700">無法載入曲庫：{messageOf(tracks.error)}</p>}
      {tracks.data && ready.length === 0 && (
        <p className="text-sm text-slate-600">
          曲庫還沒有分析完成的歌。先到
          <Link to="/music" className="mx-1 underline">
            曲庫
          </Link>
          上傳一首。
        </p>
      )}
      {track && (
        <>
          <label className="mb-3 flex items-center gap-2 text-sm">
            <span className="text-slate-600">音樂</span>
            <select
              value={track.id}
              onChange={(event) => setChosen(event.target.value)}
              disabled={running}
              className="rounded border border-slate-300 bg-white px-2 py-1"
            >
              {ready.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}（{t.bpm === null ? '–' : t.bpm.toFixed(1)} BPM）
                </option>
              ))}
            </select>
          </label>
          <SectionPlayer key={track.id} track={track} />
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <button
              type="button"
              onClick={() => draft.mutate(track.id)}
              disabled={running || blocker !== null}
              className="rounded bg-slate-900 px-4 py-2 text-white hover:bg-slate-700 disabled:opacity-50"
            >
              {draftState === 'failed' ? '重試' : '產生初版'}
            </button>
            {blocker && !running && <span className="text-slate-500">{blocker}</span>}
            {isDraftBusy(draftState) && <span className="text-slate-600">{PROGRESS[draftState]}</span>}
            {draftState === 'done' && !draft.isPending && (
              <span className="text-green-700">
                初版已完成。
                <Link to={`/projects/${project.id}/edit`} className="ml-1 font-medium underline">
                  開啟編輯器 →
                </Link>
              </span>
            )}
            {draftState === 'failed' && <span className="text-red-700">產生失敗：{draftError}</span>}
            {draft.isError && <span className="text-red-700">{messageOf(draft.error)}</span>}
          </div>
        </>
      )}
    </section>
  );
}
