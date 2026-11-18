# People's messages keep their blank lines as typed

- Date: 2026-11-18
- Status: accepted
- Supersedes: none (adds to [Markdown in people's messages](../DECISIONS.md#markdown-in-peoples-messages-fixmarkdown-in-messages-2026-11-12-the-owner-qa-tc-072))
- Branch: fix/message-blank-lines (the owner, QA TC-4964)

- **Ask:** the owner typed "hei", a blank line, "I test", two blank lines, "you" in a room. The message showed the three
  lines evenly spaced. It should show what was typed, one empty line and then two, as Slack does.
- **Cause:** a person's message is Markdown (PersonMarkdown). A line break was kept as `<br>`, but any run of blank lines
  ended a paragraph, and a paragraph gap in a message was 4 px (`prose-p:my-1`): one blank line and ten looked the same.
- **Rule:** between two neighbouring blocks of a person's message (paragraphs, quotes, lists, code, headings, tables;
  also inside a quote or a list item, and between list items) the message shows the blank lines the source has there,
  each one an empty line of the text's own height (`lib/messageMarkdown.ts keepBlankLines`: a `<div data-blank-lines>`
  of that many `<br>`s, `aria-hidden`; a copy keeps the lines). Between list items the empty lines go at the end of the
  first item, so the next bullet stays on its words. A paragraph in a message has no margin of its own any more: two
  paragraphs always have a blank line between them, now its empty line. Code blocks keep every line inside them, as
  before. No empty line before the first block or after the last (the box trims the message).
- **Long runs:** at most `MAX_BLANK_LINES` = 5 empty lines in a row (`lib/blankLines.ts`). A longer run shows 5. A
  message of thousands of line breaks therefore draws a few empty lines, never a screen of them. It was chosen over
  "keep every one" (a 10,000-character message can be 10,000 empty rows for everyone in the room) and over merging to
  one (that is the bug). 5 covers every spacing people use on purpose. In Markdown the cap is on the count in the
  spacer, so code is untouched; a message too heavy for Markdown (more than 1,000 lines, `tooHeavyForMarkdown`) shows
  its plain words with each long run cut to 5 (`capBlankLines`), code included.
- **Plain surfaces:** the places that show typed text as it is (`whitespace-pre-wrap`) already kept blank lines. They
  now cut long runs the same way: questions in an AI chat and the side chat (`UserText`), waiting messages
  (`QueuedMessages`), a room message being sent (`PendingRow`), replies in a shared chat's answer thread
  (`ChatThreadPanel`), the plain fallback before the formatting code loads (`LazyMarkdown`) and for heavy messages.
- **Unchanged:** AI answers (ordinary Markdown spacing, another component). One-line previews (Activity, notifications,
  a quote's excerpt) join lines as before. The desktop and phone apps show the web app, so they follow.
- **Cost:** one pass over the tree's neighbours, counting at most 6 line breaks per gap; the fuzz test (no message of up
  to 10,000 characters takes 200 ms) and new cases (only line breaks, blank lines between thousands of short lines,
  quotes, lists) pass. `capBlankLines` is one linear regular expression.
- **Tests:** `web/test/unit/message-markdown.test.tsx` (the owner's message, quotes, lists, code, headings and tables,
  caps, timing, edited mark, plain surfaces), `web/test/unit/lazy-markdown.test.tsx`, `web/test/e2e/room-markdown.spec.ts`
  (the gaps measured in line heights in a room and a thread reply at 1440 and 390).
- **Version impact:** patch.
