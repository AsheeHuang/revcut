import {
  applyEdit,
  type EditCommand,
  type EditContext,
  type History,
  type Media,
  MusicTrackDetail,
  record,
  redo,
  startHistory,
  type Timeline,
  TimelineDetail,
  undo,
} from '@revcut/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';

const SAVE_DELAY_MS = 1000;

export type SaveState = 'saved' | 'saving' | 'failed';

type Session = { timelineId: string; history: History<Timeline>; error: string | null };

export const songQuery = (trackId: string) => ({
  queryKey: ['music', trackId],
  queryFn: () => api(MusicTrackDetail, `/api/music/${trackId}`),
});

let gestures = 0;
// A pointer drag or a focused field is one gesture: its many updates undo as one step.
export const newGesture = (name: string) => `${name}:${++gestures}`;

// SPEC §11.3: edits apply locally at once, undo stays in the page, and the current version is saved 1 s after the last edit.
export function useTimelineEditor(detail: TimelineDetail | undefined, mediaList: Media[] | undefined) {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<Session | null>(null);
  const current = detail && session?.timelineId === detail.id ? session : null;
  if (detail && !current) setSession({ timelineId: detail.id, history: startHistory(detail.data), error: null });
  const timeline = current?.history.present;

  const song = useQuery({ ...songQuery(timeline?.music.trackId ?? ''), enabled: Boolean(timeline) });
  const media = useMemo(() => Object.fromEntries((mediaList ?? []).map((m) => [m.id, m])), [mediaList]);
  const analysis = song.data?.analysis;
  const ctx = useMemo<EditContext | null>(
    () => (analysis && mediaList ? { beats: analysis.beats, downbeatIndices: analysis.downbeatIndices, media } : null),
    [analysis, mediaList, media],
  );
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  const dispatch = useCallback((command: EditCommand, gesture: string | null = null) => {
    setSession((s) => {
      const context = ctxRef.current;
      if (!s || !context) return s;
      const result = applyEdit(s.history.present, command, context);
      return result.ok ? { ...s, history: record(s.history, result.timeline, gesture), error: null } : { ...s, error: result.message };
    });
  }, []);
  const step = useCallback((move: typeof undo) => setSession((s) => s && { ...s, history: move(s.history), error: null }), []);

  const can = (command: EditCommand) => {
    if (!timeline || !ctx) return false;
    const result = applyEdit(timeline, command, ctx);
    return result.ok && result.timeline !== timeline;
  };

  const latest = useRef({ id: current?.timelineId, data: timeline });
  latest.current = { id: current?.timelineId, data: timeline };
  const saved = useRef<{ id: string; data: Timeline } | null>(null);
  const isSaved = () => saved.current?.id === latest.current.id && saved.current?.data === latest.current.data;
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const timer = useRef<number | undefined>(undefined);
  const [saveState, setSaveState] = useState<SaveState>('saved');

  // Saves run one after another and send whatever is newest when their turn comes.
  const save = useCallback((): Promise<void> => {
    window.clearTimeout(timer.current);
    const run = chain.current.then(async () => {
      const { id, data } = latest.current;
      if (!id || !data || isSaved()) {
        setSaveState('saved');
        return;
      }
      setSaveState('saving');
      try {
        const updated = await api(TimelineDetail, `/api/timelines/${id}`, { method: 'PUT', body: { data } });
        saved.current = { id, data };
        queryClient.setQueryData(['timeline', id], updated);
        if (isSaved()) setSaveState('saved');
      } catch (error) {
        setSaveState('failed');
        throw error;
      }
    });
    chain.current = run.catch(() => {});
    return run;
  }, [queryClient]);

  const timelineId = current?.timelineId;
  useEffect(() => {
    if (timelineId && saved.current?.id !== timelineId) saved.current = { id: timelineId, data: latest.current.data! };
  }, [timelineId]);

  useEffect(() => {
    if (!timeline || isSaved()) return;
    setSaveState('saving');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void save().catch(() => {}), SAVE_DELAY_MS);
  }, [timeline, save]);

  // Leaving the editor sends the pending edit right away; a closing tab needs keepalive to finish it.
  useEffect(() => {
    const onHide = () => {
      const { id, data } = latest.current;
      if (!id || !data || isSaved()) return;
      void fetch(`/api/timelines/${id}`, {
        method: 'PUT',
        keepalive: true,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data }),
      });
    };
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      if (!isSaved()) void save().catch(() => {});
    };
  }, [save]);

  return {
    timeline,
    ctx,
    media,
    song: song.data,
    songError: song.error,
    dispatch,
    can,
    undo: () => step(undo),
    redo: () => step(redo),
    canUndo: (current?.history.past.length ?? 0) > 0,
    canRedo: (current?.history.future.length ?? 0) > 0,
    error: current?.error ?? null,
    saveState,
    save,
  };
}

export type TimelineEditor = ReturnType<typeof useTimelineEditor>;
