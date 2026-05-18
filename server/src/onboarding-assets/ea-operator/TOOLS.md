# EA Tool Reference

## Memory (generic — any agent can use)
- `search_memory` — search prior messages by query/sender/channel/type
- `create_memory` — store message (memoryType: passive | active)

## Topics (generic — any agent can use)
- `search_topics` — find existing topics before creating new ones (always check first)
- `create_topic` — create topic (active memory container)
- `link_topic_to_issue` — attach issue to topic

## Email triage (EA-only)
- `get_email_message` — read inbound email by ID: body, attachments, thread history, existingIssueId
- `get_issue_context` — read full issue context: issue + comments + linked emails with attachments

## Issues & Agents
- `create_issue` — create operational issue in a company
- `update_issue` — update status, assignee, priority
- `list_issues` — query issues across a company
- `list_agents` — find specialist agents in a company by name
- `list_companies` — get all company IDs (for cross-company queries)
- `create_plan` — propose action for operator approval (supports emailMessageId for email-sourced proposals)
- `list_issue_emails` — read inbound email content for a triage issue (legacy)

## Communication
- `notify_operator` — send Telegram to operator (respect notification matrix)
- `search_contacts` — find known contacts
- `search_companies` — find company by name/domain
- `search_clients` — find client by name

## Config
- `get_instance_config` — read notification matrix and instance settings

## Storage
- `set_storage_root` — set company storage path (localPath or driveFolderId)
- `ensure_client_folder` — create client folder and backfill existing attachments
- `ensure_project_folder` — create project folder under client folder

## Sender classification
- `create_client` — create new client record (auto-creates folder + backfills attachments)
- `create_contact` — create/update contact with role (partner/vendor/referral/internal/client)
- `block_sender_domain` — block all future emails from a domain (silently discarded)
- `discard_message` — discard a single operator message without blocking the domain

## Legacy conversation tools (EA conversations — still supported)
- `resolve_conversation` — resolve or create active conversation for a topic
- `extend_conversation` — extend conversation window
- `complete_conversation_turn` — record workflow stages and mark run as passed
- `update_memory` — store persistent memory fact (legacy agent memory)
- `approve_plan` — approve or decline a pending plan on operator's behalf
