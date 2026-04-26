CREATE TABLE "rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"require_approval" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "room_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"agent_id" uuid,
	"is_operator" boolean DEFAULT false NOT NULL,
	"notify_on_message" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operator_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"room_id" uuid,
	"issue_id" uuid,
	"direction" text NOT NULL,
	"platform" text NOT NULL,
	"from_agent_id" uuid,
	"body" text NOT NULL,
	"raw_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_message_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"thread_key" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_members" ADD CONSTRAINT "room_members_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_members" ADD CONSTRAINT "room_members_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_messages" ADD CONSTRAINT "operator_messages_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_messages" ADD CONSTRAINT "operator_messages_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_messages" ADD CONSTRAINT "operator_messages_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_messages" ADD CONSTRAINT "operator_messages_from_agent_id_agents_id_fk" FOREIGN KEY ("from_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_threads" ADD CONSTRAINT "message_threads_operator_message_id_operator_messages_id_fk" FOREIGN KEY ("operator_message_id") REFERENCES "public"."operator_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rooms_company_idx" ON "rooms" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "rooms_company_slug_idx" ON "rooms" USING btree ("company_id","slug");--> statement-breakpoint
CREATE INDEX "room_members_room_idx" ON "room_members" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "room_members_agent_idx" ON "room_members" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "operator_messages_company_idx" ON "operator_messages" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "operator_messages_issue_idx" ON "operator_messages" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "operator_messages_room_idx" ON "operator_messages" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "message_threads_msg_idx" ON "message_threads" USING btree ("operator_message_id");--> statement-breakpoint
CREATE INDEX "message_threads_platform_key_idx" ON "message_threads" USING btree ("platform","thread_key");
