CREATE TABLE "blocked_sender_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "operator_messages" ADD COLUMN "discarded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "blocked_sender_domains" ADD CONSTRAINT "blocked_sender_domains_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blocked_sender_domains_company_idx" ON "blocked_sender_domains" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "blocked_sender_domains_company_domain_idx" ON "blocked_sender_domains" USING btree ("company_id","domain");