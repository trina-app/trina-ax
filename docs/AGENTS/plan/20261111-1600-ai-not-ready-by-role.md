# "Trina isn't ready yet": the chat error by role, with one button

- Date (UTC): 2026-11-11 16:00
- Branch: `fix/ai-not-ready-by-role`
- Status: in progress
- Where: trina-ax core (`shared/src/api/errors.ts`, `credentials.ts`, `notifications.ts`; `server/src/routes/credentials.ts`,
  `server/src/notifications/service.ts`; `web/src/lib/chatErrors.ts`, `web/src/components/chat/Messages.tsx`, a new
  `web/src/components/chat/NotReadyButton.tsx`; `web/src/components/settings/Notifications.tsx`; i18n; tests)
- Version impact: patch; no schema change (the notice uses the existing `onboarding_notices` table).

## Goal (owner decision 2026-11-11)

When the AI cannot start (`engine_missing`), the chat error said to everyone "The AI can't answer right now. Let the
team owner know." (older builds: "The AI engine is not available right now ... Diagnostics shows why"), even to the
owner. By role now:

- Member: "Trina isn't ready yet." and one button [Tell an admin]. It sends an Inbox notice to the owner(s) and admins
  ("<name> tried to use Trina but it isn't set up yet", opening Admin › AI accounts) and turns into "Told". The server
  sends at most one per person per hour (a second press within the hour sends nothing and still answers "told").
- Owner/admin: "Trina isn't ready yet. Connect an AI so it can answer." and one button [Connect AI] to `/admin/providers`.
- "Try again" stays. No developer words (engine, Diagnostics) in the member's text.

## How

- `CHAT_ERROR_MESSAGES.engine_missing` gets the new words in 5 languages; the old words move to `LEGACY_CHAT_ERRORS`
  so stored errors are still told apart.
- `POST /api/me/ai-not-ready/tell` (members only): `Notifications.aiNotReady` records an `onboarding.ai_request` row
  per owner/admin with source `not-ready:<memberId>` (re-armed after the hour), the rate limit being the newest such row.
  The "connect for me" request (source = member id) and its settling are unchanged; not-ready rows are never settled.
- Inbox: the row carries `requester` and `notReady: true`; the web text says the new sentence.

## Tests

- server: notice to owner and admin, not to members, name + link; second press within the hour sends nothing; after the
  hour it is sent again; owner/admin 403; the connect request is unaffected.
- web: `chatErrorText` for member vs owner/admin; the button component for both roles.
