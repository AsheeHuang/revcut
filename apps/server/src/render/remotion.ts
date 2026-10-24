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

let serveUrl: Promise<string> | null = null;

// SPEC §18 item 14: bundle on the first export, then keep it for the life of the server.
function bundled(): Promise<string> {
  serveUrl ??= bundle({ entryPoint: path.join(repoRoot, 'packages/composition/src/entry.tsx') }).catch((error: unknown) => {
    serveUrl = null;
    throw error;
  });
  return serveUrl;
}

// SPEC §6.5: h264 at CRF 18 in yuv420p with AAC at 320k.
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
    audioCodec: 'aac',
    audioBitrate: '320k',
    outputLocation: output,
    onProgress: ({ progress }) => onProgress(progress),
    cancelSignal: (cancel) => signal.addEventListener('abort', cancel, { once: true }),
  });
};
