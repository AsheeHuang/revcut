import { isMediaBusy, MEDIA_EXTENSIONS, Media, Project } from '@revcut/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type DragEvent, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api, messageOf, noContent } from './api';
import { type Upload, useUploads } from './useUploads';

const ACCEPT = Object.keys(MEDIA_EXTENSIONS)
  .map((ext) => `.${ext}`)
  .join(',');

const POLL_MS = 2000;

export function ProjectPage() {
  const { id = '' } = useParams();
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['project', id] });

  const project = useQuery({
    queryKey: ['project', id],
    queryFn: () => api(Project, `/api/projects/${id}`),
  });
  const media = useQuery({
    queryKey: ['project', id, 'media'],
    queryFn: () => api(Media.array(), `/api/projects/${id}/media`),
    refetchInterval: (query) => (query.state.data?.some((m) => isMediaBusy(m.status)) ? POLL_MS : false),
  });

  return (
    <main className="mx-auto max-w-6xl p-8">
      <Link to="/" className="text-sm text-slate-500 hover:text-slate-900">
        ← 專案
      </Link>
      {project.isError && <p className="mt-4 text-red-700">無法載入專案：{messageOf(project.error)}</p>}
      {project.data && (
        <header className="mt-2 mb-6">
          <h1 className="text-2xl font-semibold">{project.data.title}</h1>
          <p className="text-sm text-slate-600">
            {project.data.dateRange ? `${project.data.dateRange.from} – ${project.data.dateRange.to}` : '還沒有素材'}
          </p>
        </header>
      )}
      <UploadPanel projectId={id} onUploaded={refresh} />
      {media.isError && <p className="text-red-700">無法載入素材：{messageOf(media.error)}</p>}
      {media.data && <MediaGrid items={media.data} onChange={refresh} />}
    </main>
  );
}

function UploadPanel({ projectId, onUploaded }: { projectId: string; onUploaded: () => void }) {
  const { uploads, add, retry } = useUploads(projectId, onUploaded);
  const [dragging, setDragging] = useState(false);

  function drop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    add([...event.dataTransfer.files]);
  }

  return (
    <section className="mb-8">
      <label
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={drop}
        className={`flex cursor-pointer flex-col items-center rounded-lg border-2 border-dashed p-8 text-center ${
          dragging ? 'border-slate-900 bg-slate-100' : 'border-slate-300 bg-white'
        }`}
      >
        <span className="font-medium">把影片和照片拖到這裡，或點一下選擇檔案</span>
        <span className="mt-1 text-sm text-slate-500">
          支援 MOV、MP4、HEIC、JPG、PNG。Live Photo 請連同同名的 MOV 一起上傳
        </span>
        <input
          type="file"
          multiple
          accept={ACCEPT}
          className="hidden"
          onChange={(event) => {
            add([...(event.target.files ?? [])]);
            event.target.value = '';
          }}
        />
      </label>
      {uploads.length > 0 && (
        <ul className="mt-4 divide-y divide-slate-100 rounded-md border border-slate-200 bg-white text-sm">
          {uploads.map((upload) => (
            <UploadRow key={upload.key} upload={upload} onRetry={() => retry(upload.key)} />
          ))}
        </ul>
      )}
    </section>
  );
}

function UploadRow({ upload, onRetry }: { upload: Upload; onRetry: () => void }) {
  const percent = upload.state === 'uploading' ? Math.round((upload.loaded / Math.max(upload.file.size, 1)) * 100) : 0;
  return (
    <li className="flex items-center gap-4 px-4 py-2">
      <span className="w-64 truncate">{upload.file.name}</span>
      <span className="flex-1">
        {upload.state === 'queued' && <span className="text-slate-500">等待上傳</span>}
        {upload.state === 'uploading' && (
          <span className="flex items-center gap-2">
            <span className="h-2 flex-1 overflow-hidden rounded bg-slate-100">
              <span className="block h-full bg-slate-900" style={{ width: `${percent}%` }} />
            </span>
            <span className="w-10 text-right tabular-nums">{percent}%</span>
          </span>
        )}
        {upload.state === 'done' && <span className="text-green-700">上傳完成</span>}
        {upload.state === 'duplicate' && <span className="text-amber-700">{upload.message}</span>}
        {(upload.state === 'failed' || upload.state === 'rejected') && (
          <span className="text-red-700">{upload.message}</span>
        )}
      </span>
      {upload.state === 'failed' && (
        <button type="button" onClick={onRetry} className="rounded border border-slate-300 px-2 py-0.5 hover:bg-slate-50">
          重傳
        </button>
      )}
    </li>
  );
}

