# Team name box limit, accurate name error, plain Drive claim error

- Date (UTC): 2026-11-20 13:38
- Branch: `fix/team-name-box-and-drive-claim-text`
- Status: in progress
- Where: `web/src/pages/admin/TeamSettings.tsx`, `server/src/auth/messages.ts`, `server/src/routes/drive.ts`,
  `server/src/integrations/google-drive/oauth.ts`. Why: three QA findings (TC-5921, TC-5920, Drive claim error).
- Version impact: patch. Wording and one input limit; no API, protocol or data change.

## Goal

1. TC-5921: on a hosted server the Admin > Team settings name box stops at 60 characters (the hosting service's
   limit, `TEAM_NAME_MAX`), counted in code points, so the person does not learn it only at Save. A self-installed
   server keeps 100.
2. TC-5920: the rule in `shared/src/cloud-protocol/team-name.ts` stays as it is (MIT, vendored into trina-cloud;
   no ideographic, no-break or hair space is refused, they render visibly). The error `teamNameInvalid` promised
   "no special spaces"; it now says what is refused: invisible or control characters, and a space at the start or
   end. Six languages.
3. POST /api/integrations/google-drive/claim answers `drive_invalid_code` / `drive_expired` as the message. It now
   says "This sign-in link has expired or was already used. Start the Drive connection again from the app." in six
   languages. The desktop app only logs the claim answer (`app-window.ts claimSignIn`), so the person sees the
   message only through the page's own flow; the text is right wherever it shows. The go page after a cancel can be
   told apart cheaply (the flow's recorded `reason = 'cancelled'`), so it says "cancelled" instead of "expired or
   already used".

## Steps
- messages.ts: new `driveClaimGone`, reworded `teamNameInvalid`.
- routes/drive.ts: claim maps `invalid_code` and `expired` to `driveClaimGone`; the go page asks `goGone()`.
- oauth.ts: `goGone(flowId)` returns 'cancelled' or 'expired'.
- TeamSettings.tsx: hosted caps the box at `TEAM_NAME_MAX` code points.
- Tests: `tests/unit/c-drive-app-return.test.ts`.
