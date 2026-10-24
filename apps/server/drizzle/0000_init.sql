CREATE TABLE "analysis_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"media_ids" uuid[] NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"effort" text NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd" numeric(8, 4),
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analysis_runs_provider_check" CHECK ("analysis_runs"."provider" in ('anthropic', 'openai')),
	CONSTRAINT "analysis_runs_status_check" CHECK ("analysis_runs"."status" in ('running', 'done', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'uploaded' NOT NULL,
	"error" text,
	"filename" text NOT NULL,
	"ext" text NOT NULL,
	"mime_type" text,
	"size_bytes" bigint NOT NULL,
	"file_last_modified" timestamp with time zone,
	"sha256" text NOT NULL,
	"width" integer,
	"height" integer,
	"duration_sec" real,
	"fps" real,
	"is_hdr" boolean,
	"has_audio" boolean,
	"captured_at" timestamp with time zone,
	"utc_offset_min" smallint,
	"lat" double precision,
	"lng" double precision,
	"place_label" text,
	"place_label_edited" boolean DEFAULT false NOT NULL,
	"excluded" boolean DEFAULT false NOT NULL,
	"content_identifier" text,
	"transcribed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_project_id_sha256_key" UNIQUE("project_id","sha256"),
	CONSTRAINT "media_kind_check" CHECK ("media"."kind" in ('video', 'photo')),
	CONSTRAINT "media_status_check" CHECK ("media"."status" in ('uploaded', 'processing', 'ready', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "media_analysis" (
	"analysis_run_id" uuid NOT NULL,
	"media_id" uuid NOT NULL,
	"usable" boolean NOT NULL,
	"score" smallint NOT NULL,
	"description" text NOT NULL,
	"moments" jsonb NOT NULL,
	"speech_segment_id" uuid,
	"duplicate_of" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_analysis_analysis_run_id_media_id_pk" PRIMARY KEY("analysis_run_id","media_id")
);
--> statement-breakpoint
CREATE TABLE "music_tracks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"artist" text,
	"status" text DEFAULT 'uploaded' NOT NULL,
	"error" text,
	"filename" text NOT NULL,
	"ext" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"duration_sec" real,
	"bpm" real,
	"beats" double precision[],
	"downbeat_indices" integer[],
	"energy" real[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "music_tracks_status_check" CHECK ("music_tracks"."status" in ('uploaded', 'analyzing', 'ready', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"current_timeline_id" uuid,
	"draft_state" text DEFAULT 'idle' NOT NULL,
	"draft_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_draft_state_check" CHECK ("projects"."draft_state" in ('idle', 'queued', 'transcribing', 'analyzing', 'planning', 'done', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "renders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"timeline_id" uuid,
	"snapshot" jsonb NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"progress" real DEFAULT 0 NOT NULL,
	"error" text,
	"size_bytes" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "renders_state_check" CHECK ("renders"."state" in ('queued', 'preparing', 'rendering', 'done', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "speech_segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"media_id" uuid NOT NULL,
	"idx" smallint NOT NULL,
	"start_sec" real NOT NULL,
	"end_sec" real NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "timelines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"analysis_run_id" uuid,
	"seed" integer NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_analysis" ADD CONSTRAINT "media_analysis_analysis_run_id_analysis_runs_id_fk" FOREIGN KEY ("analysis_run_id") REFERENCES "public"."analysis_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_analysis" ADD CONSTRAINT "media_analysis_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_analysis" ADD CONSTRAINT "media_analysis_speech_segment_id_speech_segments_id_fk" FOREIGN KEY ("speech_segment_id") REFERENCES "public"."speech_segments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_analysis" ADD CONSTRAINT "media_analysis_duplicate_of_media_id_fk" FOREIGN KEY ("duplicate_of") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_current_timeline_id_timelines_id_fk" FOREIGN KEY ("current_timeline_id") REFERENCES "public"."timelines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "renders" ADD CONSTRAINT "renders_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "renders" ADD CONSTRAINT "renders_timeline_id_timelines_id_fk" FOREIGN KEY ("timeline_id") REFERENCES "public"."timelines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "speech_segments" ADD CONSTRAINT "speech_segments_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timelines" ADD CONSTRAINT "timelines_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timelines" ADD CONSTRAINT "timelines_analysis_run_id_analysis_runs_id_fk" FOREIGN KEY ("analysis_run_id") REFERENCES "public"."analysis_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "media_project_id_captured_at_idx" ON "media" USING btree ("project_id","captured_at");--> statement-breakpoint
CREATE INDEX "media_project_id_content_identifier_idx" ON "media" USING btree ("project_id","content_identifier");