CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_companies_name_trgm ON "companies" USING GIN (name gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_clients_name_trgm ON "clients" USING GIN (name gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_projects_name_trgm ON "projects" USING GIN (name gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_issues_title_trgm ON "issues" USING GIN (title gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_topics_name_trgm ON "topics" USING GIN (name gin_trgm_ops);
--> statement-breakpoint
ALTER TABLE "topics" ADD COLUMN IF NOT EXISTS "working_context" jsonb;