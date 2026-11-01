# Recorded OpenRouter speech-to-text answers

`openrouter-answers.json` holds answers of OpenRouter's `POST /api/v1/audio/transcriptions` (`openai/whisper-large-v3-turbo`, `response_format: verbose_json`) recorded on 2026-11-01 for the STT test of the hosted plan. Only the language, the duration, the provider that served the request and each segment's start, end, text and `avg_logprob` are kept.

The sound was made with macOS `say` and ffmpeg: fictional meetings (Korean, English, Korean and English mixed, Japanese), no customer data. `qa-meeting-*` is the QA team's 13-minute test recording (sections of about a minute, Korean and English in turn) in its two pieces (0:00–10:00, 10:00–13:11), sent without a language and told `ko`; `qa-cNN` are its 30-second pieces, the same two ways. `Groq` answers name the language (`"Korean"`); DeepInfra's give the code (`"ko"`).

Used by `tests/unit/speech-language.test.ts`. The tests never call OpenRouter.
