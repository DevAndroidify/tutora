CREATE TYPE "public"."transcript_status" AS ENUM('PENDING', 'PROCESSING', 'READY', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."replay_asset_kind" AS ENUM('NOTES', 'FLASHCARDS');--> statement-breakpoint
CREATE TYPE "public"."replay_asset_source" AS ENUM('GENERATED', 'TUTOR');--> statement-breakpoint
CREATE TYPE "public"."replay_asset_status" AS ENUM('PENDING', 'READY', 'FAILED');--> statement-breakpoint
CREATE TABLE "replay_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"kind" "replay_asset_kind" NOT NULL,
	"source" "replay_asset_source" NOT NULL,
	"status" "replay_asset_status" DEFAULT 'PENDING' NOT NULL,
	"provider" text,
	"model" text,
	"content" jsonb,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transcript_segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recording_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"start_ms" integer NOT NULL,
	"end_ms" integer NOT NULL,
	"speaker" text,
	"text" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recordings" ADD COLUMN "transcript_status" "transcript_status" DEFAULT 'PENDING' NOT NULL;--> statement-breakpoint
ALTER TABLE "recordings" ADD COLUMN "transcript_error" text;--> statement-breakpoint
CREATE UNIQUE INDEX "replay_assets_session_kind_source_unique" ON "replay_assets" USING btree ("session_id","kind","source");--> statement-breakpoint
CREATE UNIQUE INDEX "transcript_segments_recording_seq_unique" ON "transcript_segments" USING btree ("recording_id","seq");--> statement-breakpoint
CREATE INDEX "transcript_segments_session_idx" ON "transcript_segments" USING btree ("session_id","start_ms");