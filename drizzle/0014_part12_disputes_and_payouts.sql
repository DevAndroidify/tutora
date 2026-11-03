CREATE TYPE "public"."dispute_reason" AS ENUM('TUTOR_ABSENT_OR_LATE', 'POOR_QUALITY', 'NOT_AS_DESCRIBED', 'TECHNICAL_ISSUES', 'MISCONDUCT', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."dispute_status" AS ENUM('OPEN', 'RESOLVED_RELEASE', 'RESOLVED_REFUND');--> statement-breakpoint
CREATE TABLE "disputes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"student_user_id" uuid NOT NULL,
	"tutor_user_id" uuid NOT NULL,
	"reason" "dispute_reason" NOT NULL,
	"details" text DEFAULT '' NOT NULL,
	"status" "dispute_status" DEFAULT 'OPEN' NOT NULL,
	"resolution_note" text,
	"resolved_by" uuid,
	"opened_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tutor_user_id" uuid NOT NULL,
	"amount_paise" bigint NOT NULL,
	"method" text DEFAULT 'MANUAL_UPI' NOT NULL,
	"upi_id" text,
	"reference" text NOT NULL,
	"recorded_by" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "payouts_amount_positive" CHECK ("payouts"."amount_paise" > 0)
);
--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_student_user_id_users_id_fk" FOREIGN KEY ("student_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_tutor_user_id_users_id_fk" FOREIGN KEY ("tutor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_tutor_user_id_users_id_fk" FOREIGN KEY ("tutor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "disputes_participant_unique" ON "disputes" USING btree ("participant_id");--> statement-breakpoint
CREATE INDEX "disputes_status_idx" ON "disputes" USING btree ("status","opened_at");--> statement-breakpoint
CREATE INDEX "disputes_session_idx" ON "disputes" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "payouts_tutor_idx" ON "payouts" USING btree ("tutor_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payouts_reference_unique" ON "payouts" USING btree ("reference");