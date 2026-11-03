CREATE TYPE "public"."skill_suggestion_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."tutor_badge" AS ENUM('NONE', 'VERIFIED', 'EXPERT');--> statement-breakpoint
CREATE TYPE "public"."tutor_skill_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."tutor_verification_status" AS ENUM('NOT_SUBMITTED', 'PENDING', 'VERIFIED', 'REJECTED');--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_id" uuid,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"suggested_by" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" "skill_suggestion_status" DEFAULT 'PENDING' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"created_skill_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"learner_notice" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "topics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"skill_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tutor_profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"headline" text DEFAULT '' NOT NULL,
	"bio" text DEFAULT '' NOT NULL,
	"experience_years" integer,
	"languages" text[] DEFAULT '{}'::text[] NOT NULL,
	"badge" "tutor_badge" DEFAULT 'NONE' NOT NULL,
	"verification_status" "tutor_verification_status" DEFAULT 'NOT_SUBMITTED' NOT NULL,
	"payout_upi_id" text,
	"razorpay_linked_account_id" text,
	"verification_submitted_at" timestamp with time zone,
	"verification_decided_at" timestamp with time zone,
	"verification_decided_by" uuid,
	"verification_rejection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tutor_profiles_badge_needs_verification" CHECK ("tutor_profiles"."badge" = 'NONE' or "tutor_profiles"."verification_status" = 'VERIFIED'),
	CONSTRAINT "tutor_profiles_experience_years_range" CHECK ("tutor_profiles"."experience_years" is null or "tutor_profiles"."experience_years" between 0 and 60)
);
--> statement-breakpoint
CREATE TABLE "tutor_skills" (
	"tutor_user_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"status" "tutor_skill_status" DEFAULT 'PENDING' NOT NULL,
	"experience_years" integer,
	"summary" text DEFAULT '' NOT NULL,
	"evidence_links" text[] DEFAULT '{}'::text[] NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"rejection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tutor_skills_tutor_user_id_skill_id_pk" PRIMARY KEY("tutor_user_id","skill_id"),
	CONSTRAINT "tutor_skills_experience_years_range" CHECK ("tutor_skills"."experience_years" is null or "tutor_skills"."experience_years" between 0 and 60)
);
--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_suggestions" ADD CONSTRAINT "skill_suggestions_suggested_by_users_id_fk" FOREIGN KEY ("suggested_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_suggestions" ADD CONSTRAINT "skill_suggestions_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_suggestions" ADD CONSTRAINT "skill_suggestions_created_skill_id_skills_id_fk" FOREIGN KEY ("created_skill_id") REFERENCES "public"."skills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tutor_profiles" ADD CONSTRAINT "tutor_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tutor_skills" ADD CONSTRAINT "tutor_skills_tutor_user_id_tutor_profiles_user_id_fk" FOREIGN KEY ("tutor_user_id") REFERENCES "public"."tutor_profiles"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tutor_skills" ADD CONSTRAINT "tutor_skills_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "categories_slug_unique" ON "categories" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "categories_parent_id_idx" ON "categories" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "skill_suggestions_status_idx" ON "skill_suggestions" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "skill_suggestions_suggested_by_idx" ON "skill_suggestions" USING btree ("suggested_by");--> statement-breakpoint
CREATE UNIQUE INDEX "skills_slug_unique" ON "skills" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "skills_category_id_idx" ON "skills" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "skills_name_trgm_idx" ON "skills" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "topics_skill_slug_unique" ON "topics" USING btree ("skill_id","slug");--> statement-breakpoint
CREATE INDEX "topics_skill_id_idx" ON "topics" USING btree ("skill_id");--> statement-breakpoint
CREATE INDEX "tutor_profiles_verification_status_idx" ON "tutor_profiles" USING btree ("verification_status");--> statement-breakpoint
CREATE INDEX "tutor_skills_skill_status_idx" ON "tutor_skills" USING btree ("skill_id","status");--> statement-breakpoint
CREATE INDEX "tutor_skills_status_idx" ON "tutor_skills" USING btree ("status","created_at");