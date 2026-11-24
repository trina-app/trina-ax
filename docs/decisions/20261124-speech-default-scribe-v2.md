# ElevenLabs Scribe v2 is the default speech model

- Date: 2026-11-24
- Status: accepted
- Supersedes: the "Default" rule of [20261123-speech-scribe-v2](20261123-speech-scribe-v2.md) (whisper turbo stays the
  default)
- Branch: feat/stt-default-scribe-v2

- **Ask:** the owner, 2026-11-24, after a voice message that mixed Korean and English: "STT isn't good still". Whisper
  turbo wrote "러스트" for "Pras", "提人" for "tier" and "Amen" for "And then".
- **Rule:** `DEFAULT_SPEECH_MODEL` and `HOSTED_SPEECH_MODEL` are `elevenlabs/scribe-v2`. A team that saved a model in
  Team settings keeps it; whisper turbo stays in the suggestions.
- **Privacy:** OpenRouter lists `elevenlabs/scribe-v2` on ElevenLabs as a zero data retention endpoint
  (`/api/v1/endpoints/zdr`, checked 2026-11-24), so the request rules of 20261123 stay as they are.
- **Order:** the hosting key's guardrail at OpenRouter (`CP_STT_GUARDRAIL_ID`, trina-cloud) allows only whisper on
  DeepInfra or Groq. It must also allow `elevenlabs/scribe-v2` on ElevenLabs before a release with this change reaches
  hosted teams. Allowing it first is safe: whisper stays allowed.
- **Cost:** $0.22 an hour of sound against $0.012 (about 18 times). A hosted team that uses its 10 free hours costs about
  $2.20 a month instead of $0.12.
- **Version impact:** minor.
