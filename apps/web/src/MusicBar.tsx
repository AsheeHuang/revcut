import { MusicTrack } from '@revcut/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { api, messageOf } from './api';
import { newGesture, songQuery, type TimelineEditor } from './useTimelineEditor';

// SPEC §11.3: song, start bar, fade-out, and volume, with the total length and issue counts.
export function MusicBar({
  editor,
  totalSec,
  bars,
  errors,
  warnings,
}: {
  editor: TimelineEditor;
  totalSec: number | null;
  bars: number | null;
  errors: number;
  warnings: number;
}) {
  const { timeline, song, dispatch, can } = editor;
  const queryClient = useQueryClient();
  const tracks = useQuery({ queryKey: ['music'], queryFn: () => api(MusicTrack.array(), '/api/music') });
  const [loadError, setLoadError] = useState<string | null>(null);
  const fade = useRef<string | null>(null);
  const volume = useRef<string | null>(null);
  if (!timeline) return null;
  const { music } = timeline;
  const analysis = song?.analysis;
  const bar = analysis ? analysis.downbeatIndices.indexOf(music.startBeat) + 1 : 0;

  const changeSong = async (trackId: string) => {
    setLoadError(null);
    try {
      const next = await queryClient.fetchQuery(songQuery(trackId));
      if (!next.analysis) throw new Error('這首歌還沒分析完成');
      const { beats, downbeatIndices, energy } = next.analysis;
      dispatch({ type: 'changeSong', track: { id: trackId, beats, downbeatIndices, energy } });
    } catch (error) {
      setLoadError(messageOf(error));
    }
  };

  return (
    <section className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-lg border border-slate-200 bg-white p-4 text-sm" data-testid="music-bar">
      <label className="flex items-center gap-2">
        <span className="text-slate-600">音樂</span>
        <select
          value={music.trackId}
          onChange={(event) => void changeSong(event.target.value)}
          className="max-w-56 rounded border border-slate-300 bg-white px-2 py-1"
          data-testid="song-picker"
        >
          {!tracks.data?.some((t) => t.id === music.trackId) && <option value={music.trackId}>（已刪除的歌）</option>}
          {tracks.data
            ?.filter((t) => t.status === 'ready' || t.id === music.trackId)
            .map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
                {t.bpm ? `（${Math.round(t.bpm)} BPM）` : ''}
              </option>
            ))}
        </select>
      </label>

      <div className="flex items-center gap-2">
        <span className="text-slate-600">起始小節</span>
        <button
          type="button"
          aria-label="提早一小節"
          onClick={() => dispatch({ type: 'moveStart', bars: -1 })}
          disabled={!can({ type: 'moveStart', bars: -1 })}
          className="h-7 w-7 rounded border border-slate-300 disabled:opacity-40"
        >
          ‹
        </button>
        <span className="tabular-nums" data-testid="start-bar">
          第 {bar || '–'} 小節{analysis && `・${analysis.beats[music.startBeat]?.toFixed(1)} 秒`}
        </span>
        <button
          type="button"
          aria-label="延後一小節"
          onClick={() => dispatch({ type: 'moveStart', bars: 1 })}
          disabled={!can({ type: 'moveStart', bars: 1 })}
          className="h-7 w-7 rounded border border-slate-300 disabled:opacity-40"
        >
          ›
        </button>
      </div>

      <label className="flex items-center gap-2">
        <span className="text-slate-600">淡出</span>
        <input
          type="range"
          min={0}
          max={5}
          step={0.1}
          value={music.fadeOutSec}
          onPointerDown={() => (fade.current = newGesture('fade'))}
          onKeyDown={() => (fade.current = newGesture('fade'))}
          onChange={(event) => dispatch({ type: 'setFadeOut', sec: Number(event.target.value) }, fade.current)}
          className="w-24"
        />
        <span className="w-12 tabular-nums">{music.fadeOutSec.toFixed(1)} 秒</span>
      </label>

      <label className="flex items-center gap-2">
        <span className="text-slate-600">音量</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={music.volume}
          aria-label="音樂音量"
          onPointerDown={() => (volume.current = newGesture('music-volume'))}
          onKeyDown={() => (volume.current = newGesture('music-volume'))}
          onChange={(event) => dispatch({ type: 'setMusicVolume', volume: Number(event.target.value) }, volume.current)}
          className="w-24"
        />
        <span className="w-10 tabular-nums">{Math.round(music.volume * 100)}%</span>
      </label>

      <span className="tabular-nums text-slate-700" data-testid="timeline-summary">
        總長 {totalSec === null ? '–' : totalSec.toFixed(1)} 秒{bars !== null && (Number.isInteger(bars) ? `（${bars} 小節）` : '（不是整數小節）')}｜{timeline.clips.length} 段｜
        <span className={errors ? 'text-red-700' : ''}>錯誤 {errors} 項</span>｜
        <span className={warnings ? 'text-amber-700' : ''}>警告 {warnings} 項</span>
      </span>

      {loadError && <p className="w-full text-red-700">{loadError}</p>}
    </section>
  );
}
