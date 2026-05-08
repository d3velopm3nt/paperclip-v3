CREATE TABLE "ecc_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"topic_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"recent_messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ecc_conversations" ADD CONSTRAINT "ecc_conversations_topic_id_ecc_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."ecc_topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ecc_conversations_topic_status_idx" ON "ecc_conversations" USING btree ("topic_id","status");--> statement-breakpoint
CREATE INDEX "ecc_conversations_expires_idx" ON "ecc_conversations" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "ecc_conversations_topic_last_msg_idx" ON "ecc_conversations" USING btree ("topic_id","last_message_at");