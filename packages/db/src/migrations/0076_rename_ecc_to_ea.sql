-- Rename ECC tables to generic names
ALTER TABLE ecc_topics RENAME TO topics;
ALTER TABLE ecc_topic_issues RENAME TO topic_issues;

-- Rename indexes
ALTER INDEX ecc_topics_status_idx RENAME TO topics_status_idx;
ALTER INDEX ecc_topics_company_idx RENAME TO topics_company_idx;

-- Update adapterType in agents table
UPDATE agents SET adapter_type = 'ea' WHERE adapter_type = 'ecc';
