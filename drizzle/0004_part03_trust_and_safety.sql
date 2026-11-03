CREATE TYPE "public"."moderation_case_status" AS ENUM('OPEN', 'ACTIONED', 'DISMISSED');--> statement-breakpoint
CREATE TYPE "public"."moderated_entity" AS ENUM('USER', 'TUTOR_PROFILE', 'TUTOR_SKILL', 'LEARNING_REQUEST', 'BID', 'SESSION');--> statement-breakpoint
CREATE TYPE "public"."moderation_action_type" AS ENUM('DISMISS', 'WARN', 'RESTRICT_POSTING', 'RESTRICT_BIDDING', 'SUSPEND', 'BAN');--> statement-breakpoint
CREATE TYPE "public"."report_reason" AS ENUM('HARASSMENT', 'OFF_PLATFORM_PAYMENT', 'NO_SHOW', 'MISLEADING_CLAIMS', 'INAPPROPRIATE_CONTENT', 'FINANCIAL_TIPS', 'SPAM', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."sanction_type" AS ENUM('WARN', 'RESTRICT_POSTING', 'RESTRICT_BIDDING', 'SUSPEND', 'BAN');--> statement-breakpoint
CREATE TYPE "public"."screening_action" AS ENUM('MASK', 'FLAG', 'BLOCK');--> statement-breakpoint
CREATE TYPE "public"."screening_rule" AS ENUM('CONTACT_PHONE', 'CONTACT_EMAIL', 'CONTACT_UPI', 'CONTACT_SOCIAL', 'OFF_PLATFORM_PAYMENT', 'ABUSIVE_LANGUAGE', 'FINANCIAL_TIP');--> statement-breakpoint
CREATE TYPE "public"."moderation_severity" AS ENUM('LOW', 'MEDIUM', 'HIGH');--> statement-breakpoint
CREATE TABLE "content_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"entity_type" "moderated_entity" NOT NULL,
	"entity_id" text,
	"field" text NOT NULL,
	"rule" "screening_rule" NOT NULL,
	"severity" "moderation_severity" NOT NULL,
	"action" "screening_action" NOT NULL,
	"excerpt" text NOT NULL,
	"case_id" uuid,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "moderation_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"action" "moderation_action_type" NOT NULL,
	"reason" text NOT NULL,
	"duration_days" integer,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "moderation_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_user_id" uuid NOT NULL,
	"status" "moderation_case_status" DEFAULT 'OPEN' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"assigned_to" uuid,
	"resolution" text,
	"opened_at" timestamp with time zone NOT NULL,
	"last_activity_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reporter_user_id" uuid NOT NULL,
	"subject_user_id" uuid NOT NULL,
	"reason" "report_reason" NOT NULL,
	"entity_type" "moderated_entity",
	"entity_id" text,
	"details" text DEFAULT '' NOT NULL,
	"reported_from_app" "client_app" NOT NULL,
	"case_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_sanctions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "sanction_type" NOT NULL,
	"case_id" uuid,
	"reason" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"lifted_at" timestamp with time zone,
	"lifted_by" uuid,
	"lift_reason" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "content_flags" ADD CONSTRAINT "content_flags_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_flags" ADD CONSTRAINT "content_flags_case_id_moderation_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."moderation_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_case_id_moderation_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."moderation_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_cases" ADD CONSTRAINT "moderation_cases_subject_user_id_users_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_user_id_users_id_fk" FOREIGN KEY ("reporter_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_subject_user_id_users_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_case_id_moderation_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."moderation_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sanctions" ADD CONSTRAINT "user_sanctions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sanctions" ADD CONSTRAINT "user_sanctions_case_id_moderation_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."moderation_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "content_flags_user_idx" ON "content_flags" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "content_flags_case_idx" ON "content_flags" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "moderation_actions_case_idx" ON "moderation_actions" USING btree ("case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "moderation_cases_one_open_per_user" ON "moderation_cases" USING btree ("subject_user_id") WHERE "moderation_cases"."status" = 'OPEN';--> statement-breakpoint
CREATE INDEX "moderation_cases_queue_idx" ON "moderation_cases" USING btree ("status","priority","last_activity_at");--> statement-breakpoint
CREATE INDEX "reports_case_idx" ON "reports" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "reports_reporter_idx" ON "reports" USING btree ("reporter_user_id","created_at");--> statement-breakpoint
CREATE INDEX "user_sanctions_active_idx" ON "user_sanctions" USING btree ("user_id","type") WHERE "user_sanctions"."lifted_at" is null;--> statement-breakpoint
CREATE INDEX "user_sanctions_expiry_idx" ON "user_sanctions" USING btree ("ends_at") WHERE "user_sanctions"."lifted_at" is null and "user_sanctions"."ends_at" is not null;