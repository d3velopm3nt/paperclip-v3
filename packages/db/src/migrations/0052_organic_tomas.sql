ALTER TABLE "email_accounts" ADD COLUMN "smtp_host" text;--> statement-breakpoint
ALTER TABLE "email_accounts" ADD COLUMN "smtp_port" integer;--> statement-breakpoint
ALTER TABLE "email_accounts" ADD COLUMN "smtp_user" text;--> statement-breakpoint
ALTER TABLE "email_accounts" ADD COLUMN "smtp_password_enc" text;--> statement-breakpoint
ALTER TABLE "email_accounts" ADD COLUMN "smtp_secure" boolean DEFAULT false NOT NULL;