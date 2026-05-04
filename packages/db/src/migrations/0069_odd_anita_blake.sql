ALTER TABLE "clients" ADD COLUMN "local_path" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "drive_folder_id" text;--> statement-breakpoint
ALTER TABLE "document_sources" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "document_sources" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "local_path" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "drive_folder_id" text;--> statement-breakpoint
CREATE INDEX "document_sources_client_idx" ON "document_sources" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "document_sources_project_idx" ON "document_sources" USING btree ("project_id");