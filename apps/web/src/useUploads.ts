import { useEffect, useReducer, useRef } from 'react';
import { toRequestError } from './api';

const CONCURRENT_UPLOADS = 3;

export type Upload = { key: string; file: File } & (
  | { state: 'queued' }
  | { state: 'uploading'; loaded: number }
  | { state: 'done' }
  | { state: 'failed'; message: string }
  | { state: 'duplicate'; message: string }
  | { state: 'rejected'; message: string }
);

export type UploadTarget = { url: (file: File) => string; accepts: (filename: string) => boolean };

type Action =
  | { type: 'add'; files: File[]; accepts: UploadTarget['accepts'] }
  | { type: 'progress'; key: string; loaded: number }
  | { type: 'finish'; key: string; result: Exclude<Upload, { state: 'queued' | 'uploading' }> }
  | { type: 'retry'; key: string };

let nextKey = 0;

function reducer(uploads: Upload[], action: Action): Upload[] {
  switch (action.type) {
    case 'add':
      return [
        ...uploads,
        ...action.files.map((file): Upload => {
          const key = String(nextKey++);
          return action.accepts(file.name)
            ? { key, file, state: 'queued' }
            : { key, file, state: 'rejected', message: '不支援的檔案格式' };
        }),
      ];
    case 'progress':
      return uploads.map((u) => (u.key === action.key ? { key: u.key, file: u.file, state: 'uploading', loaded: action.loaded } : u));
    case 'finish':
      return uploads.map((u) => (u.key === action.key ? action.result : u));
    case 'retry':
      return uploads.map((u) => (u.key === action.key && u.state === 'failed' ? { key: u.key, file: u.file, state: 'queued' } : u));
  }
}

function send(url: string, upload: Upload, dispatch: (action: Action) => void): XMLHttpRequest {
  const { key, file } = upload;
  const xhr = new XMLHttpRequest();
  xhr.open('POST', url);
  // Windows hands .heic files an empty type; the server only records this header.
  xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
  xhr.upload.onprogress = (event) => dispatch({ type: 'progress', key, loaded: event.loaded });
  xhr.onload = () => {
    if (xhr.status === 201) return dispatch({ type: 'finish', key, result: { key, file, state: 'done' } });
    const error = toRequestError(xhr.status, JSON.parse(xhr.responseText || 'null'));
    const state = error.code === 'DUPLICATE' ? 'duplicate' : 'failed';
    dispatch({ type: 'finish', key, result: { key, file, state, message: error.message } });
  };
  xhr.onerror = () => dispatch({ type: 'finish', key, result: { key, file, state: 'failed', message: '連線中斷' } });
  xhr.send(file);
  return xhr;
}

export function useUploads(target: UploadTarget, onUploaded: () => void) {
  const [uploads, dispatch] = useReducer(reducer, []);
  const inFlight = useRef(new Map<string, XMLHttpRequest>());
  const onUploadedRef = useRef(onUploaded);
  onUploadedRef.current = onUploaded;
  const targetRef = useRef(target);
  targetRef.current = target;

  useEffect(() => {
    for (const key of inFlight.current.keys()) {
      const upload = uploads.find((u) => u.key === key);
      if (upload?.state === 'uploading') continue;
      inFlight.current.delete(key);
      if (upload?.state === 'done') onUploadedRef.current();
    }
    const free = CONCURRENT_UPLOADS - inFlight.current.size;
    for (const upload of uploads.filter((u) => u.state === 'queued').slice(0, Math.max(0, free))) {
      dispatch({ type: 'progress', key: upload.key, loaded: 0 });
      inFlight.current.set(upload.key, send(targetRef.current.url(upload.file), upload, dispatch));
    }
  }, [uploads]);

  useEffect(() => {
    const requests = inFlight.current;
    return () => {
      for (const xhr of requests.values()) xhr.abort();
    };
  }, []);

  return {
    uploads,
    add: (files: File[]) => dispatch({ type: 'add', files, accepts: targetRef.current.accepts }),
    retry: (key: string) => dispatch({ type: 'retry', key }),
  };
}
