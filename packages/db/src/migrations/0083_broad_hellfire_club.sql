CREATE TABLE "email_label_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT '#6b7280' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "email_label_definitions" ADD CONSTRAINT "email_label_definitions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_label_definitions_company_idx" ON "email_label_definitions" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "email_label_definitions_company_name_idx" ON "email_label_definitions" USING btree ("company_id","name");