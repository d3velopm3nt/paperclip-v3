ALTER TABLE "email_attachments" ADD COLUMN "filed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_attachments" ADD COLUMN "filed_path" text;