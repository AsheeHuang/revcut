import {
  AI_PROVIDERS,
  ANALYSIS_RUN_STATUSES,
  DRAFT_STATES,
  MEDIA_KINDS,
  MEDIA_STATUSES,
  MUSIC_STATUSES,
  type Moment,
  RENDER_STATES,
} from '@revcut/shared';
import { sql, type SQL } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

function oneOf(column: AnyPgColumn, values: readonly string[]): SQL {
  return sql`${column} in (${sql.raw(values.map((value) => `'${value}'`).join(', '))})`;
}

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const projects = pgTable(
  'projects',
  {
    id: id(),
    title: text('title').notNull(),
    currentTimelineId: uuid('current_timeline_id').references((): AnyPgColumn => timelines.id, {
      onDelete: 'set null',
    }),
    draftState: text('draft_state', { enum: DRAFT_STATES }).notNull().default('idle'),
    draftError: text('draft_error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [check('projects_draft_state_check', oneOf(t.draftState, DRAFT_STATES))],
);

export const media = pgTable(
  'media',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: MEDIA_KINDS }).notNull(),
    status: text('status', { enum: MEDIA_STATUSES }).notNull().default('uploaded'),
    error: text('error'),
    filename: text('filename').notNull(),
    ext: text('ext').notNull(),
    mimeType: text('mime_type'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    fileLastModified: timestamp('file_last_modified', { withTimezone: true }),
    sha256: text('sha256').notNull(),
    width: integer('width'),
    height: integer('height'),
    durationSec: real('duration_sec'),
    fps: real('fps'),
    isHdr: boolean('is_hdr'),
    hasAudio: boolean('has_audio'),
    capturedAt: timestamp('captured_at', { withTimezone: true }),
    utcOffsetMin: smallint('utc_offset_min'),
    lat: doublePrecision('lat'),
    lng: doublePrecision('lng'),
    excluded: boolean('excluded').notNull().default(false),
    contentIdentifier: text('content_identifier'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('media_kind_check', oneOf(t.kind, MEDIA_KINDS)),
    check('media_status_check', oneOf(t.status, MEDIA_STATUSES)),
    unique('media_project_id_sha256_key').on(t.projectId, t.sha256),
    index('media_project_id_captured_at_idx').on(t.projectId, t.capturedAt),
    index('media_project_id_content_identifier_idx').on(t.projectId, t.contentIdentifier),
  ],
);

export const analysisRuns = pgTable(
  'analysis_runs',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    mediaIds: uuid('media_ids').array().notNull(),
    provider: text('provider', { enum: AI_PROVIDERS }).notNull(),
    model: text('model').notNull(),
    effort: text('effort').notNull(),
    status: text('status', { enum: ANALYSIS_RUN_STATUSES }).notNull(),
    error: text('error'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    costUsd: numeric('cost_usd', { precision: 8, scale: 4 }),
    response: jsonb('response'),
    createdAt: createdAt(),
  },
  (t) => [
    check('analysis_runs_provider_check', oneOf(t.provider, AI_PROVIDERS)),
    check('analysis_runs_status_check', oneOf(t.status, ANALYSIS_RUN_STATUSES)),
  ],
);

export const mediaAnalysis = pgTable(
  'media_analysis',
  {
    analysisRunId: uuid('analysis_run_id')
      .notNull()
      .references(() => analysisRuns.id, { onDelete: 'cascade' }),
    mediaId: uuid('media_id')
      .notNull()
      .references(() => media.id, { onDelete: 'cascade' }),
    usable: boolean('usable').notNull(),
    score: smallint('score').notNull(),
    description: text('description').notNull(),
    moments: jsonb('moments').$type<Moment[]>().notNull(),
    duplicateOf: uuid('duplicate_of').references(() => media.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.analysisRunId, t.mediaId] })],
);

export const musicTracks = pgTable(
  'music_tracks',
  {
    id: id(),
    title: text('title').notNull(),
    artist: text('artist'),
    status: text('status', { enum: MUSIC_STATUSES }).notNull().default('uploaded'),
    error: text('error'),
    filename: text('filename').notNull(),
    ext: text('ext').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    durationSec: real('duration_sec'),
    bpm: real('bpm'),
    beats: doublePrecision('beats').array(),
    downbeatIndices: integer('downbeat_indices').array(),
    energy: real('energy').array(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [check('music_tracks_status_check', oneOf(t.status, MUSIC_STATUSES))],
);

export const timelines = pgTable('timelines', {
  id: id(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  analysisRunId: uuid('analysis_run_id').references(() => analysisRuns.id, { onDelete: 'set null' }),
  seed: integer('seed').notNull(),
  data: jsonb('data').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const renders = pgTable(
  'renders',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    timelineId: uuid('timeline_id').references(() => timelines.id, { onDelete: 'set null' }),
    snapshot: jsonb('snapshot').notNull(),
    state: text('state', { enum: RENDER_STATES }).notNull().default('queued'),
    progress: real('progress').notNull().default(0),
    error: text('error'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    createdAt: createdAt(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [check('renders_state_check', oneOf(t.state, RENDER_STATES))],
);
