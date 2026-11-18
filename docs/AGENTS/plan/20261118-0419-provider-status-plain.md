# A failed AI provider check shows a plain line, not the engine's raw output

- Date (UTC): 2026-11-18 04:19
- Branch: `fix/provider-status-plain`
- Status: in progress
- Where: trina-ax `server/src/admin/engines.ts`, `shared/src/api/admin.ts`, `web/src/pages/admin/Engines.tsx`. Why: AI connection status is core (docs/REPOSITORY-RULES.md)
- Version impact: patch, a status-line fix with one optional response field

## Goal

QA TC-4837. When the status check of an AI provider fails, Admin › AI providers shows the engine's raw output
("Could not check the status: {"type":"system","subtype":"init",…}"), on desktop and phone. An office worker
cannot act on it. The card should say in plain words what happened and what to do; the raw text stays reachable for
support, hidden by default.

## Scope

In: the Claude Code and Codex checks (`--version`, `auth status`) and the API engine's "address could not be
reached" line. A plain line by reason (took too long, no network, not signed in, anything else), with the provider's
name. The raw text, cut short and cleaned of keys, tokens and home folder paths, as an optional `errorDetail` on the
engine status (admin-only route), shown behind a collapsed "Show details" toggle with a copy button (a shared
component).
Out: the add-account check and Settings › AI (they return reason codes, never raw output: checked, nothing to fix).

## Steps

1. `engines.ts`: `failedCheckLine()` classifies a failed run; `supportDetail()` cleans the raw text.
2. `EngineStatus.errorDetail` (optional).
3. `components/SupportDetails.tsx` (toggle + copy), used in the engine row.
4. Plain lines in six languages; unit tests; screenshots at 1440/390, light/dark, en/ko.

## Decisions

none

## Risks

Public repo: no paths or secrets in the detail (tests check it). Five other languages (id Anda, es usted).

## Tests

`bun run typecheck`, `bun run check:i18n`, `tests/unit` for engines (Bun 1.3.12).

## Result

