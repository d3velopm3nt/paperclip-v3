# Paperclip v3 — Changes from Upstream

This fork (internal name "Paperclip v3") extends paperclip-surfers with:

- Email monitoring (per-company IMAP, triage agent, plan-gated task creation)
- In-app chat (DM to agents, per-task threads, multi-agent rooms)
- Telegram bot channel (bidirectional: chat + inline approval)
- Plan-approval gate on all governed agent actions
- Trust levels + skill promotion (human-approved)
- Human scoring loop feeding agent memory

All additions marked in code with `// v3:` comments for upstream merge clarity.

## Phases

- **Phase 1 (this branch):** Fork setup + new schema tables + companies.triageAgentId
- **Phase 2:** Email monitoring + plan-gate core
- **Phase 3:** Chat subsystem
- **Phase 4:** Telegram bot
- **Phase 5:** Trust + scoring + promotion

## Upstream

- Source: https://github.com/IncomeStreamSurfer/paperclip-surfers
- Merge cadence: monthly
- Conflict policy: keep additions in new files; `// v3:` marker on touched upstream files

## Baseline

- Fork base: `06b78f191765ea3ded5020a0dd407161258a3bc4` (upstream HEAD at fork time)
- Baseline repair: `312a784f` ("v3: baseline repair")

## Known Upstream Breakage

Upstream HEAD `06b78f19` ships with pre-existing breakage at fork base. v3 work around it without patching upstream code in Phase 1 — fix when a later phase touches the affected surface.

### 1. UI package typecheck fails (37 errors)

- Files: `ui/src/components/AgentPerformanceTab.tsx`, `ui/src/pages/Analytics.tsx`
- Cause: self-improvement dashboard components reference stale props (`agentId` vs `agentIds`, missing `title`/`severity`/`content`/`name`/`description`/`result`/`completionRate`/`durationMs`/`errorCount`/`agentTrends`). Shared types in `@paperclipai/shared` evolved; UI not updated.
- Workaround: root `package.json` adds `v3:typecheck` / `v3:build` / `v3:test` / `v3:verify` scripts that filter out `@paperclipai/ui`. Phase 1 gate = `pnpm v3:verify`.
- Fix owner: Phase 2 (when email-monitoring sidebar + UI work starts).

### 2. `workspace-runtime.test.ts` test expectations out of date

- File: `server/src/__tests__/workspace-runtime.test.ts` (lines 423–428)
- Cause: env writer emits unquoted values for shell-safe chars; test expected `JSON.stringify()`-quoted values.
- Fix applied in commit `312a784f`: stripped `JSON.stringify()` wrapping from 4 assertions. Marked `// v3:`.

## Scripts

- `pnpm v3:typecheck` — typecheck all workspaces except ui
- `pnpm v3:build` — build all workspaces except ui
- `pnpm v3:test` — run vitest (all)
- `pnpm v3:verify` — typecheck + test + build in sequence (Phase 1 gate)

## Spec

Design spec lives in the primary `ai-agent-workflow` repo at
`docs/superpowers/specs/2026-04-22-paperclip-v3-governed-agent-platform-design.md`.
