import { z } from 'zod';
import { extensionOf } from './media';
import { Energy, SuggestedSection } from './section';
import { MusicStatus } from './status';

export const MUSIC_EXTENSIONS = ['mp3', 'm4a', 'aac', 'wav', 'flac'] as const;
export const MAX_MUSIC_BYTES = 50 * 1024 ** 2;

export function isMusicExtension(filename: string): boolean {
  return (MUSIC_EXTENSIONS as readonly string[]).includes(extensionOf(filename));
}

export function titleFromFilename(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(0, dot) : filename;
}

export const MUSIC_STATUS_TRANSITIONS = {
  uploaded: ['analyzing'],
  analyzing: ['ready', 'failed', 'uploaded'],
  ready: [],
  failed: ['uploaded'],
} as const satisfies Record<MusicStatus, readonly MusicStatus[]>;

export type MusicTransition = {
  [From in MusicStatus]: { from: From; to: (typeof MUSIC_STATUS_TRANSITIONS)[From][number] };
}[MusicStatus];

export function isMusicBusy(status: MusicStatus): boolean {
  return status === 'uploaded' || status === 'analyzing';
}

export const MusicTrack = z.object({
  id: z.uuid(),
  title: z.string(),
  artist: z.string().nullable(),
  status: MusicStatus,
  error: z.string().nullable(),
  durationSec: z.number().nullable(),
  bpm: z.number().nullable(),
  audioUrl: z.string(),
});
export type MusicTrack = z.infer<typeof MusicTrack>;

export const MusicAnalysis = z.object({
  beats: z.array(z.number()),
  downbeatIndices: z.array(z.number().int()),
  energy: Energy,
  suggestedSection: SuggestedSection.nullable(),
});
export type MusicAnalysis = z.infer<typeof MusicAnalysis>;

export const MusicTrackDetail = MusicTrack.extend({ analysis: MusicAnalysis.nullable() });
export type MusicTrackDetail = z.infer<typeof MusicTrackDetail>;

export const UploadMusicQuery = z.object({ filename: z.string().min(1).max(255) });

export const PatchMusicBody = z.object({
  title: z.string().trim().min(1, '請輸入歌名').max(200).optional(),
  artist: z
    .string()
    .trim()
    .max(200)
    .transform((artist) => artist || null)
    .nullable()
    .optional(),
});
export type PatchMusicBody = z.infer<typeof PatchMusicBody>;
