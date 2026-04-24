ALTER TABLE "email_messages" ADD COLUMN "in_reply_to_header" text;--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN "references_headers" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX "email_messages_in_reply_to_idx" ON "email_messages" USING btree ("in_reply_to_header");
