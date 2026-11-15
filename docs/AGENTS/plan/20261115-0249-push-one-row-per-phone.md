# One phone, one push row: a sign-in over another person's session ends it

- Date (UTC): 2026-11-15 02:49
- Branch: `fix/tc835-push-dup`
- Status: done
- Where: `server/src/auth/service.ts` (`signIn`). Why: the session a browser sends at sign-in is the auth core's to
  end (docs/REPOSITORY-RULES.md: phone and auth are core)
- Version impact: patch. No migration, no API or app change

## Goal

QA TC-835: after someone signs in again on a phone, the server could hold an old push row for that phone. Checked case
by case against `server/src/notifications/push-service.ts` and migration 208:

1. **The same token twice (any person).** Not possible: `push_subscriptions.endpoint_hash` is `UNIQUE` and
   `registerDevice` deletes the other row first. One row per token, so one fan-out never sends a token twice.
2. **The same phone with a new token while the old session is still valid** (an app update that lost the WebView's
   cookie, the owner's 1.0.0/1.0.2/1.0.3 rows). Real: the server cannot tell it is the same phone. The app side is fixed
   by #767 (the earlier device becomes an owed removal, sent with its removal key at the next start; next store build).
   Sign-out already removes the row (`ON DELETE CASCADE` on `session_id`), and an expired session's row is never sent
   (`eligible`) and is deleted at the next queue pass.
3. **The same token moving to another person on a shared phone.** When the first person's session is over, the row
   moves (TC-201's rule). When it is still live, registration answers 409 `PHONE_TAKEN` and the first person's row
   stays, so the phone keeps getting *their* notices. That happens when the first person's sign-out never reached the
   server: `web/src/lib/logout.ts` ignores a failed `POST /api/auth/logout` and shows the sign-in page, while the
   HttpOnly cookie (cleared only by the server's answer) and the server session stay. The next person signs in in the
   same WebView: privacy bug.

## Change

`signIn` in cookie mode: when the request carries this scheme's session cookie and it names another person's session,
that session ends (`revokeSession`, like a sign-out). The browser is about to get a new cookie in its place, so it can
never use that session again; it proved it held it. Its push rows go with it (cascade, `cancelPushSession`), so the
next person's registration of the same phone token succeeds and nothing of the first person reaches that phone.

- The same person's earlier session is left as it is (the desktop app copies one cookie to its second team address;
  a same-person token is replaced at registration anyway).
- Bearer sign-ins and a cookie of an unknown or ended session change nothing.
- TC-201 stays: a token held by another person's live session elsewhere (no cookie of it in this request) is still
  refused with 409.

Not done: a per-install device id (the app sends none; it would need a store build and #767 covers case 2), a
fan-out dedupe (the unique index already guarantees it), a migration (no duplicate tokens can exist).

## Tests

`tests/unit/push-native.test.ts`: each case above, over HTTP where it matters. Regression cover of what already held
(sign out then sign in with a new token: one row; the same token again: one row; an expired session's row goes; a new
token of the same person: two rows until the app's removal). The fix: another person signing in over a session whose
sign-out never arrived takes the phone, and the first person's notice (also one queued before) does not reach it; the
same person's earlier session stays; TC-201's refusal from another browser stays. `bun run typecheck`, auth and push unit tests, under Bun 1.3.12 too.
