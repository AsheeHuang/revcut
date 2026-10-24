import { type Clip, localDate, type Media, type Moment } from '@revcut/shared';
import { type PointerEvent, type ReactNode, useRef } from 'react';
import { newGesture, type TimelineEditor } from './useTimelineEditor';

const pct = (value: number) => `${Math.round(value * 100)}%`;

function useGesture(name: string) {
  const key = useRef<string | null>(null);
  return { begin: () => (key.current = newGesture(name)), key: () => key.current };
}

// SPEC §11.3: the selected clip's media, length, in-point, crop, date, and original volume.
export function ClipInspector({
  editor,
  clip,
  index,
  clipSec,
  media,
  onReplace,
}: {
  editor: TimelineEditor;
  clip: Clip;
  index: number;
  clipSec: number | null;
  media: Media | undefined;
  onReplace: () => void;
}) {
  const { dispatch, can } = editor;
  const zoom = useGesture('zoom');
  const date = useGesture('date');
  const volume = useGesture('volume');
  const isVideo = media?.kind === 'video';
  const clipId = clip.id;

  return (
    <section className="space-y-4 rounded-lg border border-slate-200 bg-white p-4 text-sm" data-testid="inspector">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">
          第 {index + 1} 段<span className="ml-2 font-normal text-slate-500">{media?.analysis?.description ?? media?.filename}</span>
        </h2>
        <div className="flex shrink-0 gap-2">
          <button type="button" onClick={onReplace} className="rounded border border-slate-300 px-2 py-1 hover:bg-slate-50">
            換素材
          </button>
          <button
            type="button"
            onClick={() => dispatch({ type: 'delete', clipId })}
            className="rounded border border-slate-300 px-2 py-1 text-red-700 hover:bg-red-50"
          >
            刪除
          </button>
        </div>
      </div>

      <Row label="拍數">
        <button
          type="button"
          aria-label="少一拍"
          onClick={() => dispatch({ type: 'nudgeBeats', clipId, delta: -1 })}
          disabled={!can({ type: 'nudgeBeats', clipId, delta: -1 })}
          className="h-7 w-7 rounded border border-slate-300 disabled:opacity-40"
        >
          −
        </button>
        <span className="w-28 text-center tabular-nums" data-testid="clip-beats">
          {clip.beats} 拍{clipSec !== null && `・${clipSec.toFixed(2)} 秒`}
        </span>
        <button
          type="button"
          aria-label="多一拍"
          onClick={() => dispatch({ type: 'nudgeBeats', clipId, delta: 1 })}
          disabled={!can({ type: 'nudgeBeats', clipId, delta: 1 })}
          className="h-7 w-7 rounded border border-slate-300 disabled:opacity-40"
        >
          +
        </button>
      </Row>

      {isVideo && media.durationSec !== null && clipSec !== null && (
        <Row label="起點">
          <InPointScrubber
            durationSec={media.durationSec}
            clipSec={clipSec}
            sourceInSec={clip.sourceInSec}
            moments={media.analysis?.moments ?? []}
            onChange={(sec, gesture) => dispatch({ type: 'setSourceIn', clipId, sec }, gesture)}
          />
        </Row>
      )}

      <Row label="裁切">
        <input
          type="range"
          min={1}
          max={3}
          step={0.01}
          value={clip.crop.zoom}
          aria-label="縮放"
          onPointerDown={zoom.begin}
          onKeyDown={zoom.begin}
          onChange={(event) => dispatch({ type: 'setCrop', clipId, crop: { zoom: Number(event.target.value) } }, zoom.key())}
          className="flex-1"
        />
        <span className="w-12 text-right tabular-nums">{clip.crop.zoom.toFixed(2)}×</span>
      </Row>
      <p className="-mt-2 pl-20 text-xs text-slate-500">在預覽畫面上拖曳可以移動焦點</p>

      <Row label="日期">
        <input
          type="checkbox"
          checked={clip.date !== null}
          aria-label="顯示日期"
          onChange={(event) =>
            dispatch({ type: 'setDate', clipId, date: event.target.checked ? (localDate(media?.capturedAt ?? null) ?? '') : null })
          }
        />
        {clip.date !== null && (
          <input
            type="text"
            value={clip.date}
            aria-label="日期文字"
            onFocus={date.begin}
            onChange={(event) => dispatch({ type: 'setDate', clipId, date: event.target.value }, date.key())}
            className="w-40 rounded border border-slate-300 px-2 py-1 tabular-nums"
          />
        )}
        {clip.date === null && <span className="text-slate-500">不顯示</span>}
      </Row>

      {isVideo && (
        <Row label="原音音量">
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={clip.originalVolume}
            aria-label="原音音量"
            onPointerDown={volume.begin}
            onKeyDown={volume.begin}
            onChange={(event) => dispatch({ type: 'setOriginalVolume', clipId, volume: Number(event.target.value) }, volume.key())}
            className="flex-1"
          />
          <span className="w-12 text-right tabular-nums">{pct(clip.originalVolume)}</span>
        </Row>
      )}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-16 shrink-0 text-slate-600">{label}</span>
      {children}
    </div>
  );
}

// Dragging moves the clip's window over the whole source; AI moments are marked so a window can center on one.
function InPointScrubber({
  durationSec,
  clipSec,
  sourceInSec,
  moments,
  onChange,
}: {
  durationSec: number;
  clipSec: number;
  sourceInSec: number;
  moments: Moment[];
  onChange: (sec: number, gesture: string) => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<{ gesture: string; grabSec: number } | null>(null);
  const secAt = (event: PointerEvent) => {
    const rect = track.current!.getBoundingClientRect();
    return ((event.clientX - rect.left) / rect.width) * durationSec;
  };
  const inWindow = (sec: number) => sec >= sourceInSec && sec <= sourceInSec + clipSec;

  const onPointerDown = (event: PointerEvent) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const sec = secAt(event);
    const gesture = newGesture('in-point');
    drag.current = { gesture, grabSec: inWindow(sec) ? sec - sourceInSec : clipSec / 2 };
    if (!inWindow(sec)) onChange(sec - clipSec / 2, gesture);
  };
  const onPointerMove = (event: PointerEvent) => {
    if (drag.current) onChange(secAt(event) - drag.current.grabSec, drag.current.gesture);
  };
  const end = () => (drag.current = null);

  return (
    <div className="flex-1">
      <div
        ref={track}
        className="relative h-8 cursor-ew-resize touch-none rounded bg-slate-100"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        onPointerCancel={end}
        data-testid="in-point-scrubber"
      >
        <div
          className="absolute inset-y-0 rounded bg-slate-900/70"
          style={{ left: `${(sourceInSec / durationSec) * 100}%`, width: `${(clipSec / durationSec) * 100}%` }}
        />
        {moments.map((moment, i) => (
          <div
            key={i}
            title={`AI 建議的瞬間：${moment.t.toFixed(1)} 秒（${moment.score} 分）`}
            className="pointer-events-none absolute -top-1 h-10 w-0.5 bg-amber-500"
            style={{ left: `${(moment.t / durationSec) * 100}%` }}
            data-testid="moment-marker"
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-xs text-slate-500 tabular-nums">
        <span data-testid="in-point">
          從 {sourceInSec.toFixed(2)} 秒開始，到 {(sourceInSec + clipSec).toFixed(2)} 秒
        </span>
        <span>影片 {durationSec.toFixed(1)} 秒</span>
      </div>
    </div>
  );
}
