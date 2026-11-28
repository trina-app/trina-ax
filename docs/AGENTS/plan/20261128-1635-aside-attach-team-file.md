# An app on the computer (Aside) attaches a team file to a page

- Date (UTC): 2026-11-28 16:35
- Branch: `fix/aside-attach-team-file`
- Status: done
- Where: server (integrations/connections, realtime, routes). Why: the AI's connection tools and their checks live
  there (see docs/REPOSITORY-RULES.md)
- Version impact: minor (an app on the computer can now attach team files: a new route and a new ability of the
  existing Aside and ego lite connections)

## Goal

The owner asked Trina, driving Aside, to attach a team quote PDF to a mail written in Daum web mail. Trina said
"Aside cannot fetch team files … no way to put the PDF in the attachment field". It worked before through the desktop
app's browser (`file_upload`, #652). The owner wants it in Aside too.

Diagnosis (origin/dev de300ac60): not Aside's permission mode, and not a missing Aside tool. Aside's repl has a
cookie-less `fetch`, `Buffer` and Playwright's `setInputFiles` (checked on this Mac: a list of `{name, mimeType,
buffer}` works, a single object does not). Trina blocked it on purpose:

- `ATTACH_HOW` (team-attach.ts) told the AI "Apps on the user's computer (Aside, ego lite …) cannot attach one, a web
  mail opened there included: say so before you start, never promise it";
- `handleAsCode` + `LOCAL_NO_TEAM_FILES` (tools.ts) refused any `team-file:` handle given to Aside's repl or exec
  ("a team file cannot be attached through it"), as decided in 20261126-shared-chat-own-tools.md and kept in
  20261126-browser-file-upload.md.

## Scope

In:
- The AI writes `"team-file:<path>"` in quotes where the app's code or task downloads the file. After the card and the
  files' last check the server puts a one-time download link there; the app downloads it and sets it on the page.
- The link: in memory, 32 random bytes, the exact checked bytes, one download, at most 10 minutes and never past the
  turn, checked again (access now, unchanged, not held) before the bytes go; every failure the same 404; audited by
  path, size and hash; masked in the request log. The AI never sees the link (the app's answer gets the handle back).
- The address: the team page origin of the desktop window the call goes to (the computer reaches the server there),
  else the first configured public origin.
- Instructions: ATTACH_HOW no longer says it is impossible; ATTACH_HOW_LOCAL (only where such an app is offered) says
  how, with the Aside repl pattern. A handle without quotes in the middle of code is refused with how to write it.

Out: a desktop-side download into Aside's folder (needs a desktop release); a permanent or public link.

## Steps

1. `local-file-links.ts`: handle finder, swap in and out, the link store, the route handler.
2. Hub keeps each window's checked Origin; LocalRelay holds the links; `GET /team-file-links/:token`.
3. tools.ts: replace the refusal with the link path, reusing the mail attachment's reads, cards and rechecks.
4. Tests, decision file, changes note; QA with Aside's repl on a local page.

## Decisions

`docs/decisions/20261128-local-app-team-file-links.md`. Changes "apps on the computer such as Aside still cannot
attach" of 20261126-browser-file-upload.md and the rule of 20261126-shared-chat-own-tools.md.

## Risks

No migration. Security: the link is a bearer URL that goes to the person's own app on their own computer, only for a
file they may read, only after the connection's card (or their Always allow), single use, short-lived. A shared chat
keeps its read check on the files. A scheduled run attaches nothing (unchanged).

## Tests

`bun run typecheck`, `bun run check:prepush`, `bun run check:i18n`, `tests/unit/c-local-file-links.test.ts`,
`tests/unit/c-local-apps-shared.test.ts`, `tests/unit/c-integration-deferred-tools.test.ts`, `tests/unit/server-app.test.ts`.

## Result

Built as planned. QA: Aside repl on this Mac downloaded a team PDF through a one-time link from a local server copy
and set it on a local compose page's file field (screenshot in the PR); a second download got 404.
