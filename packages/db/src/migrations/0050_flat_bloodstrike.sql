ALTER TABLE "companies" ADD COLUMN "triage_agent_id" uuid;

--> v3: FK added manually to avoid circular import in schema files
ALTER TABLE "companies"
  ADD CONSTRAINT "companies_triage_agent_id_agents_id_fk"
  FOREIGN KEY ("triage_agent_id") REFERENCES "agents"("id") ON DELETE SET NULL;