CREATE TYPE "public"."session_mode" AS ENUM('FULL_VIDEO', 'AUDIO_ONLY', 'WHITEBOARD_ONLY');--> statement-breakpoint
CREATE TABLE "session_mode_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"mode" "session_mode" NOT NULL,
	"downlink_kbps" integer,
	"reason" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whiteboard_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"is_final" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session_mode_events" ADD CONSTRAINT "session_mode_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whiteboard_snapshots" ADD CONSTRAINT "whiteboard_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_mode_events_session_idx" ON "session_mode_events" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "whiteboard_snapshots_object_key_unique" ON "whiteboard_snapshots" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "whiteboard_snapshots_session_idx" ON "whiteboard_snapshots" USING btree ("session_id","created_at");