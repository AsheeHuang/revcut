import { type DragEvent, useState } from 'react';
import { type Upload, type UploadTarget, useUploads } from './useUploads';

export function UploadPanel({
  target,
  accept,
  prompt,
  hint,
  onUploaded,
}: {
  target: UploadTarget;
  accept: string;
  prompt: string;
  hint: string;
  onUploaded: () => void;
}) {
  const { uploads, add, retry } = useUploads(target, onUploaded);
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
        <span className="font-medium">{prompt}</span>
        <span className="mt-1 text-sm text-slate-500">{hint}</span>
        <input
          type="file"
          multiple
          accept={accept}
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
