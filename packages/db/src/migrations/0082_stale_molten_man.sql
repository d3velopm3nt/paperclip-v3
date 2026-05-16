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
CREATE UNIQUE INDEX "agent_templates_slug_idx" ON "agent_templates" USING btree ("slug");