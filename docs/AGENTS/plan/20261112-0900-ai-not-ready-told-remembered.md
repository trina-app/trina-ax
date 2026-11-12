# "Trina isn't ready yet": "Told" survives a reload

- Date (UTC): 2026-11-12 09:00
- Branch: `fix/ai-not-ready-told-remembered`
- Status: done (PR open)
- Where: trina-ax core (`shared/src/api/credentials.ts`; `server/src/routes/credentials.ts`,
  `server/src/notifications/service.ts`; `web/src/store/aiAccess.ts`, `web/src/components/chat/NotReadyButton.tsx`;
  the mock server; tests)
- Version impact: patch; no schema change, no new endpoint (one optional response field).

## Goal (owner decision 2026-11-12, QA TC-188 on #429)

A member's [Tell an admin] turns into "Told" (알렸어요), but after a reload it showed [Tell an admin] again, although the
server sends no second notice within the hour. "Told" must survive a reload, read from the server's own record (not
the browser), per member, until the hour passes. The owner and admins are unaffected ([Connect AI]); when the AI works
again the card goes away as today.

## How

- `Notifications.aiNotReadyTold(memberId)`: is there a `not-ready:<memberId>` notice newer than
  `AI_NOT_READY_WINDOW_MS`? The same query `aiNotReady` already used as its limit (now it calls this one).
- `GET /api/me/ai-access` gains `notReadyTold` (optional: older servers omit it); false for the owner and admins.
- Web: `useAiAccess` keeps `notReadyTold` (loaded with the rest, set by a successful press, cleared on sign-out);
  `NotReadyButton` loads it for a member and reads "Told" when it is true.

## Tests

- server: notReadyTold for the teller only, not for another member, the owner or an admin; false after the hour.
- web unit: the button reads "Told" (disabled) from the store; owner/admin unaffected; the store's flag.
- e2e (mock): press, reload, still "Told"; another member still reads [Tell an admin].
