import { Player, type PlayerRef } from '@remotion/player';
import { type CompositionProps, coverRect, IgSafeZoneMask, RecapVideo, recapDurationInFrames } from '@revcut/composition';
import {
  type AiProvider,
  barShape,
  type Clip,
  computeTiming,
  FPS,
  framesToSec,
  HEIGHT,
  isDraftBusy,
  isRenderBusy,
  Media,
  type MusicTrackDetail,
  Project,
  Render,
  StartRenderResponse,
  type Timeline,
  TimelineDetail,
  TimelineSummary,
  type ValidationIssue,
  validateTimeline,
  WIDTH,
} from '@revcut/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type PointerEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api, messageOf } from './api';
import { ClipInspector } from './ClipInspector';
import { ClipStrip } from './ClipStrip';
import { AiChoice, DraftProgress, useAiChoice } from './DraftControls';
import { MediaPicker } from './MediaPicker';
import { MusicBar } from './MusicBar';
import { newGesture, type SaveState, type TimelineEditor, useTimelineEditor } from './useTimelineEditor';

const POLL_MS = 2000;
const PLAYER_HEIGHT = 720;
// Leaves the Player's own control bar clickable under the crop drag surface.
const PLAYER_CONTROLS_PX = 48;

const formatTime = (iso: string) =>
  new Date(iso).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

// SPEC §9.1: the preview plays the 720p preview files from the clip's own in-point.
function previewProps(timeline: Timeline, media: Record<string, Media>, song: MusicTrackDetail): CompositionProps | null {
  if (!song.analysis) return null;
  const sources = Object.fromEntries(
    timeline.clips.flatMap((clip) => {
      const item = media[clip.mediaId];
      if (!item?.previewUrl || item.width === null || item.height === null) return [];
      const { kind, previewUrl, width, height } = item;
      return [[clip.id, { kind, src: previewUrl, startFromSec: clip.sourceInSec, width, height }]];
    }),
  );
  return { timeline, music: { src: song.audioUrl, beats: song.analysis.beats }, sources };
}

const isTextField = (target: EventTarget | null) =>
  target instanceof HTMLTextAreaElement ||
  (target instanceof HTMLElement && target.isContentEditable) ||
  (target instanceof HTMLInputElement && !['range', 'checkbox', 'button'].includes(target.type));
const isControl = (target: EventTarget | null) => target instanceof HTMLInputElement || target instanceof HTMLSelectElement;

type Picker = { mode: 'replace'; clipId: string } | { mode: 'insert'; index: number } | null;

