CREATE TYPE "public"."quiz_attempt_status" AS ENUM('OPEN', 'SUBMITTED');--> statement-breakpoint
CREATE TYPE "public"."quiz_kind" AS ENUM('EXIT', 'RECHECK');--> statement-breakpoint
CREATE TYPE "public"."quiz_mode" AS ENUM('QUIZ', 'SELF_CHECK');--> statement-breakpoint
CREATE TABLE "question_bank" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"skill_id" uuid NOT NULL,
	"topic_id" uuid,
	"prompt" text NOT NULL,
	"options" text[] NOT NULL,
	"correct_index" smallint NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_bank_correct_index_range" CHECK ("question_bank"."correct_index" >= 0 and "question_bank"."correct_index" < cardinality("question_bank"."options") and cardinality("question_bank"."options") between 2 and 6)
);
--> statement-breakpoint
CREATE TABLE "quiz_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"student_user_id" uuid NOT NULL,
	"tutor_user_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"kind" "quiz_kind" NOT NULL,
	"mode" "quiz_mode" NOT NULL,
	"status" "quiz_attempt_status" DEFAULT 'OPEN' NOT NULL,
	"question_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"answers" integer[],
	"correct_count" integer,
	"total_count" integer,
	"passed" boolean,
	"available_at" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"student_user_id" uuid NOT NULL,
	"tutor_user_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"rating" smallint NOT NULL,
	"comment" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "reviews_rating_range" CHECK ("reviews"."rating" between 1 and 5)
);
--> statement-breakpoint
CREATE TABLE "tutor_mastery_stats" (
	"tutor_user_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"weighted_attempts" integer DEFAULT 0 NOT NULL,
	"weighted_passes" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "tutor_mastery_stats_tutor_user_id_skill_id_pk" PRIMARY KEY("tutor_user_id","skill_id")
);
--> statement-breakpoint
ALTER TABLE "question_bank" ADD CONSTRAINT "question_bank_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_bank" ADD CONSTRAINT "question_bank_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_student_user_id_users_id_fk" FOREIGN KEY ("student_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_tutor_user_id_users_id_fk" FOREIGN KEY ("tutor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_student_user_id_users_id_fk" FOREIGN KEY ("student_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_tutor_user_id_users_id_fk" FOREIGN KEY ("tutor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tutor_mastery_stats" ADD CONSTRAINT "tutor_mastery_stats_tutor_user_id_users_id_fk" FOREIGN KEY ("tutor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tutor_mastery_stats" ADD CONSTRAINT "tutor_mastery_stats_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "question_bank_skill_prompt_unique" ON "question_bank" USING btree ("skill_id","prompt");--> statement-breakpoint
CREATE UNIQUE INDEX "quiz_attempts_participant_kind_unique" ON "quiz_attempts" USING btree ("participant_id","kind");--> statement-breakpoint
CREATE INDEX "quiz_attempts_student_idx" ON "quiz_attempts" USING btree ("student_user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "reviews_participant_unique" ON "reviews" USING btree ("participant_id");--> statement-breakpoint
CREATE INDEX "reviews_tutor_idx" ON "reviews" USING btree ("tutor_user_id");