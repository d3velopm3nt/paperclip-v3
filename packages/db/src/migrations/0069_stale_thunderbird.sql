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
CREATE TABLE "agent_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"category" text DEFAULT 'custom' NOT NULL,
	"source_type" text DEFAULT 'custom' NOT NULL,
	"agent_definitions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"team_structure" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blocked_sender_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ea_conversations" (
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
CREATE TABLE "topic_issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"topic_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "topic_issues_unique" UNIQUE("topic_id","issue_id")
);
--> statement-breakpoint
CREATE TABLE "topics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"current_state" text,
	"company_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"working_context" jsonb
);
--> statement-breakpoint
ALTER TABLE "agent_scores" ADD CONSTRAINT "agent_scores_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_scores" ADD CONSTRAINT "agent_scores_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_scores" ADD CONSTRAINT "agent_scores_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_scores" ADD CONSTRAINT "agent_scores_message_id_operator_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."operator_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_scores" ADD CONSTRAINT "agent_scores_scored_by_user_id_user_id_fk" FOREIGN KEY ("scored_by_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocked_sender_domains" ADD CONSTRAINT "blocked_sender_domains_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ea_conversations" ADD CONSTRAINT "ea_conversations_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trust_levels" ADD CONSTRAINT "trust_levels_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_source_email_message_id_email_messages_id_fk" FOREIGN KEY ("source_email_message_id") REFERENCES "public"."email_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_issues" ADD CONSTRAINT "topic_issues_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_issues" ADD CONSTRAINT "topic_issues_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_scores_agent_idx" ON "agent_scores" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_scores_scored_by_idx" ON "agent_scores" USING btree ("scored_by_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_templates_slug_idx" ON "agent_templates" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "blocked_sender_domains_company_idx" ON "blocked_sender_domains" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "blocked_sender_domains_company_domain_idx" ON "blocked_sender_domains" USING btree ("company_id","domain");--> statement-breakpoint
CREATE INDEX "ea_conversations_topic_status_idx" ON "ea_conversations" USING btree ("topic_id","status");--> statement-breakpoint
CREATE INDEX "ea_conversations_expires_idx" ON "ea_conversations" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "ea_conversations_topic_last_msg_idx" ON "ea_conversations" USING btree ("topic_id","last_message_at");--> statement-breakpoint
CREATE UNIQUE INDEX "trust_levels_agent_action_uniq" ON "trust_levels" USING btree ("agent_id","action_type");--> statement-breakpoint
CREATE INDEX "memory_items_company_idx" ON "memory_items" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "memory_items_channel_idx" ON "memory_items" USING btree ("source_channel");--> statement-breakpoint
CREATE INDEX "memory_items_sender_idx" ON "memory_items" USING btree ("sender_identifier");--> statement-breakpoint
CREATE INDEX "memory_items_type_idx" ON "memory_items" USING btree ("memory_type");--> statement-breakpoint
CREATE INDEX "topics_status_idx" ON "topics" USING btree ("status");--> statement-breakpoint
CREATE INDEX "topics_company_idx" ON "topics" USING btree ("company_id");