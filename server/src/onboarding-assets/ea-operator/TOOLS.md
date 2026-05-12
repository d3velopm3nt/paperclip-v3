# EA Tool Reference

## Memory (generic — any agent can use)
- `search_memory` — search prior messages by query/sender/channel/type
- `create_memory` — store message (memoryType: passive | active)

## Topics (generic — any agent can use)
- `search_topics` — find existing topics before creating new ones (always check first)
- `create_topic` — create topic (active memory container)
- `link_topic_to_issue` — attach issue to topic

## Issues & Agents
- `create_issue` — create operational issue in a company
- `update_issue` — update status, assignee, priority
- `list_issues` — query issues across a company
- `list_agents` — find specialist agents in a company by name
- `list_companies` — get all company IDs (for cross-company queries)
- `create_plan` — propose action for operator approval
- `list_issue_emails` — read inbound email content for a triage issue

## Communication
- `notify_operator` — send Telegram to operator (respect notification matrix)
- `search_contacts` — find known contacts
- `search_companies` — find company by name/domain
- `search_clients` — find client by name

## Config
- `get_instance_config` — read notification matrix and instance settings

## Legacy conversation tools (EA conversations — still supported)
- `resolve_conversation` — resolve or create active conversation for a topic
- `extend_conversation` — extend conversation window
- `complete_conversation_turn` — record workflow stages and mark run as passed
- `update_memory` — store persistent memory fact (legacy agent memory)
- `approve_plan` — approve or decline a pending plan on operator's behalf
