CREATE TYPE "public"."participant_status" AS ENUM('PENDING_PAYMENT', 'CONFIRMED', 'JOINED', 'ABSENT', 'ATTENDED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."session_status" AS ENUM('PENDING_PAYMENT', 'SCHEDULED', 'LIVE', 'NO_SHOW', 'ENDED', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "session_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"student_user_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"amount_paise" bigint NOT NULL,
	"status" "participant_status" DEFAULT 'PENDING_PAYMENT' NOT NULL,
	"payment_due_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "session_participants_amount_positive" CHECK ("session_participants"."amount_paise" > 0)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bid_id" uuid NOT NULL,
	"tutor_user_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"status" "session_status" DEFAULT 'PENDING_PAYMENT' NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"duration_minutes" integer NOT NULL,
	"seat_price_paise" bigint NOT NULL,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session_participants" ADD CONSTRAINT "session_participants_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_participants" ADD CONSTRAINT "session_participants_student_user_id_users_id_fk" FOREIGN KEY ("student_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_participants" ADD CONSTRAINT "session_participants_request_id_learning_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."learning_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_bid_id_bids_id_fk" FOREIGN KEY ("bid_id") REFERENCES "public"."bids"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_tutor_user_id_users_id_fk" FOREIGN KEY ("tutor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "session_participants_one_active_per_request" ON "session_participants" USING btree ("request_id") WHERE "session_participants"."status" in ('PENDING_PAYMENT', 'CONFIRMED', 'JOINED', 'ATTENDED');--> statement-breakpoint
CREATE INDEX "session_participants_session_idx" ON "session_participants" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "session_participants_student_idx" ON "session_participants" USING btree ("student_user_id","created_at");--> statement-breakpoint
CREATE INDEX "session_participants_payment_due_idx" ON "session_participants" USING btree ("payment_due_at") WHERE "session_participants"."status" = 'PENDING_PAYMENT';--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_bid_unique" ON "sessions" USING btree ("bid_id");--> statement-breakpoint
CREATE INDEX "sessions_tutor_idx" ON "sessions" USING btree ("tutor_user_id","starts_at");