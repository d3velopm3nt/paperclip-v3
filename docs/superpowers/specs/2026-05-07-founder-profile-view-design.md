# Founder Profile View — Design Spec

**Date:** 2026-05-07
**Status:** Approved

---

## Goal

A cross-company control surface for the founder. One place to see all companies' operational state, manage Topics (persistent memory workstreams), and navigate to any company without switching context manually. The founder identity and Personal company are configurable via a settings section.

---

## Architecture

### Navigation entry point

A founder icon (paperclip logo or crown icon) added at the **top of the company rail** (`CompanyRail.tsx`), above all company icons. Clicking it navigates to `/founder`. This is always visible regardless of active company.

### Routes

```
/founder                    → FounderView (tab: Overview)
/founder/topics             → FounderView (tab: Topics)
/founder/topics/:topicId    → TopicDetail (full page)
/founder/settings           → FounderView (tab: Settings)
```

### Pages / Components

| File | Responsibility |
|---|---|
| `ui/src/pages/FounderView.tsx` | Shell with tab bar: Overview / Topics / Settings |
| `ui/src/pages/founder/FounderOverview.tsx` | Cross-company dashboard |
| `ui/src/pages/founder/TopicsList.tsx` | Topic list with create/archive |
| `ui/src/pages/founder/TopicDetail.tsx` | Topic memory editor + linked issues |
| `ui/src/pages/founder/FounderSettings.tsx` | Founder profile config |
| `ui/src/api/topics.ts` | API client for `/api/ecc/topics` |
| `ui/src/components/CompanyRail.tsx` | Add founder icon at top (modify) |

---

## Database

### `ecc_topics`

```sql
id          uuid PK default random()
name        text NOT NULL
summary     text NOT NULL default ''   -- markdown memory content
currentState text                       -- single-line status (ECC updates this)
companyId   uuid REFERENCES companies(id) NULLABLE  -- null = cross-company
status      text NOT NULL default 'active'  -- active | archived
createdAt   timestamp with time zone NOT NULL default now()
updatedAt   timestamp with time zone NOT NULL default now()
```

### `ecc_topic_issues`

```sql
id        uuid PK default random()
topicId   uuid NOT NULL REFERENCES ecc_topics(id) ON DELETE CASCADE
issueId   uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE
UNIQUE (topicId, issueId)
createdAt timestamp with time zone NOT NULL default now()
```

---

## Server API

Base path: `/api/ecc/topics` — board auth required for all routes.

| Method | Path | Action |
|---|---|---|
| GET | `/api/ecc/topics` | List all topics (with issue counts) |
| POST | `/api/ecc/topics` | Create topic |
| GET | `/api/ecc/topics/:id` | Get topic with linked issues |
| PATCH | `/api/ecc/topics/:id` | Update name, summary, currentState, status, companyId |
| DELETE | `/api/ecc/topics/:id` | Delete topic (cascade deletes topic_issues links) |
| POST | `/api/ecc/topics/:id/issues` | Link an issue to topic |
| DELETE | `/api/ecc/topics/:id/issues/:issueId` | Unlink issue from topic |

---

## UI Design

### Founder icon in CompanyRail

- Position: above all company icons, separated by a thin divider
- Icon: `Paperclip` or `LayoutDashboard` from lucide-react
- Active state: same highlight style as selected company
- Tooltip: "Founder Overview"

### FounderView — tab shell

- Three tabs: **Overview** | **Topics** | **Settings**
- Clean header: founder name (from settings, fallback "Founder Overview") with no company prefix in breadcrumb
- Tabs use same style as existing tab bars in the app

### FounderOverview tab

Three sections:

**1. Company Cards row**
One card per company. Each card shows:
- Company name + color dot
- "Personal" badge on the company designated as personal space (from settings)
- Open issue count (backlog + todo + in_progress)
- Blocked issue count (red badge if > 0)
- Active agent count
- Pending approval count
- Click → navigates to that company's dashboard

**2. Needs Attention**
Flat list of issues that are `status = blocked` or have pending approvals, across ALL companies. Columns: company name, issue identifier, title, status. Sorted by updatedAt desc. Max 20 rows. Empty state: "Nothing blocked across your companies."

