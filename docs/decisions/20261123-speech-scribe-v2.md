# Teams can pick ElevenLabs Scribe v2 for speech; whisper turbo stays the default

- Date: 2026-11-23
- Status: accepted
- Supersedes: none (the default model of [Voice input through OpenRouter](../DECISIONS.md#voice-input-through-openrouter-featstt-openrouter-2026-10-28)
  and the hosted model of [Hosted speech-to-text](../DECISIONS.md#hosted-speech-to-text-feathosted-speech-2026-11-01)
  stay `openai/whisper-large-v3-turbo`)
- Branch: feat/speech-scribe-v2 (the owner, 2026-11-23: speech-to-text "is not as good as" other AI chat apps; try
  ElevenLabs Scribe v2. Scribe v3 is not on OpenRouter yet)

Plan: [docs/AGENTS/plan/20261123-0432-speech-scribe-v2.md](../AGENTS/plan/20261123-0432-speech-scribe-v2.md).

- **Ask:** better words from voice input and from video and audio reads, through OpenRouter as before. On a team
  server, `elevenlabs/scribe-v2` in Team settings gave "OpenRouter refused the request (HTTP 404)".
- **Cause of the 404:** every model got whisper's provider list (`only: ['deepinfra', 'groq']`). Scribe v2 has one
  provider on OpenRouter (ElevenLabs), so OpenRouter had no endpoint for the request.
- **Rule:** the request is the same `POST /api/v1/audio/transcriptions` (base64 JSON, `language`, `verbose_json`,
  zero data retention, no data collection). Per model (`jobs/openrouter-stt.ts` `speechProviders`):
  `elevenlabs/*` asks only for ElevenLabs and sends ElevenLabs' `tag_audio_events: false`, so no "(laughter)" goes
  into a message box; open whisper (`openai/whisper-large-v3[-turbo]`) asks for DeepInfra then Groq; any other model
  sends no provider list. A 404 says that the model has no zero-data-retention provider (or does not exist) and names
  Scribe v2: `openai/gpt-transcribe` (OpenAI) and `google/gemini-3.5-transcribe` (Google AI Studio) have no ZDR
  endpoint on OpenRouter, and Trina does not drop `zdr`. A 400 to `verbose_json` goes once more as `json` (for whisper
  only when the error names the answer format); after an answer, that model gets `json` until the server restarts.
  A language in ISO 639-3 ("kor") is read as "ko". Admin › Team settings › Voice input suggests Scribe v2 and whisper
  turbo for a team's own key; any OpenRouter model may still be typed.
- **Default:** `DEFAULT_SPEECH_MODEL` and `HOSTED_SPEECH_MODEL` stay `openai/whisper-large-v3-turbo` (the owner,
  2026-11-23). The hosting key's guardrail at OpenRouter allows only whisper turbo; a hosted default of Scribe would
  refuse every hosted speech request. The default changes to Scribe v2 in a later PR, after the owner lets the
  guardrail allow `elevenlabs/scribe-v2`.
- **Cost (for a team that picks Scribe v2, and for the later default):** OpenRouter lists Scribe v2 at $0.0000611 a
  second ($0.0037 a minute, $0.22 an hour), whisper turbo at $0.00000333 a second ($0.0002 a minute, $0.012 an hour):
  about 18 times more. A hosted team that uses its 10 free hours would cost about $2.20 a month instead of $0.12.
- **Left out:** whisper's scores (`avg_logprob`, `no_speech_prob`): Scribe gives none, so the checks that use them
  (`openRouterUnsure`, the long-recording language retry, the voice input hint retry) do nothing for it and send
  nothing twice; the sound checks and the sound-tag filter still apply. Scribe's `keyterms` with team words, text from
  earlier voice input pieces, the voice input hint from the app language, and a plan field for the hosted model are
  follow-ups. No measured comparison (no key for a test).
- **Tests:** `tests/unit/c-speech-openrouter.test.ts` (routing per model, the json fallback, the 404 message, an
  answer without scores, ISO 639-3), `tests/unit/c-speech-hosted.test.ts`, `tests/unit/a-speech-settings.test.ts`.
- **Version impact:** minor (a team can now use Scribe v2 and other non-whisper OpenRouter speech models).
