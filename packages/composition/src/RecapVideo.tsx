import '@fontsource/noto-sans-tc/500.css';
import { CLIP_AUDIO_FADE_SEC, type Clip, computeTiming, FPS } from '@revcut/shared';
import { type CSSProperties, useEffect, useState } from 'react';
import { AbsoluteFill, Html5Audio, Img, OffthreadVideo, Sequence, useCurrentFrame, useDelayRender } from 'remotion';
import { edgeFade, tailFade } from './audio';
import { coverRect, kenBurnsZoom, type Rect } from './layout';
import type { ClipSource, CompositionProps } from './props';

const DATE_FONT = '500 36px "Noto Sans TC"';
const PREMOUNT_FRAMES = FPS;
// Chrome seeks a <video> in whole microseconds, so a target exactly on a frame boundary can show
// the frame before. Sampling a quarter frame in keeps the preview and the renderer on the same frame.
const SAMPLE_OFFSET_FRAMES = 0.25;

const placed = ({ left, top, width, height }: Rect): CSSProperties => ({
  position: 'absolute',
  left,
  top,
  width,
  height,
  maxWidth: 'none',
});

// SPEC §9.2: the first frame waits until the date glyphs are loaded, so no frame renders in a fallback font.
function useDateFont(text: string) {
  const { delayRender, continueRender, cancelRender } = useDelayRender();
  const [first] = useState(() => ({ handle: delayRender(`載入字型 ${DATE_FONT}`), text }));
  useEffect(() => {
    document.fonts.load(DATE_FONT, first.text).then(() => continueRender(first.handle), cancelRender);
  }, [first, continueRender, cancelRender]);
}

function ClipMedia({
  clip,
  source,
  frames,
  volume,
}: {
  clip: Clip;
  source: ClipSource;
  frames: number;
  volume: (frame: number) => number;
}) {
  const frame = useCurrentFrame();
  if (source.kind === 'photo') {
    const zoom = kenBurnsZoom(frame, frames, clip.crop.zoom, clip.kenBurns?.endZoom ?? clip.crop.zoom);
    return <Img src={source.src} style={placed(coverRect(source.width, source.height, { ...clip.crop, zoom }))} />;
  }
  return (
    <OffthreadVideo
      src={source.src}
      trimBefore={source.startFromSec * FPS + SAMPLE_OFFSET_FRAMES}
      volume={volume}
      pauseWhenBuffering
      style={placed(coverRect(source.width, source.height, clip.crop))}
    />
  );
}

function DateOverlay({ text }: { text: string }) {
  return (
    <div
      style={{
        position: 'absolute',
        left: 64,
        bottom: 480,
        font: DATE_FONT,
        lineHeight: 1,
        color: 'white',
        textShadow: '0 2px 8px rgba(0, 0, 0, 0.55), 0 0 2px rgba(0, 0, 0, 0.6)',
      }}
    >
      {text}
    </div>
  );
}

// SPEC §9: hard cuts on the beat grid of timing.ts, music from frame f0, each clip's own sound
// faded in and out, and the last fadeOutSec of the whole mix faded together.
export function RecapVideo({ timeline, music, sources }: CompositionProps) {
  const dates = timeline.overlayEnabled ? timeline.clips.flatMap((clip) => clip.date ?? []) : [];
  useDateFont(dates.join('') || '0');
  const timing = computeTiming(music.beats, timeline.music.startBeat, timeline.clips);
  if (!timing) return <AbsoluteFill style={{ backgroundColor: 'black' }} />;
  const { f0, totalFrames } = timing;
  const { fadeOutSec } = timeline.music;

  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      {timeline.clips.map((clip, k) => {
        const { startFrame, frames } = timing.clips[k]!;
        const source = sources[clip.id];
        return (
          <Sequence key={clip.id} from={startFrame} durationInFrames={frames} premountFor={PREMOUNT_FRAMES}>
            {source && (
              <ClipMedia
                clip={clip}
                source={source}
                frames={frames}
                volume={(frame) =>
                  clip.originalVolume * edgeFade(frame, frames, CLIP_AUDIO_FADE_SEC) * tailFade(startFrame + frame, totalFrames, fadeOutSec)
                }
              />
            )}
            {timeline.overlayEnabled && clip.date && <DateOverlay text={clip.date} />}
          </Sequence>
        );
      })}
      <Html5Audio
        src={music.src}
        trimBefore={f0}
        volume={(frame) => timeline.music.volume * tailFade(frame, totalFrames, fadeOutSec)}
      />
    </AbsoluteFill>
  );
}
