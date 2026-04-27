CREATE TABLE "document_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"local_path" text,
	"drive_folder_id" text,
	"last_synced_at" timestamp with time zone,
	"last_sync_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reference_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"mime_type" text,
	"source_type" text DEFAULT 'upload' NOT NULL,
	"source_path" text,
	"drive_file_id" text,
	"drive_web_url" text,
	"extracted_text" text,
	"checksum" text,
	"scope" text DEFAULT 'company' NOT NULL,
	"project_id" uuid,
	"include_in_context" boolean DEFAULT true NOT NULL,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_sources" ADD CONSTRAINT "document_sources_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reference_documents" ADD CONSTRAINT "reference_documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reference_documents" ADD CONSTRAINT "reference_documents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_sources_company_idx" ON "document_sources" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "reference_documents_company_idx" ON "reference_documents" USING btree ("company_id","updated_at");--> statement-breakpoint
CREATE INDEX "reference_documents_project_idx" ON "reference_documents" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "reference_documents_drive_file_idx" ON "reference_documents" USING btree ("drive_file_id");--> statement-breakpoint
CREATE INDEX "reference_documents_source_path_idx" ON "reference_documents" USING btree ("source_path");