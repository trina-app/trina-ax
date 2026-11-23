# The default speech model is ElevenLabs Scribe v2

- Date: 2026-11-23
- Status: accepted
- Supersedes: the default model of [Voice input through OpenRouter](../DECISIONS.md#voice-input-through-openrouter-featstt-openrouter-2026-10-28)
  and the hosted model of [Hosted speech-to-text](../DECISIONS.md#hosted-speech-to-text-feathosted-speech-2026-11-01)
  (both `openai/whisper-large-v3-turbo`)
- Branch: feat/speech-scribe-v2 (the owner, 2026-11-23: speech-to-text "is not as good as" other AI chat apps; try
  ElevenLabs Scribe v2. Scribe v3 is not on OpenRouter yet)

Plan: [docs/AGENTS/plan/20261123-0432-speech-scribe-v2.md](../AGENTS/plan/20261123-0432-speech-scribe-v2.md).

- **Ask:** better words from voice input and from video and audio reads, without a new provider contract: the
  speech still goes through OpenRouter.
- **Rule:** `DEFAULT_SPEECH_MODEL` is `elevenlabs/scribe-v2` (`shared/src/api/entities.ts`); the hosting key uses it
  too (`HOSTED_SPEECH_MODEL`). The request is the same `POST /api/v1/audio/transcriptions` (base64 JSON, `language`,
  `verbose_json`, zero data retention, no data collection). Per model (`jobs/openrouter-stt.ts` `speechProviders`):
  `elevenlabs/*` asks only for ElevenLabs and sends ElevenLabs' `tag_audio_events: false`, so no "(laughter)" goes
  into a message box; open whisper (`openai/whisper-large-v3[-turbo]`) still asks for DeepInfra then Groq; any other
  model sends no provider list (OpenRouter picks among its own providers). Before this, every model got whisper's
  list: OpenRouter then had no endpoint for Scribe and answered 404 (measured on a team server, 2026-11-23). A 404
  now says that the model has no zero-data-retention provider (or does not exist) and names Scribe v2:
  `openai/gpt-transcribe` (OpenAI) and `google/gemini-3.5-transcribe` (Google AI Studio) have no ZDR endpoint on
  OpenRouter, and Trina does not drop `zdr`. A 400 to `verbose_json` goes once more as `json` (for whisper only when
  the error names the answer format); after an answer, that model gets `json` until the server restarts. A language in ISO 639-3 ("kor") is read as "ko".
  Admin › Team settings › Voice input suggests Scribe v2 and whisper turbo for a team's own key; any OpenRouter
  model may still be typed. A team that saved Team settings keeps its saved model.
- **Ops (the owner):** the hosting key's guardrail at OpenRouter must allow `elevenlabs/scribe-v2` (keep whisper
  allowed) before a release with this rule reaches hosted servers; until then every hosted speech request is
  refused ("Hosted transcription is not available").
- **Cost:** OpenRouter lists Scribe v2 at $0.0000611 a second ($0.0037 a minute, $0.22 an hour), whisper turbo at
  $0.00000333 a second ($0.0002 a minute, $0.012 an hour): about 18 times more. A hosted team that uses its 10 free
  hours costs about $2.20 a month instead of $0.12. The free-hours meter counts seconds, so it does not change.
- **Why:** Scribe v2 is a newer model trained for many languages, it writes punctuation and mixed Korean and
  English, and it has a zero data retention endpoint on OpenRouter. No measured comparison was made (no key for a
  test); the first QA requests confirm the answer.
- **Left out:** whisper's scores (`avg_logprob`, `no_speech_prob`): Scribe gives none, so the checks that use them
  (`openRouterUnsure`, the long-recording language retry, the voice input hint retry) do nothing for it and send
  nothing twice; the sound checks and the sound-tag filter still apply. Scribe's `keyterms` with team words, text from
  earlier voice input pieces, the voice input hint from the app language, and a plan field for the hosted model are
  follow-ups.
- **Tests:** `tests/unit/c-speech-openrouter.test.ts` (routing per model, the json fallback, the 404 message, an
  answer without scores, ISO 639-3), `tests/unit/c-speech-hosted.test.ts`, `tests/unit/a-speech-settings.test.ts`.
- **Version impact:** minor (a new default model for new and hosted teams).
