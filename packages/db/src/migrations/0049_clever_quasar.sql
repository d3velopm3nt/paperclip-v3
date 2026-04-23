CREATE TABLE "action_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"action_type" text NOT NULL,
	"requires_approval" boolean DEFAULT true NOT NULL,
	"immediate_email" boolean DEFAULT false NOT NULL,
	"params_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "action_policies" ADD CONSTRAINT "action_policies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "action_policies_company_action_idx" ON "action_policies" USING btree ("company_id","action_type");