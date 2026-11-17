# Voice input: noise or a beep says "Nothing was recognized", not a stray word

- Date (UTC): 2026-11-17 07:45
- Branch: `fix/voice-no-speech`
- Status: done
- Where: `server/src/jobs/`. Why: the stray words come from the speech model on the server, so the server decides
  that a recording had no speech (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a bug fix with no new setting or API

## Goal

QA TC-4581: voice input on silence, room noise or a beep put a word such as "you", "(beep)" or "Thank you." into the
message box. Whisper writes such words when it hears no speech. The person should see "Nothing was recognized"
(`voice.empty`), which the web app shows when the server answers with no text (a whole recording) or no lines (a
piece while the person talks).

## Scope

In: the voice input paths and meeting pieces on both providers: `transcribe` (local whisper.cpp, a whole recording),
`transcribeOpenRouter` (a whole recording), `speechPiece` (a piece: voice input while talking, desktop meeting notes).
Out: video and audio reads of files (their transcripts keep what they have); the client side of a recording with no
sound at all (PR #1182).

## Steps

1. A small module `server/src/jobs/no-speech.ts`:
   - `soundOf(wav)`: from a 16 kHz mono 16-bit WAV (the server's own conversion, or the app's piece), the loudest
     20 ms frame, the seconds with sound, and whether the sound moves like speech (the level and the zero-crossing
     rate of its frames vary; a tone or steady noise stays flat). No new dependency.
   - silent (the loudest frame under -60 dBFS): the model is not run and nothing is sent to OpenRouter.
   - `keepSpeech(result, sound, unsure)`: drops whisper's marks for sound with no words ("(beep)", "[BLANK_AUDIO]",
     "♪"), then says "no speech" when the sound is weak (quiet, or not speech-like) and whisper was unsure of it, or
     when the whole result is a known whisper hallucination ("you", "Thank you.", "Thanks for watching!", subtitle
     credits, in six languages) on weak sound. A real "Thank you" spoken by a person moves like speech and is kept.
2. Whisper's own signals: whisper.cpp's JSON with `-ojf` gives each token's probability; the first word's
   probability is low on noise ("you" 0.14, garbage on hum 0.06) and high on speech. whisper-cli 1.9.5 does not
   write its no-speech probability. OpenRouter's `verbose_json` segments carry `avg_logprob` and, from providers that
   give it, `no_speech_prob`: a segment over 0.6 with `avg_logprob` under -1 is dropped (whisper's own rule), and either
   signal marks the answer unsure.
3. Tests first (`tests/unit/no-speech.test.ts`, plus a fake whisper-cli / fake OpenRouter case in the piece tests).

## Decisions

None.

## Risks

Dropping real words. The deny-list only matches a whole result, only on weak sound; the unsure rule needs both weak
sound and an unsure model. Thresholds measured on generated tones, noise and speech (macOS `say`) with the small model.

## Tests

`bun run typecheck`, `check:i18n`, `check:docs`, `check:prepush`, the speech unit tests under Bun 1.3.12, and a real
whisper.cpp run on a beep, noise and silence.

## Result

Built as planned in `server/src/jobs/no-speech.ts`, used by `transcribe`, `transcribeOpenRouter` and `speechPiece`.
whisper-cli now runs with `-ojf` (token probabilities); `parseOpenRouter` drops the lines whisper's own no-speech rule
drops (this also applies to file reads through OpenRouter, the same rule whisper.cpp applies locally). Real runs
(whisper.cpp 1.9, generated sound and macOS `say`): before, the small model wrote "you" on silence, "(beep)" on a beep,
letter loops on noise, and the tiny model "Thank you for watching!" / "Thanks for watching." on white noise; after, all
of them give no text, and "Yes", "Thank you.", "네." and a quiet sentence are kept. Not tested for real: OpenRouter
(no key on the test Mac; covered by a fake with verbose_json fields).
