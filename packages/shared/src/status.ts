import { z } from 'zod';

export const MEDIA_KINDS = ['video', 'photo'] as const;
export const MediaKind = z.enum(MEDIA_KINDS);
export type MediaKind = z.infer<typeof MediaKind>;

export const MEDIA_STATUSES = ['uploaded', 'processing', 'ready', 'failed'] as const;
export const MediaStatus = z.enum(MEDIA_STATUSES);
export type MediaStatus = z.infer<typeof MediaStatus>;

export const MUSIC_STATUSES = ['uploaded', 'analyzing', 'ready', 'failed'] as const;
export const MusicStatus = z.enum(MUSIC_STATUSES);
export type MusicStatus = z.infer<typeof MusicStatus>;

export const DRAFT_STATES = ['idle', 'queued', 'transcribing', 'analyzing', 'planning', 'done', 'failed'] as const;
export const DraftState = z.enum(DRAFT_STATES);
export type DraftState = z.infer<typeof DraftState>;

export const RENDER_STATES = ['queued', 'preparing', 'rendering', 'done', 'failed'] as const;
export const RenderState = z.enum(RENDER_STATES);
export type RenderState = z.infer<typeof RenderState>;

export const ANALYSIS_RUN_STATUSES = ['running', 'done', 'failed'] as const;
export const AnalysisRunStatus = z.enum(ANALYSIS_RUN_STATUSES);
export type AnalysisRunStatus = z.infer<typeof AnalysisRunStatus>;

export const AI_PROVIDERS = ['anthropic', 'openai'] as const;
export const AiProvider = z.enum(AI_PROVIDERS);
export type AiProvider = z.infer<typeof AiProvider>;
