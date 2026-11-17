# Live voice input: first words sooner, and a language hint

- Date (UTC): 2026-11-17 08:45
- Branch: `feat/voice-first-words`
- Status: in progress
- Where: trina-ax `shared/src/speech-pieces.ts`, `web/src/lib` (voice input), `server/src/jobs` (piece runner,
  OpenRouter call). Why: the follow-up to live voice input (#1180), same code.
- Version impact: patch, voice input answers sooner; no new endpoint or setting.

## Goal

Measured on qa.trina.app with OpenRouter after #1180: first words 5.4-5.9 s after the mic (the first piece cut at about
4.2 s, the answer 1.3-1.6 s). The owner wants about 3-4 s. A short first piece also risks whisper hearing the wrong
language.

## Scope

In:
- The first piece ends at the first short pause (300 ms) once 1.5 s were said, else it is cut at 2.5 s (its cut looked
  for in its last second). Later pieces unchanged (1 s pause, 15 s).
- Every piece names the app's language (the person's, else the team default) as a language hint; the server passes it
  to OpenRouter (and whisper.cpp). It is only a hint: a provider that refuses the field (400) gets the piece without
  it; an answer whisper is very unsure of (below -0.6) or only the "foreign language" caption is sent once more without
  the hint, kept only when whisper is sure of it and it is in its own script; the answer then says `hinted: false` and
  the rest of that recording goes without the hint.
- Limits: unchanged (two at once, 40 pieces and 120 s of sound a minute); a test checks a minute of dictation with the
  short first piece stays well inside them.

Out: meeting notes keep their cutter and their 400 handling.

## Steps

1. Cutter options `firstMinMs` / `firstPauseMs`, voice input's constants (2.5 s / 1.5 s / 300 ms).
2. `language` on each piece from the app; `hintOnly` in `sendToOpenRouter`; the doubtful-answer retry in the runner.
3. Tests (cutter, server hint cases, limits, web timing, e2e hint), review, measure on qa.trina.app (few recordings:
   the key has a $5 cap).

## Decisions

`docs/decisions/20261117-voice-language-hint.md`.

## Risks

A person who dictates in a language other than the app's: their first hinted piece may be translated; the retry
catches it when whisper is unsure, and the hint stops after the first answer in another language. One extra request
(metered) only for such pieces.

## Tests

`bun run check:prepush`, `tests/unit/speech-pieces.test.ts`, `tests/unit/c-voice-piece.test.ts`,
`web/test/unit/liveDictation.test.ts`, `web/test/e2e/voice.spec.ts`.

## Result

(filled in at the end)
