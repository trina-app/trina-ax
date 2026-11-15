# A person's usage limit from Admin › Members

- Date (UTC): 2026-11-15 02:00
- Branch: `feat/member-usage-limit`
- Status: done
- Where: `web/src/pages/admin` (Members, the shared limit dialog), `web/src/i18n`, docs. Why: admin screens are core
  (see docs/REPOSITORY-RULES.md)
- Version impact: minor, a new way to set a limit (no new setting, no server change)

## Goal

The owner (2026-11-15): "멤버 설정에서 바로 설정하거나 볼 수 있으면 좋지 않을까?" A person's usage limit is only in
Admin › Team settings › Usage limits today. Admins should see and set it where they look at the person:
Admin › Members & invites.

## Scope

Cut by an independent product review before building (lean UI, no jargon).

In:
1. The limit dialog moves out of TeamAiSettings.tsx into `BudgetForm.tsx`, shared by Team settings and Members.
   For a person it has no "Applies to" (the title names them).
2. Members row "…" › **Usage limit…** for every team member (not guests). The **Period** picks which of the person's
   limits is shown: the one they have for that period is edited, else a new one is made. No "open the first one"
   rule, and a day limit never hides a month one. Editing one shows what is used of it and **Remove limit**.
3. Desktop: one quiet line under the name only for people with a personal limit ("50,000 tokens a month", "$20.00 a
   month"), with "· Over limit" in red once used up. No new column, no badge.
4. Phone: the person's page gets one **Usage limit** row (used of the limit this period, "No limit" or "2 limits")
   that opens the same dialog; the phone list row says **Over limit** with the other things that need a look.

Out (cut by the review): the Groups page menu; a "See usage" link and a `?user=` filter on Activity › Usage; an
over-limit badge; used amounts on the desktop row; team and group limits on a person. Guests keep their automatic
monthly limit in Team settings and their own Change AI.

## Steps

1. `web/src/pages/admin/BudgetForm.tsx`: the dialog, `loadBudgets` (the shared 'budgets' admin read) and the text
   helpers; TeamAiSettings.tsx uses it.
2. Members.tsx: the menu item, the row line, the phone row, the dialog; the same read, reloaded after a save so Team
   settings shows the same list.
3. i18n in en, ko, id, ja, es, zh; `bun run check:i18n`.
4. Tests: `web/test/unit/member-usage-limit.test.tsx` (pre-fill, edit vs new, period switch, remove, row line, menu),
   `web/test/e2e/member-usage-limit.spec.ts` (desktop and 390 px).
5. Docs (use/usage-and-limits.md, en and zh) and `changes/member-usage-limit.md`.

## Risks

- Who sees it: the limits endpoints are `auth: 'admin'` (owner and admins); members cannot open /admin or read
  /api/admin/budgets. No server change.
- The server allows two limits of the same period for one person (made in Team settings). The dialog then edits the
  first of them; Team settings still lists both. The dialog reads the list again as it opens, so a limit made a moment
  ago elsewhere is edited, not made a second time (code review).
- A limit set in dollars only has no token number: the texts fall back to the amount.
- No migration.

## Result

Built as cut. An independent code review found two stale-list risks (a kept list up to a minute old could make a
second limit, and a read behind an open dialog could turn a new limit into an edit); fixed by reading the limits again
as the dialog opens and keeping that list while it is open. Also fixed on the way: editing a dollars-only limit added a
1,000,000-token limit, and an emptied token field saved 0 tokens (which blocks at once). Unit tests (9), an e2e spec
(desktop and 390 px), screenshots for owner, admin and member at 1440/390 light/dark, and a live walk on a copy of the
QA-Acme team (QA TC-2507..2511).
