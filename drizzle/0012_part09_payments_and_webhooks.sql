CREATE TYPE "public"."payment_status" AS ENUM('INITIATED', 'VERIFIED', 'HELD', 'RELEASED', 'REFUNDED', 'FROZEN', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."upi_provider" AS ENUM('fake', 'razorpay');--> statement-breakpoint
CREATE TYPE "public"."webhook_event_status" AS ENUM('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED');--> statement-breakpoint
CREATE TABLE "payment_webhook_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"provider" "upi_provider" NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"signature_valid" boolean NOT NULL,
	"status" "webhook_event_status" DEFAULT 'RECEIVED' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"received_at" timestamp with time zone NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"participant_id" uuid NOT NULL,
	"student_user_id" uuid NOT NULL,
	"provider" "upi_provider" NOT NULL,
	"provider_order_id" text NOT NULL,
	"provider_payment_id" text,
	"amount_paise" bigint NOT NULL,
	"paid_amount_paise" bigint,
	"currency" text DEFAULT 'INR' NOT NULL,
	"status" "payment_status" DEFAULT 'INITIATED' NOT NULL,
	"failure_reason" text,
	"refund_reason" text,
	"provider_refund_id" text,
	"verified_at" timestamp with time zone,
	"held_at" timestamp with time zone,
	"refunded_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "payments_inr" CHECK ("payments"."currency" = 'INR'),
	CONSTRAINT "payments_amount_positive" CHECK ("payments"."amount_paise" > 0)
);
--> statement-breakpoint
CREATE TABLE "fake_upi_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"amount_paise" bigint NOT NULL,
	"currency" text NOT NULL,
	"receipt" text NOT NULL,
	"payment_id" text,
	"paid_amount_paise" bigint,
	"payment_status" text,
	"refund_id" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_participant_id_session_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."session_participants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_student_user_id_users_id_fk" FOREIGN KEY ("student_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_webhook_events_dedupe" ON "payment_webhook_events" USING btree ("provider","event_id");--> statement-breakpoint
CREATE INDEX "payment_webhook_events_pending_idx" ON "payment_webhook_events" USING btree ("received_at") WHERE "payment_webhook_events"."status" = 'RECEIVED';--> statement-breakpoint
CREATE UNIQUE INDEX "payments_provider_order_unique" ON "payments" USING btree ("provider","provider_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_provider_payment_unique" ON "payments" USING btree ("provider","provider_payment_id") WHERE "payments"."provider_payment_id" is not null;--> statement-breakpoint
CREATE INDEX "payments_participant_idx" ON "payments" USING btree ("participant_id");--> statement-breakpoint
CREATE INDEX "payments_initiated_idx" ON "payments" USING btree ("created_at") WHERE "payments"."status" = 'INITIATED';