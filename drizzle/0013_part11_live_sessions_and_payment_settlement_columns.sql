CREATE TYPE "public"."refund_status" AS ENUM('PENDING', 'PROCESSED');--> statement-breakpoint
CREATE TABLE "session_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"session_id" uuid,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"identity" text,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"amount_paise" bigint NOT NULL,
	"reason" text NOT NULL,
	"provider_refund_id" text NOT NULL,
	"status" "refund_status" DEFAULT 'PROCESSED' NOT NULL,
	"initiated_by" uuid,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "refunds_amount_positive" CHECK ("refunds"."amount_paise" > 0)
);
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "released_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "frozen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "route_transfer_id" text;--> statement-breakpoint
ALTER TABLE "session_participants" ADD COLUMN "joined_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "live_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "ended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "tutor_joined_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "session_events_event_id_unique" ON "session_events" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "session_events_session_idx" ON "session_events" USING btree ("session_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_payment_unique" ON "refunds" USING btree ("payment_id");