export function EditorPage() {
  const { id = '' } = useParams();
  const queryClient = useQueryClient();
  const project = useQuery({
    queryKey: ['project', id],
    queryFn: () => api(Project, `/api/projects/${id}`),
    refetchInterval: (query) => (query.state.data && isDraftBusy(query.state.data.draftState) ? POLL_MS : false),
  });
  const versions = useQuery({
    queryKey: ['project', id, 'timelines'],
    queryFn: () => api(TimelineSummary.array(), `/api/projects/${id}/timelines`),
  });
  const mediaList = useQuery({
    queryKey: ['project', id, 'media'],
    queryFn: () => api(Media.array(), `/api/projects/${id}/media`),
  });
  const timelineId = project.data?.currentTimelineId;
  // AI 重排 makes a new version and switches to it.
  useEffect(() => {
    if (timelineId) void queryClient.invalidateQueries({ queryKey: ['project', id, 'timelines'] });
  }, [timelineId, queryClient, id]);
  const detail = useQuery({
    queryKey: ['timeline', timelineId],
    queryFn: () => api(TimelineDetail, `/api/timelines/${timelineId}`),
    enabled: Boolean(timelineId),
  });
  const editor = useTimelineEditor(detail.data, mediaList.data);
  const { timeline, song, media, dispatch } = editor;

  const switchVersion = useMutation({
    mutationFn: async (currentTimelineId: string) => {
      await editor.save();
      return api(Project, `/api/projects/${id}`, { method: 'PATCH', body: { currentTimelineId } });
    },
    onSuccess: (updated) => queryClient.setQueryData(['project', id], updated),
  });
  const versionNames = useMemo(
    () => new Map(versions.data?.map((version, i) => [version.id, `版本 ${versions.data.length - i}`])),
    [versions.data],
  );

  const analysis = song?.analysis;
  const timing = useMemo(
    () => (timeline && analysis ? computeTiming(analysis.beats, timeline.music.startBeat, timeline.clips) : null),
    [timeline, analysis],
  );
  const validation = useMemo(() => {
    if (!timeline || !mediaList.data || (!song && !editor.songError)) return null;
    const track = song ? { status: song.status, beats: analysis?.beats ?? null, downbeatIndices: analysis?.downbeatIndices ?? null } : null;
    return validateTimeline(timeline, { track, media });
  }, [timeline, mediaList.data, song, editor.songError, analysis, media]);
  const props = useMemo(() => (timeline && song ? previewProps(timeline, media, song) : null), [timeline, media, song]);
  const beatsPerBar = analysis ? barShape(analysis.beats, analysis.downbeatIndices)?.beatsPerBar : undefined;
  const downbeats = useMemo(() => new Set(analysis?.downbeatIndices), [analysis]);
  const flagged = useMemo(
    () =>
      new Map([
        ...(validation?.warnings ?? []).flatMap((issue) => (issue.clipId ? [[issue.clipId, 'warning'] as const] : [])),
        ...(validation?.errors ?? []).flatMap((issue) => (issue.clipId ? [[issue.clipId, 'error'] as const] : [])),
      ]),
    [validation],
  );

  const playerRef = useRef<PlayerRef>(null);
  const [showMask, setShowMask] = useState(true);
  const [picker, setPicker] = useState<Picker>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const clips = timeline?.clips ?? [];
  const selectedIndex = Math.max(0, clips.findIndex((clip) => clip.id === selectedId));
  const selected: Clip | undefined = clips[selectedIndex];

  // The selection follows the playhead, and an edit or a new selection brings the playhead back onto the selected clip.
  useEffect(() => {
    const player = playerRef.current;
    if (!player || !timing) return;
    const onFrame = ({ detail: { frame } }: { detail: { frame: number } }) => {
      const clip = clips[timing.clips.findLastIndex((c) => c.startFrame <= frame)];
      if (clip) setSelectedId(clip.id);
    };
    player.addEventListener('frameupdate', onFrame);
    return () => player.removeEventListener('frameupdate', onFrame);
  }, [timing, clips]);
  useEffect(() => {
    const player = playerRef.current;
    const span = timing?.clips[selectedIndex];
    if (!player || !span || player.isPlaying()) return;
    const frame = player.getCurrentFrame();
    if (frame < span.startFrame || frame >= span.startFrame + span.frames) player.seekTo(span.startFrame);
  }, [timing, selectedIndex]);

  const selectAt = (k: number) => {
    const clip = clips[Math.max(0, Math.min(k, clips.length - 1))];
    if (clip) setSelectedId(clip.id);
  };
  const deleteSelected = () => {
    if (!selected || clips.length < 2) return;
    setSelectedId((clips[selectedIndex + 1] ?? clips[selectedIndex - 1])!.id);
    dispatch({ type: 'delete', clipId: selected.id });
  };

  const onKey = useRef<(event: KeyboardEvent) => void>(() => {});
  onKey.current = (event) => {
    if (picker || isTextField(event.target)) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) editor.redo();
      else editor.undo();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey || isControl(event.target)) return;
    if (event.key === ' ') {
      event.preventDefault();
      playerRef.current?.toggle();
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      deleteSelected();
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      selectAt(selectedIndex + (event.key === 'ArrowLeft' ? -1 : 1));
    }
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKey.current(event);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  const used = useMemo(() => new Set(clips.map((clip) => clip.mediaId)), [clips]);
  const errors = validation?.errors ?? [];
  const warnings = validation?.warnings ?? [];

  return (
    <main className="mx-auto max-w-6xl p-8">
      <Link to={`/projects/${id}`} className="text-sm text-slate-500 hover:text-slate-900">
        ← 素材
      </Link>
      {project.isError && <p className="mt-4 text-red-700">無法載入專案：{messageOf(project.error)}</p>}
      {project.data && (
        <header className="mt-2 mb-6 flex flex-wrap items-end justify-between gap-4">
          <div className="flex items-baseline gap-4">
            <h1 className="text-2xl font-semibold">{project.data.title}</h1>
            {timeline && <SaveStatus state={editor.saveState} onRetry={() => void editor.save().catch(() => {})} />}
          </div>
          {versions.data && timelineId && (
            <label className="flex items-center gap-2 text-sm">
              <span className="text-slate-600">版本</span>
              <select
                value={timelineId}
                onChange={(event) => switchVersion.mutate(event.target.value)}
                disabled={switchVersion.isPending}
                className="rounded border border-slate-300 bg-white px-2 py-1"
                data-testid="version-picker"
              >
                {versions.data.map((version) => (
                  <option key={version.id} value={version.id}>
                    {versionNames.get(version.id)}（{formatTime(version.createdAt)}）
                  </option>
                ))}
              </select>
              {switchVersion.isError && <span className="text-red-700">{messageOf(switchVersion.error)}</span>}
            </label>
          )}
        </header>
      )}
      {project.data && !timelineId && (
        <p className="text-slate-600">
          還沒有初版。
          <Link to={`/projects/${id}`} className="underline">
            回素材頁產生初版
          </Link>
        </p>
      )}
      {detail.isError && <p className="text-red-700">無法載入時間軸：{messageOf(detail.error)}</p>}
      {editor.songError && <p className="text-red-700">歌曲已刪除或無法載入，不能預覽和編輯：{messageOf(editor.songError)}</p>}
      {timeline && (
        <>
          <div className="grid grid-cols-[auto_1fr] gap-8">
            <div>
              {props ? (
                <div className="relative bg-black" style={{ width: (PLAYER_HEIGHT * WIDTH) / HEIGHT, height: PLAYER_HEIGHT }} data-testid="preview">
                  <Player
                    ref={playerRef}
                    component={RecapVideo}
                    inputProps={props}
                    durationInFrames={recapDurationInFrames(props)}
                    compositionWidth={WIDTH}
                    compositionHeight={HEIGHT}
                    fps={FPS}
                    controls
                    spaceKeyToPlayOrPause={false}
                    acknowledgeRemotionLicense
                    style={{ width: '100%', height: '100%' }}
                  />
                  {selected && media[selected.mediaId] && (
                    <CropSurface clip={selected} media={media[selected.mediaId]!} editor={editor} />
                  )}
                  {showMask && <IgSafeZoneMask />}
                </div>
              ) : (
                <p className="text-slate-500">載入預覽中…</p>
              )}
              <div className="mt-3 flex gap-4 text-sm text-slate-700">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={showMask} onChange={(event) => setShowMask(event.target.checked)} />
                  IG 介面遮罩
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={timeline.overlayEnabled}
                    onChange={(event) => dispatch({ type: 'setOverlay', enabled: event.target.checked })}
                  />
                  日期疊字
                </label>
              </div>
            </div>
            <div className="space-y-6">
              {selected && (
                <ClipInspector
                  editor={editor}
                  clip={selected}
                  index={selectedIndex}
                  clipSec={timing ? framesToSec(timing.clips[selectedIndex]!.frames) : null}
                  media={media[selected.mediaId]}
                  onReplace={() => setPicker({ mode: 'replace', clipId: selected.id })}
                />
              )}
              {validation && <ValidationPanel errors={errors} warnings={warnings} onSelect={setSelectedId} />}
            </div>
          </div>

          <section className="mt-8">
            <div className="mb-2 flex items-center gap-3 text-sm">
              <h2 className="mr-auto font-semibold">時間軸</h2>
              {editor.error && <span className="text-red-700">{editor.error}</span>}
              <button
                type="button"
                onClick={editor.undo}
                disabled={!editor.canUndo}
                className="rounded border border-slate-300 bg-white px-2 py-1 disabled:opacity-40"
              >
                復原
              </button>
              <button
                type="button"
                onClick={editor.redo}
                disabled={!editor.canRedo}
                className="rounded border border-slate-300 bg-white px-2 py-1 disabled:opacity-40"
              >
                重做
              </button>
              <button
                type="button"
                onClick={() => setPicker({ mode: 'insert', index: selectedIndex + 1 })}
                className="rounded border border-slate-300 bg-white px-2 py-1"
              >
                插入素材
              </button>
            </div>
            <ClipStrip
              timeline={timeline}
              timing={timing}
              downbeats={downbeats}
              selectedId={selected?.id ?? null}
              flagged={flagged}
              onSelect={setSelectedId}
              onReorder={(clipId, toIndex) => {
                setSelectedId(clipId);
                dispatch({ type: 'reorder', clipId, toIndex });
              }}
            />
            <p className="mt-1 text-xs text-slate-500">
              拖曳卡片排序。快捷鍵：Space 播放／暫停、⌘Z／⌘⇧Z（Windows 用 Ctrl）復原／重做、Delete 刪除、←／→ 選上一段／下一段。
            </p>
          </section>

          <div className="mt-6">
            <MusicBar
              editor={editor}
              totalSec={timing ? framesToSec(timing.totalFrames) : null}
              bars={beatsPerBar ? clips.reduce((sum, clip) => sum + clip.beats, 0) / beatsPerBar : null}
              errors={errors.length}
              warnings={warnings.length}
            />
          </div>

          <div className="mt-6 grid grid-cols-2 gap-6">
            {project.data && <RedraftPanel project={project.data} timeline={timeline} editor={editor} />}
            {detail.data && (
              <ExportPanel
                projectId={id}
                timelineId={detail.data.id}
                versionNames={versionNames}
                blocked={!validation || errors.length > 0}
                editor={editor}
              />
            )}
          </div>

          {picker && mediaList.data && (
            <MediaPicker
              title={picker.mode === 'replace' ? '換素材' : '插入素材'}
              media={mediaList.data}
              used={used}
              header={
                picker.mode === 'insert' && (
                  <label className="flex items-center gap-2">
                    <span className="text-slate-600">插入位置</span>
                    <select
                      value={picker.index}
                      onChange={(event) => setPicker({ mode: 'insert', index: Number(event.target.value) })}
                      className="rounded border border-slate-300 bg-white px-2 py-1"
                      data-testid="insert-position"
                    >
                      {Array.from({ length: clips.length + 1 }, (_, k) => (
                        <option key={k} value={k}>
                          {k === 0 ? '最前面' : `第 ${k} 段之後`}
                        </option>
                      ))}
                    </select>
                  </label>
                )
              }
              onPick={(mediaId) => {
                if (picker.mode === 'replace') dispatch({ type: 'replaceMedia', clipId: picker.clipId, mediaId });
                else {
                  const clipId = crypto.randomUUID();
                  dispatch({ type: 'insert', index: picker.index, mediaId, clipId });
                  setSelectedId(clipId);
                }
                setPicker(null);
              }}
              onClose={() => setPicker(null)}
            />
          )}
        </>
      )}
    </main>
  );
}

