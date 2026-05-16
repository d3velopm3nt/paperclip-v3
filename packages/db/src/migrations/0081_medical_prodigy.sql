ALTER TABLE "document_sources" ADD COLUMN "github_repo_url" text;--> statement-breakpoint
ALTER TABLE "document_sources" ADD COLUMN "github_branch" text DEFAULT 'main';--> statement-breakpoint
ALTER TABLE "document_sources" ADD COLUMN "github_token" text;