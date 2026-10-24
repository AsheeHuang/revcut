import { Player, type PlayerRef } from '@remotion/player';
import { type CompositionProps, IgSafeZoneMask, RecapVideo, recapDurationInFrames } from '@revcut/composition';
import {
  type AiProvider,
  computeTiming,
  FPS,
  framesToSec,
  HEIGHT,
  isDraftBusy,
  isRenderBusy,
  Project,
  Render,
  StartRenderResponse,
  type Timeline,
  type Timing,
  TimelineDetail,
  TimelineSummary,
  type ValidationIssue,
  WIDTH,
} from '@revcut/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api, messageOf } from './api';
import { AiChoice, DraftProgress, useAiChoice } from './DraftControls';

const POLL_MS = 2000;
const PLAYER_HEIGHT = 720;

const formatTime = (iso: string) =>
  new Date(iso).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

// SPEC §9.1: the preview plays the 720p preview files from the clip's own in-point.
function previewProps({ data, assets }: TimelineDetail): CompositionProps | null {
  if (!assets.music) return null;
  const sources = Object.fromEntries(
    data.clips.flatMap((clip) => {
      const media = assets.media[clip.mediaId];
      if (!media) return [];
      const { kind, previewUrl, width, height } = media;
      return [[clip.id, { kind, src: previewUrl, startFromSec: clip.sourceInSec, width, height }]];
    }),
  );
  return { timeline: data, music: { src: assets.music.url, beats: assets.music.beats }, sources };
}

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
  const timelineId = project.data?.currentTimelineId;
  // AI 重排 makes a new version and switches to it.
  useEffect(() => {
    if (timelineId) void queryClient.invalidateQueries({ queryKey: ['project', id, 'timelines'] });
  }, [timelineId, queryClient, id]);
  const timeline = useQuery({
    queryKey: ['timeline', timelineId],
    queryFn: () => api(TimelineDetail, `/api/timelines/${timelineId}`),
    enabled: Boolean(timelineId),
  });
  const switchVersion = useMutation({
    mutationFn: (currentTimelineId: string) => api(Project, `/api/projects/${id}`, { method: 'PATCH', body: { currentTimelineId } }),
    onSuccess: (updated) => queryClient.setQueryData(['project', id], updated),
  });

  const versionNames = useMemo(
    () => new Map(versions.data?.map((version, i) => [version.id, `版本 ${versions.data.length - i}`])),
    [versions.data],
  );
  const playerRef = useRef<PlayerRef>(null);
  const [showMask, setShowMask] = useState(true);
  const detail = timeline.data;
  const props = useMemo(() => (detail ? previewProps(detail) : null), [detail]);
  const timing = useMemo(
    () => (detail?.assets.music ? computeTiming(detail.assets.music.beats, detail.data.music.startBeat, detail.data.clips) : null),
    [detail],
  );
  const current = useCurrentClip(playerRef, timing);
  const seekToClip = (clipId: string) => {
    const k = detail?.data.clips.findIndex((clip) => clip.id === clipId) ?? -1;
    if (timing && k >= 0) playerRef.current?.seekTo(timing.clips[k]!.startFrame);
  };

  return (
    <main className="mx-auto max-w-6xl p-8">
      <Link to={`/projects/${id}`} className="text-sm text-slate-500 hover:text-slate-900">
        ← 素材
      </Link>
      {project.isError && <p className="mt-4 text-red-700">無法載入專案：{messageOf(project.error)}</p>}
      {project.data && (
        <header className="mt-2 mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">{project.data.title}</h1>
            {detail && (
              <p className="text-sm text-slate-600 tabular-nums" data-testid="timeline-summary">
                總長 {detail.durationSec === null ? '–' : detail.durationSec.toFixed(1)} 秒｜{detail.data.clips.length} 段｜錯誤{' '}
                {detail.validation.errors.length} 項｜警告 {detail.validation.warnings.length} 項
              </p>
            )}
          </div>
          {versions.data && timelineId && (
            <label className="flex items-center gap-2 text-sm">
              <span className="text-slate-600">版本</span>
              <select
                value={timelineId}
                onChange={(event) => switchVersion.mutate(event.target.value)}
                disabled={switchVersion.isPending}
                className="rounded border border-slate-300 bg-white px-2 py-1"
              >
                {versions.data.map((version) => (
                  <option key={version.id} value={version.id}>
                    {versionNames.get(version.id)}（{formatTime(version.createdAt)}）
                  </option>
                ))}
              </select>
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
      {timeline.isError && <p className="text-red-700">無法載入時間軸：{messageOf(timeline.error)}</p>}
      {detail && (
        <>
          <div className="grid grid-cols-[auto_1fr] gap-8">
            <div>
              {props ? (
                <div className="relative bg-black" style={{ width: (PLAYER_HEIGHT * WIDTH) / HEIGHT, height: PLAYER_HEIGHT }}>
                  <Player
                    ref={playerRef}
                    component={RecapVideo}
                    inputProps={props}
                    durationInFrames={recapDurationInFrames(props)}
                    compositionWidth={WIDTH}
                    compositionHeight={HEIGHT}
                    fps={FPS}
                    controls
                    acknowledgeRemotionLicense
                    style={{ width: '100%', height: '100%' }}
                  />
                  {showMask && <IgSafeZoneMask />}
                </div>
              ) : (
                <p className="text-red-700">歌曲已刪除或還沒分析完成，無法預覽。</p>
              )}
              <label className="mt-3 flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" checked={showMask} onChange={(event) => setShowMask(event.target.checked)} />
                顯示 IG 介面遮罩
              </label>
            </div>
            <div className="space-y-6">
              <ValidationPanel errors={detail.validation.errors} warnings={detail.validation.warnings} onSelect={seekToClip} />
              {project.data && <RedraftPanel project={project.data} timeline={detail.data} />}
              <ExportPanel
                projectId={id}
                timelineId={detail.id}
                versionNames={versionNames}
                blocked={detail.validation.errors.length > 0}
              />
            </div>
          </div>
          <ClipStrip detail={detail} timing={timing} current={current} onSelect={seekToClip} />
        </>
      )}
    </main>
  );
}

function useCurrentClip(playerRef: RefObject<PlayerRef | null>, timing: Timing | null): number {
  const [current, setCurrent] = useState(0);
  useEffect(() => {
    const player = playerRef.current;
    if (!player || !timing) return;
    const onFrame = ({ detail }: { detail: { frame: number } }) =>
      setCurrent(timing.clips.findLastIndex((clip) => clip.startFrame <= detail.frame));
    player.addEventListener('frameupdate', onFrame);
    return () => player.removeEventListener('frameupdate', onFrame);
  }, [playerRef, timing]);
  return current;
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
    <section className="rounded-lg border border-slate-200 bg-white p-4">
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
function RedraftPanel({ project, timeline }: { project: Project; timeline: Timeline }) {
  const queryClient = useQueryClient();
  const choice = useAiChoice(project);
  const redraft = useMutation({
    mutationFn: (provider: AiProvider) =>
      api(Project, `/api/projects/${project.id}/draft`, {
        method: 'POST',
        body: { trackId: timeline.music.trackId, startBeat: timeline.music.startBeat, provider },
      }),
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
}: {
  projectId: string;
  timelineId: string;
  versionNames: Map<string, string>;
  blocked: boolean;
}) {
  const queryClient = useQueryClient();
  const renders = useQuery({
    queryKey: ['project', projectId, 'renders'],
    queryFn: () => api(Render.array(), `/api/projects/${projectId}/renders`),
    refetchInterval: (query) => (query.state.data?.some((render) => isRenderBusy(render.state)) ? POLL_MS : false),
  });
  const start = useMutation({
    mutationFn: () => api(StartRenderResponse, `/api/timelines/${timelineId}/renders`, { method: 'POST' }),
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

function ClipStrip({
  detail,
  timing,
  current,
  onSelect,
}: {
  detail: TimelineDetail;
  timing: Timing | null;
  current: number;
  onSelect: (clipId: string) => void;
}) {
  return (
    <section className="mt-8">
      <h2 className="mb-2 font-semibold">片段</h2>
      <ol className="flex gap-1" data-testid="clip-strip">
        {detail.data.clips.map((clip, k) => (
          <li key={clip.id} style={{ flex: `${clip.beats} 1 0` }} className="min-w-0">
            <button
              type="button"
              onClick={() => onSelect(clip.id)}
              className={`block w-full overflow-hidden rounded border-2 bg-white text-left ${
                k === current ? 'border-slate-900' : 'border-transparent'
              }`}
            >
              <img src={`/api/media/${clip.mediaId}/thumb`} alt="" className="h-20 w-full object-cover" />
              <span className="block truncate px-1 py-0.5 text-xs text-slate-600 tabular-nums">
                {clip.beats} 拍{timing ? `・${framesToSec(timing.clips[k]!.frames).toFixed(2)} 秒` : ''}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
