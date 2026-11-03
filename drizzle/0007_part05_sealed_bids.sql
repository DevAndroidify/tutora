CREATE TYPE "public"."bid_status" AS ENUM('SUBMITTED', 'ACCEPTED', 'HELD', 'WITHDRAWN', 'EXPIRED', 'REJECTED');--> statement-breakpoint
CREATE TABLE "bids" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid,
	"pool_id" uuid,
	"tutor_user_id" uuid NOT NULL,
	"seat_price_paise" bigint NOT NULL,
	"proposed_start_at" timestamp with time zone NOT NULL,
	"duration_minutes" integer NOT NULL,
	"approach_text" text,
	"approach_media_key" text,
	"status" "bid_status" DEFAULT 'SUBMITTED' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "bids_one_target" CHECK (("bids"."request_id" is null) <> ("bids"."pool_id" is null)),
	CONSTRAINT "bids_price_range" CHECK ("bids"."seat_price_paise" > 0 and "bids"."seat_price_paise" <= 9007199254740991),
	CONSTRAINT "bids_duration_range" CHECK ("bids"."duration_minutes" between 15 and 240),
	CONSTRAINT "bids_has_approach" CHECK (coalesce(length("bids"."approach_text"), 0) > 0 or "bids"."approach_media_key" is not null)
);
--> statement-breakpoint
ALTER TABLE "bids" ADD CONSTRAINT "bids_request_id_learning_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."learning_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bids" ADD CONSTRAINT "bids_tutor_user_id_users_id_fk" FOREIGN KEY ("tutor_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bids_one_active_per_tutor_request" ON "bids" USING btree ("tutor_user_id","request_id") WHERE "bids"."request_id" is not null and "bids"."status" in ('SUBMITTED', 'HELD', 'ACCEPTED');--> statement-breakpoint
CREATE UNIQUE INDEX "bids_one_active_per_tutor_pool" ON "bids" USING btree ("tutor_user_id","pool_id") WHERE "bids"."pool_id" is not null and "bids"."status" in ('SUBMITTED', 'HELD', 'ACCEPTED');--> statement-breakpoint
CREATE INDEX "bids_request_idx" ON "bids" USING btree ("request_id","status");--> statement-breakpoint
CREATE INDEX "bids_tutor_idx" ON "bids" USING btree ("tutor_user_id","created_at");