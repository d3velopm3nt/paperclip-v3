-- Rename ecc_conversations → ea_conversations (preserves all data)
ALTER TABLE "ecc_conversations" RENAME TO "ea_conversations";
--> statement-breakpoint
ALTER TABLE "ea_conversations" RENAME CONSTRAINT "ecc_conversations_topic_id_topics_id_fk" TO "ea_conversations_topic_id_topics_id_fk";
--> statement-breakpoint
ALTER INDEX "ecc_conversations_topic_status_idx" RENAME TO "ea_conversations_topic_status_idx";
--> statement-breakpoint
ALTER INDEX "ecc_conversations_expires_idx" RENAME TO "ea_conversations_expires_idx";
--> statement-breakpoint
ALTER INDEX "ecc_conversations_topic_last_msg_idx" RENAME TO "ea_conversations_topic_last_msg_idx";
