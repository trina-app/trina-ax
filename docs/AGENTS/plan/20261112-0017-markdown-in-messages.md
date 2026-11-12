# Markdown in people's room messages (QA TC-072)

- Date (UTC): 2026-11-12 00:17
- Branch: `fix/markdown-in-messages`
- Status: done
- Where: web (components/rooms, components/Markdown.tsx, lib). Why: a UI rule change requested by the owner.
- Version impact: minor — a new user-visible behaviour (people's messages render Markdown).

## Goal

People's messages in rooms, DMs and thread replies render Markdown like the AI's answers (**bold**, *italic*,
`code`, lists, code blocks, [links](https://example.com)), keeping their line breaks, @mentions and plain web addresses
as links. Raw HTML stays text.

## Scope

In: the message body of a person's message (and the note of a shared answer) in RoomMessages.
Out (stay plain): my own questions in an AI chat, quote/reply previews, a message being sent, the edit box,
push/notification text, search snippets, sidebar/inbox previews, copy (⌘C copies the source).

## Steps

1. `lib/messageMarkdown.ts`: a remark plugin for a person's words: mentions are protected before parsing (placeholders
   so Markdown cannot split or eat a name) and come back as the same mention spans; GFM's own autolinks are undone and
   plain addresses use lib/textLinks.ts as today; a line break stays a line break; placeholders inside code, URLs and
   raw HTML go back to the text.
2. `Markdown.tsx` `PersonMarkdown`: the same renderer (react-markdown + GFM, raw HTML as text, the same urlTransform),
   no math, Mermaid fences as code, links through the room link (classifyLink, rel/target as answers), pictures never
   load by themselves (outside: the answer's card; team files: a link).
3. RoomMessages: use it for a person's message instead of the plain `<p>`.
4. Unit tests (XSS cases), e2e room spec, docs comments.

## Risks

Security (XSS, javascript: links, tracking pictures): reuse of the answer renderer with HTML off, tests. Mentions and
links regress: existing room-mentions / room-links tests. Phone width 390.

## Tests

typecheck, check:i18n, check:docs, build:web, test:web; e2e room*, dm*, thread*, mention*, chat.

## Result

Built as planned. `lib/messageMarkdown.ts` also turns footnotes and "#…" links into text (they jumped out of the
room), resolves reference links so they get the same checks, and shows the real address after a link whose words are
(or look like) another site's address. Mentions may follow Markdown marks ("**@Ben**"). Reviewed by an independent
reviewer (approve after two rounds). PR: see the branch `fix/markdown-in-messages`.
