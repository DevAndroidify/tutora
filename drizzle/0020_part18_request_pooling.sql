CREATE TYPE "public"."pool_invite_status" AS ENUM('INVITED', 'ACCEPTED', 'DECLINED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."pool_status" AS ENUM('FORMING', 'BIDDING', 'AWAITING_PAYMENTS', 'CONFIRMED', 'EXPIRED', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "pool_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pool_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"student_user_id" uuid NOT NULL,
	"status" "pool_invite_status" DEFAULT 'INVITED' NOT NULL,
	"similarity" real,
	"matched_by" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"responded_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "request_embeddings" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"student_user_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"level" "skill_level" NOT NULL,
	"topic_id" uuid,
	"model" text,
	"embedding" vector(1024),
	"error" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "request_pools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"skill_id" uuid NOT NULL,
	"level" "skill_level" NOT NULL,
	"status" "pool_status" DEFAULT 'FORMING' NOT NULL,
	"seat_cap" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pool_invites" ADD CONSTRAINT "pool_invites_pool_id_request_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."request_pools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pool_invites" ADD CONSTRAINT "pool_invites_student_user_id_users_id_fk" FOREIGN KEY ("student_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_embeddings" ADD CONSTRAINT "request_embeddings_student_user_id_users_id_fk" FOREIGN KEY ("student_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_embeddings" ADD CONSTRAINT "request_embeddings_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_pools" ADD CONSTRAINT "request_pools_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pool_invites_pool_request_unique" ON "pool_invites" USING btree ("pool_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pool_invites_one_active_per_request" ON "pool_invites" USING btree ("request_id") WHERE "pool_invites"."status" in ('INVITED', 'ACCEPTED');--> statement-breakpoint
CREATE INDEX "pool_invites_student_idx" ON "pool_invites" USING btree ("student_user_id","status");--> statement-breakpoint
CREATE INDEX "request_embeddings_hnsw_cosine" ON "request_embeddings" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "request_embeddings_match_idx" ON "request_embeddings" USING btree ("skill_id","level");--> statement-breakpoint
CREATE INDEX "request_pools_status_idx" ON "request_pools" USING btree ("status","skill_id","level");