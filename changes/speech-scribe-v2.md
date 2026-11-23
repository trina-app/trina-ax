- Voice input can use ElevenLabs Scribe v2: an admin with the team's own OpenRouter key can pick
  `elevenlabs/scribe-v2` in Admin › Team settings › Voice input (the field now suggests it). It was refused with
  "HTTP 404". The default stays whisper large-v3 turbo until the hosted speech key allows Scribe v2.
- A speech model that OpenRouter cannot run with zero data retention now says so and names a model that works, in
  place of "OpenRouter refused the request (HTTP 404)".
