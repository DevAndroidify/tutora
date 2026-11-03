CREATE TYPE "public"."learning_request_status" AS ENUM('DRAFT', 'OPEN', 'POOLED', 'RESERVED', 'BOOKED', 'COMPLETED', 'EXPIRED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."skill_level" AS ENUM('BEGINNER', 'INTERMEDIATE', 'ADVANCED');--> statement-breakpoint
CREATE TABLE "learning_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_user_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"topic_id" uuid,
	"level" "skill_level" NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"preferred_language" text,
	"budget_hint_paise" bigint,
	"status" "learning_request_status" DEFAULT 'DRAFT' NOT NULL,
	"published_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "learning_requests_budget_range" CHECK ("learning_requests"."budget_hint_paise" is null or ("learning_requests"."budget_hint_paise" > 0 and "learning_requests"."budget_hint_paise" <= 9007199254740991)),
	CONSTRAINT "learning_requests_open_has_expiry" CHECK ("learning_requests"."status" <> 'OPEN' or ("learning_requests"."published_at" is not null and "learning_requests"."expires_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "request_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "learning_requests" ADD CONSTRAINT "learning_requests_student_user_id_users_id_fk" FOREIGN KEY ("student_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_requests" ADD CONSTRAINT "learning_requests_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_requests" ADD CONSTRAINT "learning_requests_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_attachments" ADD CONSTRAINT "request_attachments_request_id_learning_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."learning_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "learning_requests_student_idx" ON "learning_requests" USING btree ("student_user_id","created_at");--> statement-breakpoint
CREATE INDEX "learning_requests_browse_idx" ON "learning_requests" USING btree ("status","skill_id","published_at");--> statement-breakpoint
CREATE INDEX "learning_requests_expiry_idx" ON "learning_requests" USING btree ("expires_at") WHERE "learning_requests"."status" = 'OPEN';--> statement-breakpoint
CREATE UNIQUE INDEX "request_attachments_object_key_unique" ON "request_attachments" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "request_attachments_request_idx" ON "request_attachments" USING btree ("request_id");