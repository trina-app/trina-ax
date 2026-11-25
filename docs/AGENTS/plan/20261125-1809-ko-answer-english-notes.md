# A Korean question in an English app: working notes stay out of the answer

- Date (UTC): 2026-11-25 18:09
- Branch: `fix/ko-answer-english-notes`
- Status: in progress
- Where: server/src/chat/narration.ts. Why: the answer script was taken from the app language only
- Version impact: patch, a fix to which text a saved answer holds

## Goal

Night figure eval (dev 8150616b3, F7 run 0): Daniel's app is in English, he asks in Korean, the AI answers in Korean
(answerLanguageLine: the language of the latest message). The saved answer (Message.content, which copy, export, room
send and notifications use) opened with the interim pieces, one of them English: "The 2026 report exists; I'll read
the original press release." narrationScript() returned null for any app language but ko/ja/zh, so neither the
interim rule (20261122, 20261125) nor the English-note hold (20261116) nor the final-answer lead (finalAnswerLead) ran.

## Scope

In: the answer's script follows the person's own words (ownWords: quote lines left out) when they are written in
Hangul, kana or Chinese characters, whatever the app language; a short or mixed message follows the message before it,
else the app language (as before). The same for leadScript. A ko/ja/zh app with a message in another of those scripts
takes the message's script.
Out: the Latin-letters app with a Latin message (unchanged, off); the rules that judge a piece.

## Steps

1. narration.ts: messageScript(); narrationScript() and leadScript() use it.
2. Tests: narration-hold, final-answer-lead (the en-app Korean asserts flip), a turn test through the engine path.
3. Decision file amending 20261116 "Off"; changes file.

## Decisions

docs/decisions/<date>-answer-script-from-message.md (narrows 20261116-answer-no-english-narration.md "Off").

## Risks

An English-app message mostly in Korean that wants an English answer: the existing "asks for another language" rule
still turns it off. Mixed messages with 3+ Latin words and few Korean letters stay off (mostlyLatin).

## Tests

tests/unit/narration-hold.test.ts, tests/unit/final-answer-lead.test.ts, tests/unit/interim-step-view.test.ts,
tests/unit/b-step-text-at*.test.ts, engine tests, web/test/unit.

## Result

(to fill)
