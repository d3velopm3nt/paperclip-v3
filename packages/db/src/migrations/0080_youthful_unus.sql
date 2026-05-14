-- Enable pg_trgm for typo-tolerant fuzzy search
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- GIN indexes for fast trigram similarity on searchable fields
CREATE INDEX IF NOT EXISTS idx_companies_name_trgm ON "companies" USING GIN (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_clients_name_trgm ON "clients" USING GIN (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_projects_name_trgm ON "projects" USING GIN (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_issues_title_trgm ON "issues" USING GIN (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_topics_name_trgm ON "topics" USING GIN (name gin_trgm_ops);

ALTER TABLE "topics" ADD COLUMN "working_context" jsonb;