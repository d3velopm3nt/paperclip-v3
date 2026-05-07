CREATE TABLE "ecc_topic_issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"topic_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ecc_topic_issues_unique" UNIQUE("topic_id","issue_id")
);
--> statement-breakpoint
CREATE TABLE "ecc_topics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"current_state" text,
	"company_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ecc_topic_issues" ADD CONSTRAINT "ecc_topic_issues_topic_id_ecc_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."ecc_topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ecc_topic_issues" ADD CONSTRAINT "ecc_topic_issues_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ecc_topics" ADD CONSTRAINT "ecc_topics_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ecc_topics_status_idx" ON "ecc_topics" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ecc_topics_company_idx" ON "ecc_topics" USING btree ("company_id");