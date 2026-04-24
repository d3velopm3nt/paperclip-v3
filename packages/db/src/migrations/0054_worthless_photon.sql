CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email_domain" text,
	"extra_emails" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"trust_level" text DEFAULT 'standard' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "action_policies_company_action_idx";--> statement-breakpoint
ALTER TABLE "action_policies" ADD COLUMN "scope" text DEFAULT 'company' NOT NULL;--> statement-breakpoint
ALTER TABLE "action_policies" ADD COLUMN "scope_ref_id" uuid;--> statement-breakpoint
UPDATE "action_policies" SET "scope_ref_id" = "company_id" WHERE "scope_ref_id" IS NULL;--> statement-breakpoint
ALTER TABLE "action_policies" ALTER COLUMN "scope_ref_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN "matched_client_id" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "action_type" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clients_company_idx" ON "clients" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "clients_company_email_domain_idx" ON "clients" USING btree ("company_id","email_domain");--> statement-breakpoint
CREATE UNIQUE INDEX "action_policies_scope_action_idx" ON "action_policies" USING btree ("scope","scope_ref_id","action_type");--> statement-breakpoint
CREATE INDEX "action_policies_company_lookup_idx" ON "action_policies" USING btree ("company_id","action_type");