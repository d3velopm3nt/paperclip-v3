ALTER TABLE "plans" ADD COLUMN "definition_of_done" jsonb DEFAULT '[]'::jsonb NOT NULL;
