import path from 'node:path';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import { COMPOSITION_ID, type CompositionProps } from '@revcut/composition/props';
import { repoRoot } from '../config';

export type RenderVideo = (job: {
  props: CompositionProps;
  output: string;
  signal: AbortSignal;
  onProgress: (progress: number) => void;
}) => Promise<void>;

// On this 16 GB WSL machine Remotion's defaults (6 tabs, a frame cache sized from system
// memory) ran memory down to ~400 MB and hung a tab; 2 tabs and 512 MB rendered 464 frames in 46 s.
const CONCURRENCY = 2;
const FRAME_CACHE_BYTES = 512 * 1024 ** 2;

let serveUrl: Promise<string> | null = null;

// SPEC §18 item 14: bundle on the first export, then keep it for the life of the server.
function bundled(): Promise<string> {
  serveUrl ??= bundle({ entryPoint: path.join(repoRoot, 'packages/composition/src/entry.tsx') }).catch((error: unknown) => {
    serveUrl = null;
    throw error;
  });
  return serveUrl;
}

// SPEC §6.5: h264 at CRF 18 in yuv420p with AAC at 320k. BT.709 is Remotion 5's default; Remotion 4's
// default converts with BT.601 and leaves the matrix untagged, which players read as BT.709 and shift skin tones.
export const renderWithRemotion: RenderVideo = async ({ props, output, signal, onProgress }) => {
  const url = await bundled();
  const composition = await selectComposition({ serveUrl: url, id: COMPOSITION_ID, inputProps: props });
  await renderMedia({
    composition,
    serveUrl: url,
    inputProps: props,
    codec: 'h264',
    crf: 18,
    pixelFormat: 'yuv420p',
    colorSpace: 'bt709',
    audioCodec: 'aac',
    audioBitrate: '320k',
    outputLocation: output,
    concurrency: CONCURRENCY,
    offthreadVideoCacheSizeInBytes: FRAME_CACHE_BYTES,
    onProgress: ({ progress }) => onProgress(progress),
    cancelSignal: (cancel) => signal.addEventListener('abort', cancel, { once: true }),
  });
};