const SAVE_LABELS = { saved: '已儲存', saving: '儲存中…', failed: '儲存失敗' } as const satisfies Record<SaveState, string>;

function SaveStatus({ state, onRetry }: { state: SaveState; onRetry: () => void }) {
  return (
    <span className={`text-sm ${state === 'failed' ? 'text-red-700' : 'text-slate-500'}`} data-testid="save-state">
      {SAVE_LABELS[state]}
      {state === 'failed' && (
        <button type="button" onClick={onRetry} className="ml-2 underline">
          重試
        </button>
      )}
    </span>
  );
}

type Axis = { from: number; focus: number; perPx: number; half: number };

// A focus only moves the frame while the scaled source overhangs that side; past the overhang
// it stays put, so dragging back responds at once instead of after a dead zone.
function dragAxis({ from, focus, perPx, half }: Axis, to: number): number {
  if (half >= 0.5) return focus;
  return Math.max(half, Math.min(focus - (to - from) * perPx, 1 - half));
}

// SPEC §11.3: drag on the preview to move the selected clip's crop focus; one drag is one undo step.
function CropSurface({ clip, media, editor }: { clip: Clip; media: Media; editor: TimelineEditor }) {
  const drag = useRef<{ gesture: string; x: Axis; y: Axis } | null>(null);
  if (media.width === null || media.height === null) return null;
  const { width, height } = media;

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const scale = WIDTH / event.currentTarget.getBoundingClientRect().width;
    const rect = coverRect(width, height, clip.crop);
    drag.current = {
      gesture: newGesture('crop'),
      x: { from: event.clientX, focus: clip.crop.focusX, perPx: scale / rect.width, half: WIDTH / 2 / rect.width },
      y: { from: event.clientY, focus: clip.crop.focusY, perPx: scale / rect.height, half: HEIGHT / 2 / rect.height },
    };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const crop = { focusX: dragAxis(d.x, event.clientX), focusY: dragAxis(d.y, event.clientY) };
    editor.dispatch({ type: 'setCrop', clipId: clip.id, crop }, d.gesture);
  };
  const end = () => (drag.current = null);

  return (
    <div
      className="absolute inset-x-0 top-0 cursor-move touch-none"
      style={{ bottom: PLAYER_CONTROLS_PX }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      data-testid="crop-surface"
    />
  );
}

