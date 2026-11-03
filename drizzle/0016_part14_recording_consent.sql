CREATE TYPE "public"."recording_status" AS ENUM('STARTING', 'RECORDING', 'COMPLETED', 'FAILED', 'DELETED');--> statement-breakpoint
CREATE TABLE "recording_consents" (
	"session_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"granted" boolean NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "recording_consents_session_id_user_id_pk" PRIMARY KEY("session_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "recordings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"egress_id" text,
	"status" "recording_status" DEFAULT 'STARTING' NOT NULL,
	"object_key" text NOT NULL,
	"size_bytes" bigint,
	"error" text,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"delete_after" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recording_consents" ADD CONSTRAINT "recording_consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "recordings_session_unique" ON "recordings" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recordings_egress_unique" ON "recordings" USING btree ("egress_id");--> statement-breakpoint
CREATE INDEX "recordings_retention_idx" ON "recordings" USING btree ("delete_after");