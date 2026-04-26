CREATE TABLE "workflow_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"workflow_type" text NOT NULL,
	"source_table" text NOT NULL,
	"source_id" uuid NOT NULL,
	"overall_status" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_stage_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"stage_id" text NOT NULL,
	"parent_stage_id" text,
	"branch" text,
	"label" text NOT NULL,
	"status" text NOT NULL,
	"expectations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"actuals" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_text" text,
	"ord" integer DEFAULT 0 NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_stage_results" ADD CONSTRAINT "workflow_stage_results_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workflow_runs_source_idx" ON "workflow_runs" USING btree ("workflow_type","source_id","started_at");--> statement-breakpoint
CREATE INDEX "workflow_runs_company_idx" ON "workflow_runs" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "workflow_stage_results_run_idx" ON "workflow_stage_results" USING btree ("run_id","ord");