function ValidationPanel({
  errors,
  warnings,
  onSelect,
}: {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  onSelect: (clipId: string) => void;
}) {
  const issues = [...errors.map((issue) => ({ issue, error: true })), ...warnings.map((issue) => ({ issue, error: false }))];
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4" data-testid="validation-panel">
      <h2 className="mb-2 font-semibold">檢查結果</h2>
      {issues.length === 0 && <p className="text-sm text-green-700">沒有問題。</p>}
      <ul className="space-y-1 text-sm">
        {issues.map(({ issue, error }, i) => (
          <li key={i} className={error ? 'text-red-700' : 'text-amber-700'}>
            <span className="mr-2 font-medium">{error ? '錯誤' : '警告'}</span>
            {issue.clipId ? (
              <button type="button" onClick={() => onSelect(issue.clipId!)} className="underline decoration-dotted">
                {issue.message}
              </button>
            ) : (
              issue.message
            )}
          </li>
        ))}
      </ul>
      {errors.length > 0 && <p className="mt-2 text-xs text-slate-500">有錯誤時不能匯出；警告不影響匯出。</p>}
    </section>
  );
}

// SPEC §11.3: a new seed on the same song and start, as a new version; the current one keeps its edits.
function RedraftPanel({ project, timeline, editor }: { project: Project; timeline: Timeline; editor: TimelineEditor }) {
  const queryClient = useQueryClient();
  const choice = useAiChoice(project);
  const redraft = useMutation({
    mutationFn: async (provider: AiProvider) => {
      await editor.save();
      return api(Project, `/api/projects/${project.id}/draft`, {
        method: 'POST',
        body: { trackId: timeline.music.trackId, startBeat: timeline.music.startBeat, provider },
      });
    },
    onSuccess: (updated) => queryClient.setQueryData(['project', project.id], updated),
  });
  const running = isDraftBusy(project.draftState) || redraft.isPending;

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4" data-testid="redraft-panel">
      <div className="flex items-center gap-4">
        <h2 className="font-semibold">AI 重排</h2>
        <button
          type="button"
          onClick={() => choice.provider && redraft.mutate(choice.provider)}
          disabled={running || !choice.provider}
          className="rounded bg-slate-900 px-4 py-1.5 text-sm text-white hover:bg-slate-700 disabled:opacity-50"
        >
          AI 重排
        </button>
        <DraftProgress state={project.draftState} />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
        <AiChoice choice={choice} disabled={running} />
      </div>
      <p className="mt-2 text-xs text-slate-500">用新的亂數排出新版本，同一首歌、同一個起點；目前版本的修改會留著。</p>
      {project.draftState === 'failed' && !redraft.isPending && <p className="mt-2 text-sm text-red-700">重排失敗：{project.draftError}</p>}
      {redraft.isError && <p className="mt-2 text-sm text-red-700">{messageOf(redraft.error)}</p>}
    </section>
  );
}

