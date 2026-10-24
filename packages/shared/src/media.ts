import { z } from 'zod';
import { DraftState, MediaKind, MediaStatus } from './status';

export const MEDIA_EXTENSIONS = {
  mov: 'video',
  mp4: 'video',
  heic: 'photo',
  heif: 'photo',
  jpg: 'photo',
  jpeg: 'photo',
  png: 'photo',
} as const satisfies Record<string, MediaKind>;

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
}

export function kindFromExtension(ext: string): MediaKind | null {
  return Object.hasOwn(MEDIA_EXTENSIONS, ext) ? MEDIA_EXTENSIONS[ext as keyof typeof MEDIA_EXTENSIONS] : null;
}

export const MEDIA_STATUS_TRANSITIONS = {
  uploaded: ['processing'],
  processing: ['ready', 'failed', 'uploaded'],
  ready: [],
  failed: ['uploaded'],
} as const satisfies Record<MediaStatus, readonly MediaStatus[]>;

export type MediaTransition = {
  [From in MediaStatus]: { from: From; to: (typeof MEDIA_STATUS_TRANSITIONS)[From][number] };
}[MediaStatus];

export function isMediaBusy(status: MediaStatus): boolean {
  return status === 'uploaded' || status === 'processing';
}

export const Media = z.object({
  id: z.uuid(),
  kind: MediaKind,
  status: MediaStatus,
  error: z.string().nullable(),
  filename: z.string(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  durationSec: z.number().nullable(),
  isHdr: z.boolean().nullable(),
  hasAudio: z.boolean().nullable(),
  capturedAt: z.iso.datetime({ offset: true }).nullable(),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
  excluded: z.boolean(),
  livePhoto: z.boolean(),
  thumbUrl: z.string().nullable(),
  previewUrl: z.string().nullable(),
  analysis: z.null(),
});
export type Media = z.infer<typeof Media>;

export const PatchMediaBody = z.object({ excluded: z.boolean().optional() });
export type PatchMediaBody = z.infer<typeof PatchMediaBody>;

export const UploadMediaQuery = z.object({
  filename: z.string().min(1).max(255),
  lastModified: z.coerce.number().int().nonnegative().optional(),
});

export const MediaCounts = z.object({
  total: z.number().int(),
  ready: z.number().int(),
  processing: z.number().int(),
  failed: z.number().int(),
  excluded: z.number().int(),
});
export type MediaCounts = z.infer<typeof MediaCounts>;

export const Project = z.object({
  id: z.uuid(),
  title: z.string(),
  dateRange: z.object({ from: z.iso.date(), to: z.iso.date() }).nullable(),
  draftState: DraftState,
  draftError: z.string().nullable(),
  currentTimelineId: z.uuid().nullable(),
  mediaCounts: MediaCounts,
});
export type Project = z.infer<typeof Project>;

const ProjectTitle = z.string().trim().min(1, '請輸入專案名稱').max(100);

export const CreateProjectBody = z.object({ title: ProjectTitle });
export type CreateProjectBody = z.infer<typeof CreateProjectBody>;

export const PatchProjectBody = z.object({ title: ProjectTitle.optional() });
export type PatchProjectBody = z.infer<typeof PatchProjectBody>;
