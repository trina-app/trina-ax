# Drag an AI account to change the order it is used in

- Date (UTC): 2026-11-18 02:42
- Branch: `feat/ai-accounts-drag-order`
- Status: in progress
- Where: web (`web/src/pages/admin/Credentials.tsx`, a small `web/src/lib` helper). Why: a screen change on Admin › AI
  providers; the server's order and permission checks stay as they are (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a new way to do what Move up / Move down already do

## Goal

Under each provider in Admin › AI providers (Claude Code, Codex) the team's accounts are a priority list: the top
working account is used first. Today the order changes only through Move up / Move down in each row's ⋯ menu. The owner
(QA TC-4836) wants to grab a row and drag it. The hint behind "How order works" is replaced by one plain line.

## Scope

In:
- A drag handle on each team account row, for the owner and admins (the same people who see the ⋯ menu), only when the
  provider has two or more accounts. Mouse, touch (390 px) and keyboard (focus the handle, Space to pick up, arrow keys
  to move, Space or Enter to drop, Escape to cancel), with screen-reader announcements.
- The drop saves through the same call as Move up / Move down (`PATCH /api/admin/credentials/:id` with `priority`,
  renumbered 10, 20, 30 … in the new order). One pure helper computes the new order and the patches; Move up / Move
  down use it too.
- The row moves at once (the list is updated before the calls), then the list is read again.
- The plain line under a list of two or more: "{product} uses the top working account. If one is refused or at its
  limit, it moves to the next." When an account in the list is given to a person or a group, a second line says those
  people use it first. The cost note moves into an API key's details. Six languages, docs in six languages.

Out:
- A new "set order" endpoint (one call for the whole list). The per-row PATCH is what Move up / Move down use, admins
  already may call it, and a list has a handful of accounts.
- Members' own accounts (Settings) and the personal list on Admin: they have no order to change.
- A drag-and-drop library: the repo has none and no sortable list. A small pointer-events version is enough for one
  short vertical list (no new dependency, no bundle cost, works the same for mouse and touch).

## Steps

1. `web/src/lib/reorder.ts`: `moveItem(list, from, to)` and `priorityPatches(list)` (10, 20, 30 …, only the rows that
   change). Unit tests in `web/test/unit/`.
2. `useTeamCredentials`: `reorder(d, fam, from, to)` — optimistic `setData`, the PATCHes, reload. `move` calls it.
3. `ProviderAccounts`: a handle per row (`GripVertical`), pointer drag with a placeholder gap, keyboard pick-up, live
   announcements (`useAnnounce`).
4. Copy: replace `credentials.order`, drop `providers.howOrder` and the disclosure; add the handle label, the keyboard
   help and the announcements in en, ko, zh, ja, es (usted), id (Anda).
5. e2e in `web/test/e2e/credentials.spec.ts`: drag with the mouse, keyboard reorder, Move up still works.
6. Docs `docs/site/*/use/admin.md`, `changes/ai-accounts-drag-order.md`.
7. Screenshots before / after / mid-drag, 1440 and 390, light and dark, on a throwaway copy of the QA team.

## Decisions

`docs/decisions/20261118-ai-accounts-drag-order.md`: drag to reorder uses native pointer events and the existing PATCH,
no library and no new endpoint.

## Risks

- No migration, no server change, no permission change.
- Several PATCHes in a row: if one fails the reload shows what was saved (as Move up / Move down today).
- Touch: the handle sets `touch-action: none` so the page does not scroll while a row is dragged; the rest of the row
  scrolls as before.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, the new unit test, `credentials.spec.ts` e2e.

## Result

Filled in at the end.
