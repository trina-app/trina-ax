# Another member cannot take over someone's phone push token

- Date (UTC): 2026-11-11 12:20
- Branch: `fix/push-token-takeover`
- Status: done
- Where: `server/src/notifications/push-service.ts`. Why: phone push registration lives there (core, see
  docs/REPOSITORY-RULES.md)
- Version impact: patch. Registration refuses a case it wrongly allowed; nothing new to set up

## Goal

QA TC-201 (audit finding #11). `POST /api/push/devices` replaced the row of any other session with the same device
token, also another person's live one. A member who knows a colleague's APNs/FCM token could register it as their own:
the colleague's row was deleted (no more pushes for them), and the member's own notices went to the colleague's phone.
After this change the server refuses that registration while the token belongs to another person's live session.

## Why a rule is enough (no product decision)

The old rule ("a token belongs to the latest session that registered it, also for another account") was there for a
phone handed to another person. Every such hand-over now removes the old row before the new person registers:

- Sign-out: logout deletes the session, and the device row goes with it (`ON DELETE CASCADE`).
- Team switch in the app: the app removes its device with the removal key (`POST /api/push/devices/:id/remove`).
- Reinstall on iOS: the app signs out the session the WebView kept (`mobile/src/install.ts`), so the row goes too.
  On Android a reinstall gets a new FCM token.
- An expired session, or an account that was removed or switched off: no longer live, so it is replaced as before.

So a row of another person's live session with the same token is a takeover, not a hand-over. It is refused with 409
and a plain line in the person's language: another account gets this phone's notifications now, so sign out there
first. The same person's other session (their own reinstall, a second sign-in) still replaces it, as before.

Options considered: proof of possession (a silent push with a code the app echoes back) would also cover a phone whose
reinstall sign-out never reached the server, but it needs app and gateway changes. It is not needed for the cases above.
Keeping "last one wins" leaves the takeover open.

## Scope

In: the refusal in `registerDevice`; its message in five languages; `docs/DECISIONS.md` says the new rule; tests.
Out: Web Push (`subscribe` already refuses an endpoint of any other session); proof of possession.

## Steps

1. `registerDevice`: when the token's row is another person's and that session is still live (not expired, the
   account active and not deleted), throw `conflict` with the message. Otherwise as before.
2. Message table in `server/src/notifications/text.ts` (ko/en/id/ja/es).
3. Tests in `tests/unit/push-native.test.ts`: the takeover is refused and the owner's row stays and keeps getting their
   push; after the owner signs out, the other person registers the phone; the same person's second session still
   replaces it. Also over HTTP (409 with the message).
4. DECISIONS.md: the native push line about a token's owner.

## Risks

Security (what reaches whose phone): "Security: merge needs owner OK". No migration, no web change (Settings shows the
server's message through `errorText`; the phone's ask card keeps its generic "could not turn on" line).

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun test tests/unit/push-native.test.ts` and the
other push tests.

## Result

Built as planned. `registerDevice` refuses with 409 and `PHONE_TAKEN` (the caller's language, never whose phone) when
the token's row is another person's and that session is live (`live`: not expired, account active and not deleted).
Tests: `push-native` (the takeover refused; the owner keeps their push and none of the member's reach that phone; an
expired session or a switched-off account is replaced; the same person's second session replaces it; after a sign-out
the next person registers), and `push-label` now signs the first person out before the phone changes hands. Both new
`push-native` tests failed before the fix. The permission matrix (`tests/security`) needs no change: an allowed write
answering 409 is not a matrix problem, and its world has no gateway (503).
