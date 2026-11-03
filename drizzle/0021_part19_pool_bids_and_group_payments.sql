ALTER TABLE "bids" ADD COLUMN "min_seats" integer;--> statement-breakpoint
ALTER TABLE "bids" ADD COLUMN "max_seats" integer;--> statement-breakpoint
ALTER TABLE "request_pools" ADD COLUMN "accepted_bid_id" uuid;--> statement-breakpoint
ALTER TABLE "request_pools" ADD COLUMN "session_id" uuid;--> statement-breakpoint
ALTER TABLE "request_pools" ADD COLUMN "payment_deadline" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "pool_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "min_seats" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "max_seats" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX "bids_pool_idx" ON "bids" USING btree ("pool_id","status");--> statement-breakpoint
ALTER TABLE "bids" ADD CONSTRAINT "bids_pool_seats" CHECK (("bids"."pool_id" is null and "bids"."min_seats" is null and "bids"."max_seats" is null) or ("bids"."pool_id" is not null and "bids"."min_seats" >= 2 and "bids"."max_seats" >= "bids"."min_seats"));