**3. Recent Activity**
Cross-company activity feed. Last 30 events. Shows: company name badge, actor, action, entity, timestamp. Uses existing activity log data.

### TopicsList tab

- "New Topic" button top right → opens inline creation form (name field + company selector + save)
- Table/list: topic name | company (or "Cross-company") | current state | issue count | updated | status badge
- Archive action per row (moves to archived state, hidden by default)
- "Show archived" toggle
- Click row → navigates to `/founder/topics/:id`

### TopicDetail page

Full-page layout, two columns (60/40 split):

**Left column — Memory**
- Editable topic name (inline, click to edit)
- "Current State" single-line text field — short status summary
- Company badge (editable dropdown)
- Large markdown editor for `summary` (the memory content)
  - Toolbar: bold, italic, heading, bullet, code block
  - Auto-save on blur (PATCH to API)
  - "Last saved X minutes ago" indicator

**Right column — Context**
- Linked issues list: identifier, title, status, company name
  - "Link issue" button → search dialog (search by identifier or title across all companies)
  - Unlink (×) per issue
- Archive / Delete topic buttons at bottom

### FounderSettings tab

Stored in `instanceSettings.general.founderProfile` (JSONB, same pattern as other instance settings).

Fields:
- **Founder name** — text input. Used as the header label in FounderView and injected into ECC system prompt so the agent knows who it's talking to.
- **Personal company** — dropdown of all companies. The selected company gets a "Personal" badge in Overview cards. Signals to the ECC that this company contains personal life topics (Finance, Family, Home, etc.) not business workstreams.

On save: PATCH `/api/instance-settings` with updated `founderProfile` object.

No server-side validation needed beyond existing instance settings endpoint.

---

## Personal Company Pattern

The Personal company is treated identically to business companies in the data layer. Organisation is done via Topics:

Recommended starter topics under Personal:
- Finance
- Family
- Home Maintenance
- Utilities

Each Topic has its own markdown memory, current state, and linked issues. The ECC can update these from Telegram ("update Finance topic: car insurance renewed, next review March 2027").

No special schema or UI is needed — this is a usage pattern, not a feature.

---

## MCP Tools (new)

Added to `server/src/routes/mcp-tool-server.ts` so the ECC agent can read/write topics from Telegram.

| Tool | Description |
|---|---|
| `list_topics` | List all active topics with name, currentState, companyId, issue count |
| `create_topic` | Create a new topic with name and optional companyId |
| `update_topic_memory` | Update a topic's summary (markdown) and/or currentState |
| `link_issue_to_topic` | Link an issue UUID to a topic UUID |

These allow the ECC to maintain topic memory from Telegram conversations: "Update the SafeX proposal topic — Kevin confirmed pricing, state = awaiting contract sign-off."

---

## Data Flow

```
Founder opens /founder
  → FounderOverview fetches:
      GET /api/companies (all companies)
      GET /api/ecc/topics (topic list)
      Per company: GET /api/companies/:id/issues?status=blocked (needs attention)
      GET /api/companies/:id/activity (recent activity, merged client-side)

TopicDetail opens /founder/topics/:id
  → GET /api/ecc/topics/:id (topic + linked issues)
  → PATCH /api/ecc/topics/:id on any field change (debounced 1s)
```

---

## Error Handling

- Company fetch fails → show company card in error state, don't break whole page
- Topic save fails → show "Save failed, retrying…" toast, retry once
- Issue link fails → show error toast, revert optimistic update

---

## Out of Scope (this iteration)

- Proactive Telegram digest / scheduled briefings
- Topic-to-topic relationships
- Topic comments/history
- Global search across all companies
- Topics visible in per-company sidebar

---

## Success Criteria

1. Founder can open `/founder` and see all companies' blocked issues without switching company context
2. Founder name and Personal company are configurable in Settings tab
3. Personal company shows "Personal" badge in Overview; its Topics (Finance, Family, Home etc.) work identically to business Topics
4. Founder can create a Topic, write markdown memory into it, link issues to it
5. ECC agent can update topic memory from Telegram ("update SafeX topic: pricing confirmed")
6. Founder icon always visible in company rail regardless of active company
