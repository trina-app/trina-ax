# Live voice input names the app's language as a hint, and drops it when whisper doubts it

- Date: 2026-11-17
- Status: accepted
- Supersedes: none
- Branch: feat/voice-first-words (the owner, after measuring #1180 on qa.trina.app)

Plan: docs/AGENTS/plan/20261117-0845-voice-first-words.md. Follows docs/decisions/20261117-voice-live-text.md.

- **Ask:** first words in about 3-4 s (they took 5.4-5.9 s), without a short first piece being heard as another
  language.
- **Rule:** the first piece ends at a 300 ms pause after 1.5 s of speech, or by 2.5 s. Each piece sends the app's
  language (the person's, else the team's) as `language`. The server sends it to OpenRouter with `hintOnly`: a 400 sends
  the piece again without it; an answer only "(foreign language)" or below -0.6 mean avg_logprob (a 2 s piece in the
  right language often scores near -0.4) is sent once more without the hint, and that answer is kept only when it is
  sure (UNSURE_LOGPROB), surer by 0.2 and written in its own language's script. Such a second request is metered like
  any other (OpenRouter bills it). The answer then says `hinted: false` (also after a 400), and the app sends the rest
  of that recording without the hint. whisper.cpp never gets voice input's hint (told a language it translates).
- **Why:** whisper told a language the speaker did not use translates (speech-language.ts measurements), and is
  unsure of it (avg_logprob -0.48 to -2.3 against -0.04 to -0.36 for transcripts), so doubt is the signal to retry.
- **Left out:** a per-person "I dictate in" setting; meeting notes keep their own handling.
- **Tests:** `tests/unit/c-voice-piece.test.ts` (hint, retry, 400, limits), `tests/unit/speech-pieces.test.ts`.
- **Version impact:** patch.
