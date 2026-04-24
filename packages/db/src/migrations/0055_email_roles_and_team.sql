ALTER TABLE "email_accounts" ADD COLUMN "role" text DEFAULT 'inbound' NOT NULL;--> statement-breakpoint
ALTER TABLE "email_accounts" ADD COLUMN "team_emails" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "email_accounts" ADD COLUMN "triage_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "email_accounts" ADD CONSTRAINT "email_accounts_triage_agent_id_agents_id_fk" FOREIGN KEY ("triage_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Backfill: any existing account with fromEmail starting 'ai@' is agent_voice.
UPDATE "email_accounts" SET "role" = 'agent_voice' WHERE lower("from_email") LIKE 'ai@%';
