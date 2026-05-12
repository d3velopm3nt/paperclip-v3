-- Create memory_items table (new)
CREATE TABLE "memory_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"source_channel" text NOT NULL,
	"source_id" text,
	"source_email_message_id" uuid,
	"sender_identifier" text,
	"content" text NOT NULL,
	"summary" text,
	"intent_category" text,
	"importance_score" integer,
	"memory_type" text DEFAULT 'passive' NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"raw_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_source_email_message_id_email_messages_id_fk" FOREIGN KEY ("source_email_message_id") REFERENCES "public"."email_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_items_company_idx" ON "memory_items" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "memory_items_channel_idx" ON "memory_items" USING btree ("source_channel");--> statement-breakpoint
CREATE INDEX "memory_items_sender_idx" ON "memory_items" USING btree ("sender_identifier");--> statement-breakpoint
CREATE INDEX "memory_items_type_idx" ON "memory_items" USING btree ("memory_type");--> statement-breakpoint
-- Update ecc_conversations FK to point to renamed topics table
ALTER TABLE "ecc_conversations" DROP CONSTRAINT IF EXISTS "ecc_conversations_topic_id_ecc_topics_id_fk";--> statement-breakpoint
ALTER TABLE "ecc_conversations" ADD CONSTRAINT "ecc_conversations_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- topic_issues and topics tables were already renamed in 0076 via ALTER TABLE RENAME
-- Add missing FK constraints on topic_issues that weren't created at rename time
ALTER TABLE "topic_issues" DROP CONSTRAINT IF EXISTS "ecc_topic_issues_topic_id_ecc_topics_id_fk";--> statement-breakpoint
ALTER TABLE "topic_issues" DROP CONSTRAINT IF EXISTS "ecc_topic_issues_issue_id_issues_id_fk";--> statement-breakpoint
ALTER TABLE "topic_issues" ADD CONSTRAINT "topic_issues_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_issues" ADD CONSTRAINT "topic_issues_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
