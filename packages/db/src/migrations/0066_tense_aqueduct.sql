ALTER TABLE "chat_threads" ADD COLUMN "platform" text DEFAULT 'web' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD COLUMN "external_key" text;