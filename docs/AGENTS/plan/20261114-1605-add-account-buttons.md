# Sign-in dialogs: "Open … to approve" and "Copy link" as real buttons

- Date (UTC): 2026-11-14 16:05
- Branch: `fix/add-account-buttons`
- Status: done
- Where: web/ (Team AX core). Why: shared web UI of the AI-account and connector sign-in flows (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a visual fix with no API change

## Goal

The owner (2026-11-14) found the Claude "Add account" dialog odd: "Open Claude to approve" was an underlined text link and
"Copy link" grey text, so the one thing to do next did not look like a button. Make the open step a real button, the
copy a real (quiet) button, and keep one primary action at a time.

## Scope

In:
- `ui.tsx`: `buttonClass()` shared by `Button` and a new `LinkButton` (an `<a>` that looks like a Button), and
  `SignInLinks`: Open (primary until it is used, then secondary) plus an optional Copy link button.
- Claude sign-in (Admin › AI accounts and Settings › AI accounts): SignInLinks; after Open the code field gets the focus
  and Connect is the only primary.
- ChatGPT sign-in step 1: the same buttons instead of the raw address as a link.
- Connectors sign-in wait (IntegrationRow, chat ConnectCard) and Google Drive's wait panel: Open as a LinkButton.

Out: copy changes (keys stay), desktop shell (no such flow there), new steps or numbering.

## Steps

1. Shared primitives in ui.tsx, unit test.
2. Swap the four flows, keep test ids.
3. Screenshots 1440/390 light/dark before/after, typecheck, check:i18n, unit + affected e2e.

## Risks

Test ids and roles stay (`claude-open` stays a link with target _blank). Drive's phone-app click handler keeps working
(LinkButton passes anchor props through). No migrations, no permission change.

## Result

`buttonClass`, `LinkButton` and `SignInLinks` in ui.tsx. Claude: Open primary until used or a code is in, then
secondary; the code field gets the focus. ChatGPT step 1: Open ChatGPT + Copy link instead of the raw address (step 1
copy and a new `credentials.chatgpt.open` in all six languages). Connector wait (row and chat card) and Google Drive's
wait: Open as a primary LinkButton. Unit test `web/test/unit/sign-in-links.test.tsx`; e2e credentials/integrations/
connected-apps-state pass.
