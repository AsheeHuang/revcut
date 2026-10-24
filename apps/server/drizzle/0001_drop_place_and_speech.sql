ALTER TABLE "media_analysis" DROP CONSTRAINT "media_analysis_speech_segment_id_speech_segments_id_fk";--> statement-breakpoint
ALTER TABLE "media_analysis" DROP COLUMN "speech_segment_id";--> statement-breakpoint
DROP TABLE "speech_segments";--> statement-breakpoint
ALTER TABLE "media" DROP COLUMN "place_label";--> statement-breakpoint
ALTER TABLE "media" DROP COLUMN "place_label_edited";--> statement-breakpoint
ALTER TABLE "media" DROP COLUMN "transcribed_at";
