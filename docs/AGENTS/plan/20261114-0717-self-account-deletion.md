# A person deletes their own account, on a date the app shows

- Date (UTC): 2026-11-14 07:17
- Branch: `feat/self-account-deletion`
- Status: in progress
- Where: server/src/auth, server/src/admin, server/migrations (B), web settings, docs. Why: accounts, the deletion
  request and the members screen live there (docs/REPOSITORY-RULES.md)
- Version impact: minor: new optional API fields, a new migration and a new automatic step (the sweep)

## Goal

Store rules (Apple 5.1.1(v), Google Play) and privacy law want a person to delete their account inside the app without
waiting for a human. Today Settings › Profile › Delete account only asks the team owner, and nothing happens if
nobody acts. After this, the request deletes the account by itself 7 days later; the page says the date, what goes,
what stays and for how long. The owner and the admins see the date and can delete it sooner; they cannot stop it.

## Scope

In:
- `removeAccount(ctx, { targetId, actorId | null, personalFolder, why })`: the body of the members screen's delete,
  callable without a request (actor null = the server, automatic).
- Cleanup hooks (`server/src/auth/account-removal.ts`): each area registers what it removes with an account (sessions,
  sign-in networks, notices, push devices, schedules, site grants, dev-environment rows, Drive and Slack links,
  OAuth flows). They also run once at start for accounts deleted before. A coverage test lists every table with a
  user column: removed, or kept on purpose with a reason.
- A self-requested deletion also removes, at once: private chats and memories, the person's trashed files, file
  history and folder records left under `users/<id>/`. The personal folder goes to the owner's archive (owner
  decision); the page says so.
- Migration `295_b_account_deletion_due.sql`: `due_at` on the request. Open requests at migration time get migration
  time + 7 days and a new inbox notice to the person (`account.deletion_due`).
- Asking needs the password (the existing re-check limit: 5 wrong tries per 15 minutes).
- The hourly sweep deletes accounts whose date has passed (actor null, audit `user.delete` with `why: self_request,
  automatic: true`). A failure is retried at the next sweep.
- Becoming the owner cancels an open request (audit `account.deletion_cancel`, `by: ownership`).
- Web: the page shows the date, a password field, what goes and what stays (name on old messages, team files, the
  owner's archive, backups up to 8 weeks, audit log); the owners' inbox and the Members badge show the date.
- Docs: DECISIONS, STORE-SUBMISSION (reviewer note, reviewer account check), the restore runbook (re-delete accounts
  deleted after the backup point), changelog fragment.

Out: the Trina Cloud console account and the Play web page (trina-cloud repo); deleting backups.

## Steps

1. removeAccount refactor; deleteUser calls it.
2. Cleanup hooks and the coverage test.
3. Migration 295, due date, password, sweep, ownership cancel, contract.
4. Web page, inbox and badge text: en first, then ko/id/ja/es.
5. Docs.

## Risks

- Migration number: B range, check `server/migrations/` on origin/dev right before committing (294 is the highest
  today).
- The sweep deletes without a human: only open requests whose date passed, never the owner, one person at a time.
- The App Review account deletes itself after a review: runbook line in STORE-SUBMISSION.
- A restore from a backup made before a deletion brings the account back: the restore runbook says to delete it again.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `tests/unit/a-account-deletion*.test.ts`, the new
coverage test, web unit tests for the page.

## Result

Filled in at the end.
