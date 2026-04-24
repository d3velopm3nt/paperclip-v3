ALTER TABLE "email_accounts" ADD COLUMN "auto_acknowledge" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "email_accounts" ADD COLUMN "ack_subject" text;--> statement-breakpoint
ALTER TABLE "email_accounts" ADD COLUMN "ack_body" text;
