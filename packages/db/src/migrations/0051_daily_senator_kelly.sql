CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issue_id" uuid,
	"agent_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"parent_plan_id" uuid,
	"source_email_message_id" uuid,
	"proposal_text" text NOT NULL,
	"proposal_meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"confidence" text DEFAULT 'medium' NOT NULL,
	"proposed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decision" text DEFAULT 'pending' NOT NULL,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"executed_at" timestamp with time zone,
	"execution_status" text DEFAULT 'pending' NOT NULL,
	"execution_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "plan_id" uuid;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_source_email_message_id_email_messages_id_fk" FOREIGN KEY ("source_email_message_id") REFERENCES "public"."email_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plans_company_idx" ON "plans" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "plans_agent_idx" ON "plans" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "plans_decision_idx" ON "plans" USING btree ("decision");--> statement-breakpoint
-- v3: FK from approvals.plan_id -> plans.id added manually because plans.ts and
-- approvals.ts cannot cross-reference without a circular import.
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE SET NULL ON UPDATE no action;