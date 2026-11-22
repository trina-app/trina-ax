# Shared chats: two people asking for opposite changes are asked, not silently overwritten (S-125)

- Date (UTC): 2026-11-22 08:09
- Branch: `fix/s125-conflicting-requests` (off `batch/20261122-i`)
- Status: in progress
- Where: server/src/chat (prompt.ts, runtime.ts, open-questions.ts, turn.ts). Why: QA S-125 (cases-v2). In a shared
  chat 이서연 asked "표지 파란색으로", the AI asked her a question card, 김민지 then asked "빨간색으로". Her message
  closed 이서연's card without a word, the AI made it red and wrote "이전 질문의 파란색 요청은 반영하지 않았고",
  naming nobody. The blue request was lost and only 김민지 was asked anything.
- Version impact: patch. A fix to how the AI behaves in shared chats; no new feature, no API or data change.

## Goal

When a new request in a shared chat contradicts an open or recent request from a different person on the same
thing, the AI names both people and what each asked, and asks which to keep (keeping both as versions is one
choice). If both are already done, it says so and names each version. It never silently drops one. It does not ask
when the same person refines their own request, or when the edits do not conflict (owner: fewer questions).

## Scope

In:
- The history already labels each message with its writer (chat/shared.ts labelledTranscript). Check that it does
  this for the case (another person's turn always starts a fresh session with the labelled history).
- Structural signal, cheap: when a person's message closes another person's still-open ask_user card (createTurn
  closes every open card in the chat), the new turn's message gets a short `<closed_question>` note that names whose
  card it was and what it asked. Today that request just disappears.
- One general line in the shared-chat section (prompt.ts sharedSection) about opposite requests from different people.
  It must agree with the "ask less" rules on fix/ask-less (ACT_FIRST_RULE: ask only when a choice reaches other
  people / has no sensible default). This choice decides between two people, so it fits.
- Tests: the prompt line, the note (closed by someone else; not for one's own card, an answered card, or a private
  chat). Prompt pins updated if they change.

Out: server-side detection of "same target" (needs language understanding; the AI does it). Mentions or
notifications to the other person (the answer is already seen by everyone in the chat).

## Steps

1. open-questions.ts: closeChatQuestions also returns the card's question text (ask_user).
2. runtime.ts createTurn: in a shared chat, the cards of other people it closed without an answer go on the TurnSpec
   (`closedOthers`: name and question). turn.ts puts a `<closed_question>` note in front of the message.
3. prompt.ts sharedSection: the conflicting-requests line.
4. Unit tests, prompt pins.
5. Real A/B with claude-code on a private QA copy: S-125 twice before and after, plus two sequential non-conflict
   edits (same person refining; different people, different things) that must not ask.

## Decisions

- The question goes in the answer text, not on an ask_user card: a card reaches only the asker, and the other person
  must see and be able to answer it too.
- Not lost after a restart only as far as a queued turn's spec is kept in memory: a turn rebuilt after a restart has
  no note (the rule in the instructions still applies). Acceptable for a hint.

## Result

(filled at the end)
