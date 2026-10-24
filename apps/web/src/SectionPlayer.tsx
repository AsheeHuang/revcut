import { type MusicAnalysis, type MusicTrack, MusicTrackDetail, type SuggestedSection } from '@revcut/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, messageOf } from './api';

const LEAD_SEC = 0.1;
const CLICK_SEC = 0.05;
const MUSIC_GAIN = 0.7;

export function formatSec(sec: number): string {
  const whole = Math.floor(sec);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

type Playback =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'playing'; startAt: number; stop: () => void }
  | { state: 'failed'; message: string };

function scheduleClick(ctx: AudioContext, out: AudioNode, at: number, downbeat: boolean) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = downbeat ? 1760 : 1100;
  gain.gain.setValueAtTime(downbeat ? 0.9 : 0.35, at);
  gain.gain.exponentialRampToValueAtTime(0.001, at + CLICK_SEC);
  osc.connect(gain).connect(out);
  osc.start(at);
  osc.stop(at + CLICK_SEC);
}

export function SectionPlayer({ track }: { track: MusicTrack }) {
  const detail = useQuery({
    queryKey: ['music', track.id],
    queryFn: () => api(MusicTrackDetail, `/api/music/${track.id}`),
  });
  const analysis = detail.data?.analysis;
  const section = analysis?.suggestedSection;

  return (
    <section className="mb-8 rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="font-semibold">試聽：{track.title}</h2>
      {detail.isError && <p className="text-red-700">無法載入拍點：{messageOf(detail.error)}</p>}
      {analysis && !section && <p className="text-slate-500">這首歌沒有符合 20–25 秒的建議段落。</p>}
      {analysis && section && <SectionTransport audioUrl={track.audioUrl} analysis={analysis} section={section} />}
    </section>
  );
}

function SectionTransport({
  audioUrl,
  analysis,
  section,
}: {
  audioUrl: string;
  analysis: MusicAnalysis;
  section: SuggestedSection;
}) {
  const ctxRef = useRef<AudioContext | null>(null);
  const bufferRef = useRef<Promise<AudioBuffer> | null>(null);
  const [playback, setPlayback] = useState<Playback>({ state: 'idle' });
  const [elapsed, setElapsed] = useState(0);
  const { beats } = analysis;
  const downbeats = new Set(analysis.downbeatIndices);
  const sectionBeats = Array.from({ length: section.totalBeats }, (_, i) => section.startBeat + i);

  useEffect(() => () => void ctxRef.current?.close(), []);

  useEffect(() => {
    if (playback.state !== 'playing') return;
    let frame = 0;
    const tick = () => {
      const t = ctxRef.current!.currentTime - playback.startAt;
      if (t >= section.durationSec) {
        playback.stop();
        setPlayback({ state: 'idle' });
        return;
      }
      setElapsed(Math.max(0, t));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playback, section.durationSec]);

  async function play() {
    setPlayback({ state: 'loading' });
    try {
      const ctx = (ctxRef.current ??= new AudioContext());
      await ctx.resume();
      bufferRef.current ??= fetch(audioUrl)
        .then((res) => res.arrayBuffer())
        .then((bytes) => ctx.decodeAudioData(bytes));
      const buffer = await bufferRef.current;

      const bus = ctx.createGain();
      bus.connect(ctx.destination);
      const music = ctx.createGain();
      music.gain.value = MUSIC_GAIN;
      music.connect(bus);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(music);

      const startAt = ctx.currentTime + LEAD_SEC;
      source.start(startAt, section.startSec, section.durationSec);
      for (const i of sectionBeats) scheduleClick(ctx, bus, startAt + beats[i]! - section.startSec, downbeats.has(i));
      setElapsed(0);
      setPlayback({
        state: 'playing',
        startAt,
        stop: () => {
          source.stop();
          bus.disconnect();
        },
      });
    } catch (error) {
      bufferRef.current = null;
      setPlayback({ state: 'failed', message: `無法播放：${messageOf(error)}` });
    }
  }

  const now = section.startSec + elapsed;
  const current = sectionBeats.findLast((i) => beats[i]! <= now) ?? section.startBeat;
  const counted = current - section.startBeat;
  const position = (t: number) => `${((t - section.startSec) / section.durationSec) * 100}%`;

  return (
    <div className="mt-2 space-y-3 text-sm">
      <p className="text-slate-600">
        建議段落 {formatSec(section.startSec)}–{formatSec(section.startSec + section.durationSec)}，{section.bars} 小節（
        {section.totalBeats} 拍，{section.durationSec.toFixed(1)} 秒）。節拍器聲在每一拍響一次，重拍較高較響。
      </p>
      <div className="relative h-10 rounded bg-slate-100" data-testid="beat-ruler">
        {sectionBeats.map((i) => (
          <span
            key={i}
            className={`absolute bottom-0 w-px ${downbeats.has(i) ? 'h-full bg-slate-700' : 'h-1/3 bg-slate-400'}`}
            style={{ left: position(beats[i]!) }}
          />
        ))}
        {playback.state === 'playing' && (
          <span className="absolute top-0 bottom-0 w-0.5 bg-red-600" style={{ left: position(now) }} />
        )}
      </div>
      <div className="flex items-center gap-4">
        {playback.state === 'playing' ? (
          <button
            type="button"
            onClick={() => {
              playback.stop();
              setPlayback({ state: 'idle' });
            }}
            className="rounded bg-slate-900 px-3 py-1 text-white hover:bg-slate-700"
          >
            停止
          </button>
        ) : (
          <button
            type="button"
            onClick={play}
            disabled={playback.state === 'loading'}
            className="rounded bg-slate-900 px-3 py-1 text-white hover:bg-slate-700 disabled:opacity-50"
          >
            {playback.state === 'loading' ? '載入中…' : '播放建議段落（含節拍器）'}
          </button>
        )}
        {playback.state === 'playing' && (
          <span className="tabular-nums text-slate-600" data-testid="beat-counter">
            第 {Math.floor(counted / section.beatsPerBar) + 1} 小節・第 {(counted % section.beatsPerBar) + 1} 拍
            （{formatSec(now)}）
          </span>
        )}
        {playback.state === 'failed' && <span className="text-red-700">{playback.message}</span>}
      </div>
    </div>
  );
}
