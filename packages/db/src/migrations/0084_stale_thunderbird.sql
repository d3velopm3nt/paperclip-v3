CREATE TABLE "agent_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"issue_id" uuid,
	"plan_id" uuid,
	"message_id" uuid,
	"scored_by_user_id" text NOT NULL,
	"score" integer NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trust_levels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"action_type" text NOT NULL,
	"level" integer DEFAULT 0 NOT NULL,
	"approved_count" integer DEFAULT 0 NOT NULL,
	"rejected_count" integer DEFAULT 0 NOT NULL,
	"low_score_count" integer DEFAULT 0 NOT NULL,
	"last_decision_at" timestamp with time zone,
	"auto_approve_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_scores" ADD CONSTRAINT "agent_scores_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_scores" ADD CONSTRAINT "agent_scores_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_scores" ADD CONSTRAINT "agent_scores_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_scores" ADD CONSTRAINT "agent_scores_message_id_operator_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."operator_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_scores" ADD CONSTRAINT "agent_scores_scored_by_user_id_user_id_fk" FOREIGN KEY ("scored_by_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trust_levels" ADD CONSTRAINT "trust_levels_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_scores_agent_idx" ON "agent_scores" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_scores_scored_by_idx" ON "agent_scores" USING btree ("scored_by_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "trust_levels_agent_action_uniq" ON "trust_levels" USING btree ("agent_id","action_type");
