# A lighter "send to a room" card

- Date (UTC): 2026-11-17 15:27
- Branch: `fix/send-to-room-card`
- Status: in progress
- Where: component B chat tools (`server/src/chat/post-to-room.ts`, `server/src/chat/i18n.ts`) and the web card
  (`web/src/components/chat/AskCard.tsx`). Why: the card and its words are built there (see docs/REPOSITORY-RULES.md)
- Version impact: patch (the same card with fewer words and choices; no new setting, table or screen)

## Goal

QA TC-4791 (manual AI tests MAN-013, 014, 015, 033): when the AI in a side chat posts to a room, the card is heavy: a
long question with counts ("2 people can't open 1 linked file. With the files, everyone there can see it…"), a size
("87 characters"), four radio choices (Send / Send with the files / Always send with the files / Don't send), the
room-read warning even when the only room read is the one posted to, and raw `**` in the preview. Office workers should
see one plain question, who cannot open the file, and two buttons.

## Scope

In:
- One line: "Send to General (3 people)?".
- When some people there cannot open a linked or attached file: who, by name ("Maria and Tom can't open the file yet;
  sending shares it with them"). Send goes with the files (the copies, or the view the card already grants).
- Two choices, Send and Don't send, plus the quiet "Always allow" every other server card has (same buttons, same note).
- The "why this asks" line moves under the buttons (the card still shows); no such line when every room this chat read
  is the room the post goes to (server logic: the chat's read scope and side room).
- The preview is formatted with the chat's Markdown renderer (no size); plain text stays where the text has a web
  address or a long random-looking part (what goes out must be visible).

Out: the save card and save logic (another branch), when the card shows at all (explicit ask, Always allow, approvals).

## Steps

1. Server: the default choice, the names line, the note, the same-room rule, the detail's `markdown` flag.
2. Shared: `ConfirmDetail.markdown`. Web: render it with `Markdown` (LazyMarkdown) in `DetailText`.
3. i18n in six languages; tests (`b-post-to-room`, `c-who-can-open`, the mock and its e2e spec).
4. Decision file, changes fragment, screenshots before/after.

## Decisions

docs/decisions/20261117-send-to-room-card-two-buttons.md

## Result

(filled in at the end)
