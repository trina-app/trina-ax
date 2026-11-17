# Live voice input names the app's language as a hint, and drops it when whisper doubts it

- Date: 2026-11-17
- Status: accepted
- Supersedes: none
- Branch: feat/voice-first-words (the owner, after measuring #1180 on qa.trina.app)

Plan: docs/AGENTS/plan/20261117-0845-voice-first-words.md. Follows docs/decisions/20261117-voice-live-text.md.

- **Ask:** first words in about 3-4 s (they took 5.4-5.9 s), without a short first piece being heard as another
  language.
- **Rule:** the first piece ends at a 300 ms pause after 1.5 s of speech, or at 2.5 s. Each piece sends the app's
  language (the person's, else the team's) as `language`. The server sends it to OpenRouter with `hintOnly`: a 400 sends
  the piece again without it; an answer only "(foreign language)" or below UNSURE_LOGPROB is sent once more without
  the hint and the surer answer is kept (by 0.1 of mean avg_logprob). The app stops hinting for the rest of a recording
  once an answer names another language.
- **Why:** whisper told a language the speaker did not use translates (speech-language.ts measurements), and is
  unsure of it (avg_logprob -0.48 to -2.3 against -0.04 to -0.36 for transcripts), so doubt is the signal to retry.
- **Left out:** a per-person "I dictate in" setting; meeting notes keep their own handling.
- **Tests:** `tests/unit/c-voice-piece.test.ts` (hint, retry, 400, limits), `tests/unit/speech-pieces.test.ts`.
- **Version impact:** patch.
