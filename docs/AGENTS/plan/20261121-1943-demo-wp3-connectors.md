# Free-roam demo: practice send cards, no fake Drive links, Gmail words in the user's language (WP3)

- Date (UTC): 2026-11-21 19:43
- Branch: `fix/demo-wp3-connectors`
- Status: done
- Where: server/ (connections cards and steps, the Google library's tool words, Drive results, save_connector_file).
  Why: the card, the step and the Drive result are made on the server (docs/REPOSITORY-RULES.md)
- Version impact: patch, user-visible fixes to card and step words and to demo Drive results, no API or data change

## Goal

Free-roam demo QA 2026-11-22 (F1, F2, F4):

- F1: the AI links "open it" to `drive.google.com/file/d/tracker/view`, a real Google 404, because Drive results carry a
  web link built from the fake file's id.
- F2: the demo's send-mail card never says it is practice, and offers "항상 허용" with the note about every change at
  Gmail.
- F4: steps and cards show the library's English titles ("Gmail · Search Gmail Messages", "…보내려고 해요: Send Gmail
  Message") and raw field names ("Thread id", "In reply to").

## Scope

In:
- F1: `google-drive/client.ts` exports `demoGoogleOn()` (the fake Google is set). `read.ts` leaves out `webViewLink` on
  search, list, the shared roots and `driveOriginal` while it is on. `save-connector-file.ts`: with no link, the saved
  file's source is `Google Drive: <name>` (never a bare file name, review M8).
- F2: on a demo server with fakes (`activeDemoFakes()`), a send card for a connection the fakes answer (a Google
  Workspace library row, or a `mcp.higgsfield.ai` connection; review M7) starts with one practice line. On a demo server
  the card is the plain Send / Don't send card (no Always allow, no note). Real servers' cards stay byte-identical.
- F4: `text.ts` `GOOGLE_TOOL_WORDS` (Gmail, 6 languages; the words live in the language table, not in catalog.ts); `toolTitle(tool, L?, kind?)` uses them for a Google library row;
  the step (`stepOf`) and the card's `what` get the locale. Mail field words (`thread_id`, `in_reply_to`,
  `references`) only on a Google library row's card, so a Slack `thread_id` or another service's `references` keeps its
  own words.

Out:
- The demo prompt line about Drive files (WP5). Calendar, Docs and Sheets tool words (fall back to the library title).
- #282's files (demo-banner, fakes/banners, higgsfield, prompt.ts, tools/index.ts) and web/src/i18n.

## Steps

1. Plan and changes note (this commit).
2. client.ts, read.ts, save-connector-file.ts (F1).
3. text.ts `practiceLead`, `MAIL_FIELD_WORDS`; card-lines.ts `toolTitle`, `fieldWord`, `cardLines` extra words;
   text.ts `GOOGLE_TOOL_WORDS`; tools.ts gate, stepOf, argLines (F2, F4).
4. Tests: tests/unit/connection-card-demo.test.ts, tests/unit/google-tool-titles.test.ts.

## Risks

- Real customers see the new Gmail titles and field words on cards and steps. Intended: plain words in their language
  instead of the library's English catalog title and "Thread id".
- A demo file that later adds a real connector: it gets the normal card (no practice line), only without Always allow.

## Tests

`bun run typecheck`, `bun run check:prepush`, `bun run check:i18n`, connection / Gmail / Drive unit tests, every
tests/unit/*demo*.test.ts.