const STATUS_LABELS = { uploaded: '等待處理', processing: '處理中…', failed: '處理失敗', ready: '' } as const;

function formatCapturedAt(capturedAt: string | null): string {
  return capturedAt ? `${capturedAt.slice(0, 10)} ${capturedAt.slice(11, 16)}` : '拍攝時間不明';
}

function MediaGrid({ items, onChange }: { items: Media[]; onChange: () => Promise<unknown> }) {
  if (items.length === 0) return <p className="text-slate-500">還沒有素材。</p>;
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-4">
      {items.map((item) => (
        <MediaCard key={item.id} item={item} onChange={onChange} />
      ))}
    </ul>
  );
}

function MediaCard({ item, onChange }: { item: Media; onChange: () => Promise<unknown> }) {
  const url = `/api/media/${item.id}`;
  const exclude = useMutation({
    mutationFn: (excluded: boolean) => api(Media, url, { method: 'PATCH', body: { excluded } }),
    onSettled: onChange,
  });
  const retry = useMutation({ mutationFn: () => api(Media, `${url}/retry`, { method: 'POST' }), onSettled: onChange });
  const remove = useMutation({ mutationFn: () => api(noContent, url, { method: 'DELETE' }), onSettled: onChange });
  const excluded = exclude.isPending ? exclude.variables : item.excluded;
  const error = exclude.error ?? retry.error ?? remove.error;

  return (
    <li className={`overflow-hidden rounded-lg border border-slate-200 bg-white ${excluded ? 'opacity-50' : ''}`}>
      <div className="relative aspect-square bg-slate-100">
        {item.thumbUrl && item.previewUrl ? (
          <a href={item.previewUrl} target="_blank" rel="noreferrer">
            <img src={item.thumbUrl} alt={item.filename} className="h-full w-full object-cover" />
          </a>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-slate-500">{STATUS_LABELS[item.status]}</div>
        )}
        {item.livePhoto && (
          <span className="absolute top-2 left-2 rounded bg-white/90 px-1.5 py-0.5 text-xs font-semibold">LIVE</span>
        )}
      </div>
      <div className="space-y-1 p-3 text-sm">
        <div className="truncate font-medium" title={item.filename}>
          {item.filename}
        </div>
        <div className="text-slate-600 tabular-nums">{formatCapturedAt(item.capturedAt)}</div>
        {item.status === 'failed' && (
          <>
            <p className="text-red-700">{item.error}</p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => retry.mutate()}
                disabled={retry.isPending}
                className="rounded border border-slate-300 px-2 py-0.5 hover:bg-slate-50"
              >
                重試
              </button>
              <button
                type="button"
                onClick={() => remove.mutate()}
                disabled={remove.isPending}
                className="rounded border border-slate-300 px-2 py-0.5 text-red-700 hover:bg-red-50"
              >
                刪除
              </button>
            </div>
          </>
        )}
        {item.status !== 'failed' && (
          <label className="flex items-center gap-2 text-slate-600">
            <input
              type="checkbox"
              checked={excluded}
              onChange={(event) => exclude.mutate(event.target.checked)}
            />
            排除
          </label>
        )}
        {error && <p className="text-red-700">{messageOf(error)}</p>}
      </div>
    </li>
  );
}
