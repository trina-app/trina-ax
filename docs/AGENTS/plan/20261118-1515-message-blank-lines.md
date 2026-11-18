# People's messages keep their blank lines as typed

- Date (UTC): 2026-11-18 15:15
- Branch: `fix/message-blank-lines`
- Status: in progress
- Where: web (web/src/lib/messageMarkdown.ts, web/src/components/Markdown.tsx PersonMarkdown, a small shared helper
  web/src/lib/blankLines.ts for the plain-text surfaces). Why: the one renderer of a person's words and the surfaces
  that show typed text as it is; the desktop and phone apps show the web app, so they follow.
- Version impact: patch, a display fix

## Goal

QA TC-4964: in a room the owner typed "hei", a blank line, "I test", two blank lines, "you". The message showed the
three lines with the same small gap: a blank line and two blank lines looked the same. People expect what they typed,
as Slack shows it.

Cause: PersonMarkdown reads the words as Markdown. A single line break is kept (`<br>`), but one or more blank lines end
a paragraph, and a paragraph gap in a message is 4px (`prose-p:my-1`), so any run of blank lines became one tiny gap.

## Scope

In:
- Room, DM and thread messages and linked-message cards (PersonMarkdown): each blank line between blocks is one empty
  line of the text's height, between paragraphs, inside quotes and list items, and between list items. Code blocks keep
  their lines exactly as before. Lists, quotes, links, mentions and the rest of Markdown render as before.
- The surfaces that show typed text as it is (AI chat and side chat questions, waiting messages, a room message being
  sent, shared-chat thread replies, the plain fallback of a message too heavy for Markdown): they keep blank lines
  already; a long run is capped the same way.
- A run of blank lines is capped at MAX_BLANK_LINES (5) empty lines, so a message of thousands of line breaks draws a
  few empty lines, not thousands of rows.

Out: AI answers (normal Markdown spacing, a different component). One-line previews (Activity, notifications, quotes
cut to one line) join lines as before.

## Steps

1. web/src/lib/blankLines.ts: MAX_BLANK_LINES and capBlankLines(text) (no dependencies, safe for the main bundle).
2. lib/messageMarkdown.ts personWords: count the blank lines in the source between neighbouring blocks (root, quote,
   list item, list) and put a spacer of that many `<br>` lines (capped) between them; between list items at the end of
   the earlier item, so the bullet stays on its words.
3. Markdown.tsx PersonMarkdown: paragraphs have no margin of their own (two paragraphs are always split by a blank
   line, which is now a spacer); plain fallbacks cap long runs.
4. The plain-text surfaces use capBlankLines.
5. Unit tests (message-markdown.test.tsx: the owner's example, quotes, lists, code, caps, fuzz timing) and the room
   Markdown e2e spec.

## Decisions

docs/decisions/20261118-message-blank-lines.md.

## Risks

Spacing of every room message changes slightly (no 4px paragraph margin). Phone width and dark theme: checked on
screenshots. No server, migration or i18n change.

## Tests

`bun run typecheck`, `bun run check:prepush`, web unit tests, `web/test/e2e/room-markdown.spec.ts`.

## Result

Filled in at the end.
