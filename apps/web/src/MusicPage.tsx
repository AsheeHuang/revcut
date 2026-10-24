import { isMusicBusy, isMusicExtension, MUSIC_EXTENSIONS, MusicTrack } from '@revcut/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, messageOf, noContent } from './api';
import { formatSec, SectionPlayer } from './SectionPlayer';
import { UploadPanel } from './UploadPanel';
import type { UploadTarget } from './useUploads';

const POLL_MS = 2000;

const musicTarget: UploadTarget = {
  url: (file) => `/api/music?${new URLSearchParams({ filename: file.name })}`,
  accepts: isMusicExtension,
};

const STATUS_LABELS = { uploaded: '等待分析', analyzing: '分析中…', ready: '可使用', failed: '分析失敗' } as const;

export function MusicPage() {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['music'] });
  const [selected, setSelected] = useState<string | null>(null);
  const tracks = useQuery({
    queryKey: ['music'],
    queryFn: () => api(MusicTrack.array(), '/api/music'),
    refetchInterval: (query) => (query.state.data?.some((t) => isMusicBusy(t.status)) ? POLL_MS : false),
  });
  const playing = tracks.data?.find((t) => t.id === selected && t.status === 'ready');

  return (
    <main className="mx-auto max-w-6xl p-8">
      <h1 className="mb-6 text-2xl font-semibold">曲庫</h1>
      <UploadPanel
        target={musicTarget}
        accept={MUSIC_EXTENSIONS.map((ext) => `.${ext}`).join(',')}
        prompt="把歌曲拖到這裡，或點一下選擇檔案"
        hint="支援 MP3、M4A、AAC、WAV、FLAC，單檔上限 50 MB。Apple Music 下載的歌有 DRM，不能用"
        onUploaded={refresh}
      />
      {playing && <SectionPlayer key={playing.id} track={playing} />}
      {tracks.isError && <p className="text-red-700">無法載入曲庫：{messageOf(tracks.error)}</p>}
      {tracks.data?.length === 0 && <p className="text-slate-500">還沒有歌曲。</p>}
      {tracks.data && tracks.data.length > 0 && (
        <table className="w-full overflow-hidden rounded-lg border border-slate-200 bg-white text-sm">
          <thead className="bg-slate-50 text-left text-slate-500">
            <tr>
              <th className="px-4 py-2 font-medium">歌名</th>
              <th className="px-4 py-2 font-medium">歌手</th>
              <th className="px-4 py-2 font-medium">長度</th>
              <th className="px-4 py-2 font-medium">BPM</th>
              <th className="px-4 py-2 font-medium">狀態</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {tracks.data.map((track) => (
              <TrackRow
                key={track.id}
                track={track}
                selected={track.id === selected}
                onSelect={() => setSelected(track.id === selected ? null : track.id)}
                onChange={refresh}
              />
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}

function TrackRow({
  track,
  selected,
  onSelect,
  onChange,
}: {
  track: MusicTrack;
  selected: boolean;
  onSelect: () => void;
  onChange: () => Promise<unknown>;
}) {
  const url = `/api/music/${track.id}`;
  const queryClient = useQueryClient();
  const patch = useMutation({
    mutationFn: (body: { title?: string; artist?: string }) => api(MusicTrack, url, { method: 'PATCH', body }),
    onSettled: () => Promise.all([onChange(), queryClient.invalidateQueries({ queryKey: ['music', track.id] })]),
  });
  const retry = useMutation({ mutationFn: () => api(MusicTrack, `${url}/retry`, { method: 'POST' }), onSettled: onChange });
  const remove = useMutation({ mutationFn: () => api(noContent, url, { method: 'DELETE' }), onSettled: onChange });
  const error = patch.error ?? retry.error ?? remove.error;

  return (
    <tr className={selected ? 'bg-slate-50' : ''}>
      <td className="px-4 py-2">
        <EditableText value={track.title} label="歌名" onSave={(title) => patch.mutate({ title })} />
      </td>
      <td className="px-4 py-2">
        <EditableText value={track.artist ?? ''} label="歌手" placeholder="加上歌手" onSave={(artist) => patch.mutate({ artist })} />
      </td>
      <td className="px-4 py-2 tabular-nums">{track.durationSec === null ? '–' : formatSec(track.durationSec)}</td>
      <td className="px-4 py-2 tabular-nums">{track.bpm === null ? '–' : track.bpm.toFixed(1)}</td>
      <td className="px-4 py-2">
        <span className={track.status === 'failed' ? 'text-red-700' : track.status === 'ready' ? 'text-green-700' : 'text-slate-500'}>
          {STATUS_LABELS[track.status]}
        </span>
        {track.error && <p className="text-red-700">{track.error}</p>}
        {error && <p className="text-red-700">{messageOf(error)}</p>}
      </td>
      <td className="px-4 py-2">
        <div className="flex justify-end gap-2">
          {track.status === 'ready' && (
            <button type="button" onClick={onSelect} className="rounded border border-slate-300 px-2 py-0.5 hover:bg-slate-50">
              {selected ? '收起' : '試聽'}
            </button>
          )}
          {track.status === 'failed' && (
            <button
              type="button"
              onClick={() => retry.mutate()}
              disabled={retry.isPending}
              className="rounded border border-slate-300 px-2 py-0.5 hover:bg-slate-50"
            >
              重試
            </button>
          )}
          {track.status !== 'analyzing' && (
            <button
              type="button"
              onClick={() => {
                if (window.confirm(`刪除「${track.title}」？`)) remove.mutate();
              }}
              disabled={remove.isPending}
              className="rounded border border-slate-300 px-2 py-0.5 text-red-700 hover:bg-red-50"
            >
              刪除
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

function EditableText({
  value,
  label,
  placeholder = '',
  onSave,
}: {
  value: string;
  label: string;
  placeholder?: string;
  onSave: (value: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  function commit() {
    if (draft !== null && draft.trim() !== value) onSave(draft.trim());
    setDraft(null);
  }

  if (draft === null) {
    return (
      <button
        type="button"
        title={`修改${label}`}
        onClick={() => setDraft(value)}
        className="w-full rounded px-1 text-left hover:bg-slate-100"
      >
        {value || <span className="text-slate-400">{placeholder}</span>}
      </button>
    );
  }
  return (
    <input
      autoFocus
      aria-label={label}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit();
        if (event.key === 'Escape') setDraft(null);
      }}
      className="w-full rounded border border-slate-300 px-1"
    />
  );
}