const RENDER_LABELS = { queued: '排隊中', preparing: '準備片段', rendering: '算圖中', done: '完成', failed: '失敗' } as const;

function ExportPanel({
  projectId,
  timelineId,
  versionNames,
  blocked,
  editor,
}: {
  projectId: string;
  timelineId: string;
  versionNames: Map<string, string>;
  blocked: boolean;
  editor: TimelineEditor;
}) {
  const queryClient = useQueryClient();
  const renders = useQuery({
    queryKey: ['project', projectId, 'renders'],
    queryFn: () => api(Render.array(), `/api/projects/${projectId}/renders`),
    refetchInterval: (query) => (query.state.data?.some((render) => isRenderBusy(render.state)) ? POLL_MS : false),
  });
  // SPEC §6.5: the pending edit is saved first, so an export clicked right after an edit includes it.
  const start = useMutation({
    mutationFn: async () => {
      await editor.save();
      return api(StartRenderResponse, `/api/timelines/${timelineId}/renders`, { method: 'POST' });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['project', projectId, 'renders'] }),
  });
  const latest = renders.data?.find((render) => render.timelineId === timelineId);
  const running = renders.data?.some((render) => isRenderBusy(render.state)) ?? false;

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-center gap-4">
        <h2 className="font-semibold">匯出</h2>
        <button
          type="button"
          onClick={() => start.mutate()}
          disabled={blocked || running || start.isPending}
          className="rounded bg-slate-900 px-4 py-1.5 text-sm text-white hover:bg-slate-700 disabled:opacity-50"
        >
          匯出
        </button>
        {start.isError && <span className="text-sm text-red-700">{messageOf(start.error)}</span>}
      </div>
      {latest && isRenderBusy(latest.state) && (
        <div className="mt-3" data-testid="export-progress">
          <div className="mb-1 flex justify-between text-sm text-slate-600 tabular-nums">
            <span>{RENDER_LABELS[latest.state]}</span>
            <span>{Math.round(latest.progress * 100)}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded bg-slate-100">
            <div className="h-full bg-slate-900 transition-[width]" style={{ width: `${latest.progress * 100}%` }} />
          </div>
        </div>
      )}
      {latest?.downloadUrl && (
        <a href={latest.downloadUrl} className="mt-3 inline-block text-sm font-medium text-slate-900 underline">
          下載這個版本最新的 MP4
        </a>
      )}
      {renders.data && renders.data.length > 0 && (
        <>
          <h3 className="mt-4 mb-1 text-sm font-medium text-slate-600">匯出紀錄</h3>
          <ul className="divide-y divide-slate-100 text-sm" data-testid="render-history">
            {renders.data.map((render) => (
              <li key={render.id} className="flex items-center justify-between gap-4 py-1.5 tabular-nums">
                <span className="text-slate-600">
                  {formatTime(render.createdAt)}・{(render.timelineId && versionNames.get(render.timelineId)) ?? '已刪除的版本'}
                </span>
                <span className={render.state === 'failed' ? 'text-red-700' : 'text-slate-700'}>
                  {RENDER_LABELS[render.state]}
                  {render.state === 'failed' && render.error ? `：${render.error}` : ''}
                </span>
                {render.downloadUrl ? (
                  <a href={render.downloadUrl} className="underline">
                    下載
                  </a>
                ) : (
                  <span />
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
