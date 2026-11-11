# The account holder is told when a password reset link is made for them

- Date (UTC): 2026-11-11 14:36
- Branch: `fix/owner-reset-link-notice`
- Status: done
- Where: `server/` (auth, notifications), `shared/src/api/notifications.ts`, `web/` (the notice's words). Why: the
  reset link and the Inbox are core account features (see docs/REPOSITORY-RULES.md)
- Version impact: minor — a new notice in the Inbox (a new notice kind and its table, migration 119)

## Goal

QA TC-202: when someone with access to the server makes a password reset link for the owner (`mycel-account
reset-link`, `mycel-ctl reset-link`), the owner only gets a line in the activity log (`시스템 비밀번호 재설정 링크 발급`).
No notice, no unread count. A reset link signs its holder in as that person, so the person should know one exists and
how to stop it.

After this change the person the link is for gets a notice in Activity (always shown, like a join or a deletion
request): who made it (the server, or the admin's name) and, while the link still works, that changing their password
now stops it, with a link to Settings › 보안·기기.

## Scope

In:
- New notice kind `account.reset_link` (source: the reset link's row id, never the token) in its own table
  `reset_link_notices` (migration `119_a_reset_link_notices.sql`; `notification_inbox` has a fixed event_type list).
- `createResetLink` records it for the account holder after the link is saved: the server CLIs (maker none) and an
  owner or admin in Admin › Members alike.
- Inbox row (`resetLink: { server, by, open }`): `server` true when made on the server; `by` the maker's name while
  their account is there; `open` while the link is unused and not expired (read at the time of the read).
- Web: the words in five languages; while open, the row opens Settings › 보안·기기 (where the password is changed).

Out:
- Phone / browser push for it (the notice is in the app; push needs its own delivery table).
- A temporary password set by an admin (Admin › Members › 임시 비밀번호): not this QA row.

## Steps

1. Migration 119 (check the highest A number on dev before pushing).
2. `shared/src/api/notifications.ts`: event type, `resetLink` field.
3. `server/src/notifications/service.ts` (table, record, row out) and `preferences.ts` (always shown);
   `server/src/auth/accounts.ts` `createResetLink` calls it.
4. `web/src/components/settings/Notifications.tsx`: text and link; i18n in ko/en/id/ja/es.
5. Tests: a unit test (server CLI link for the owner → one unread notice with `server: true, open: true`; an admin's
   link for a member → `by` the admin's name; after a password change `open: false`; no token in the row) and a web
   unit test for the words.

## Risks

- Migration number clash with an open PR (check before pushing).
- The text must not alarm a member whose admin made the link because they asked: it says who made it and what to do
  only "if you did not ask for it".
- No token, link or address in the notice or the realtime signal.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, the notification and auth unit tests,
`bun run test:web` (web unit).

## Result

Built as planned. Expiry in the row is read with the wall clock (like the rest of the Inbox). Tests:
`tests/unit/a-reset-link-notice.test.ts` (server-made link for the owner: one unread notice, no token, closes after a
password change; an admin's link for a member names the admin, the maker gets none, closes when expired),
`tests/unit/dev-admin.test.ts` (the real `bun run dev admin reset-link` leaves the owner's row) and
`web/test/unit/inbox-notice-rows.test.tsx` (words and link). On a local dev server, `bun run dev admin reset-link` gave
the owner unread count 1 with `{ server: true, by: null, open: true }`.
