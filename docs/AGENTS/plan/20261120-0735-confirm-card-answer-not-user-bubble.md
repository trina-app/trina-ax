# A card's answer shows as a quiet line, not as a message the person wrote

- Date (UTC): 2026-11-20 07:35
- Branch: `fix/confirm-card-answer-not-user-bubble`
- Status: done
- Where: server/src/chat (open-questions, store), shared/src/api, web/src/components/chat. Why: the answer of a waiting
  card is a chat message of the core chat (docs/REPOSITORY-RULES.md: chat goes in the core first)
- Version impact: patch: a display fix of existing cards; one optional field on Message, no migration

## Goal

The owner pressed 열기 on two "확인해 주세요" website cards (tools/url-gate.ts askConfirm). The chat then showed one big
right-hand bubble with their name and picture holding both cards' whole question text, each followed by "열기", as if
they had typed it. Root cause: since docs/decisions/20261119-safety-cards-wait.md a waiting card's answer starts the
next turn with a user message whose text is `answerText` (chat/open-questions.ts): with several cards, each card's
question then its button's words. The web draws every user message as a bubble (Messages.tsx UserMessage), so the
card text came back as the person's words; in a shared chat everyone reads "dion: …", and it is in search.

## Scope

In:
- A card answer's user message keeps only the buttons' words (no question text) when no answer was typed.
- Message gets `cardAnswer: { choices }` for a user message that only answers cards (buttons or Skip, never typed
  text), from `answered_questions`; old chats' safety-card answers (their saved call) are recognised the same way.
- The web shows such a message as one quiet line under the asking answer ("선택함: 열기 · 열기"), with the name in a
  shared chat, no bubble, no edit.
- The AI keeps getting the answers as before (`<answered_questions>`, the replayed calls' results).

Out: rewriting the text of old stored messages (search keeps their old text); typed answers stay bubbles (the
person's own words).

## Steps

1. open-questions.ts: answers record the shown words and whether they were typed; the message text drops questions.
2. store.toMessage: `cardAnswer` from answered_questions; shared schema field.
3. web UserMessage: the quiet line; i18n keys in every language.
4. Unit tests (b-safety-cards-wait / b-open-questions) and a web test; screenshots at 1440 and 390 (ko, mock).

## Decisions

none (follows docs/decisions/20261119-safety-cards-wait.md; only the answer's look and text change).

## Risks

Shared chats with hidden labels keep "(AI의 질문에 답함)". Phone app is the web view: same component.

## Tests

`bun run typecheck`, `bun run check:prepush`, tests/unit b-open-questions and b-safety-cards-wait, web component test.

## Result

Built as planned. The one path where a card's answer becomes a message is chat/open-questions.ts (the AI's ask_user
and the safety cards that wait after the answer: website, save_url, delete, share, stop sharing, browser site); every
other card waits inside its tool call and its answer stays on the step, never a message. That path now saves each
answer's words (`shown`), the message text drops the cards' questions when nothing was typed, and Message.cardAnswer
marks it; the web draws one quiet line (Messages.tsx CardAnswerLine) in the personal chat, the shared chat (with the
name), the room side chat, the desktop app and the phone. Older answers are recognised from their saved answers
(safety cards always; AI questions when the shown words are not the saved value). Old messages keep their stored text
in search.

