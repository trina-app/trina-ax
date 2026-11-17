# Voice input shows the words while the person is still talking

- Date (UTC): 2026-11-17 01:43
- Branch: `feat/voice-live-text`
- Status: in progress
- Where: trina-ax `web/src/lib` (voice input), `shared/src` (the piece cutter and sender, moved from the desktop app),
  `server/src/jobs` + `server/src/routes/jobs.ts` (a voice input piece path). Why: voice input is Team AX core (chat,
  rooms, AI connection); the meeting-notes pieces (#1149, #1155) are already there to reuse.
- Version impact: minor, a user-visible change to voice input and a new endpoint.

## Goal

Today a recording goes to the server as one file after Stop (POST /api/transcribe, one job, one OpenRouter request).
On a hosted team (OpenRouter) a two-minute recording shows nothing until the end and then waits for the whole upload
and request. Owner 2026-11-17: send pieces while recording, so the first words appear in the message box within a few
seconds; Stop means done (the last piece, then finish), no "Try again" and no new states.

## Scope

In:
- Chats and rooms (`useVoiceInput`, `VoiceBar`, `Composer`, `RoomComposer`) when the team's voice input goes to
  OpenRouter (`Me.team.voiceInputOutside`).
- The browser takes the microphone's sound as 16 kHz samples and cuts it at pauses with the meeting cutter (Yogurt
  rules, MIT, NOTICE): a piece ends at 1 s of quiet or 15 s; the first piece of a recording at 5 s, so words show
  early even when the person talks without a pause.
- Each piece goes to a new `POST /api/transcribe/piece` as it closes (at most two at a time, retries by reason as
  meeting notes do). Its words go into the box in recording order, even when answers come back out of order.
- Stop: the last piece goes out, the box waits for the rest (the spinner on the mic as today), then it is done.
  Esc / ✕ throws everything away and puts the box back as it was, as today. A refusal (free hours used up, a
  confidential chat) ends the recording with its sentence, and the words already heard stay.
- Server: the piece path is the meeting piece code generalized (`meetingPiece` → a shared piece runner with a `use`):
  the same checks as voice input today (the chat is the caller's, confidential chats never go to OpenRouter, Safe
  operations 1A), the same OpenRouter call through the hosted free-hours meter (seconds of sound, as today), a per
  person limit (pieces at once, pieces and seconds of sound a minute), the piece on disk (multipart) and deleted after.
- Move `desktop/src/common/meeting/chunker.ts` and the session (`MeetingSession`) to `shared/src/speech-pieces.ts`;
  the desktop files re-export them. The session gains an optional in-order callback.

Out (later):
- Office Macs and servers that run whisper.cpp themselves keep today's whole-file job (one whisper at a time, the
  first-use model download with its progress, the speed check). The server's piece path already runs whisper too, so
  turning it on there is a client switch once the plan's small q8_0 and Silero VAD are checked on x86 (the STT plan,
  step 1). Not cheap to check today, so left out.
- A language hint per recording (each piece is detected on its own, as meeting notes are).

## Steps

1. Plan (this file), first commit.
2. `shared/src/speech-pieces.ts`: chunker (+ `firstMaxMs` option) and the session (+ `onOrdered`), desktop
   re-exports; tests move with them.
3. Server: `TRANSCRIBE_PIECE` endpoint in `shared/src/api/jobs.ts`; `meeting-piece.ts` runner with `use: 'voice'`
   (own in-flight key, rate window, no meeting speed check); route; tests.
4. Web: `recorder.ts` taps 16 kHz samples (no MediaRecorder in live mode); `lib/liveDictation.ts` (session, send,
   ordered words, finish, cancel); `voiceInput.ts` live finish; `useVoiceInput.ts` wiring; the words heard show above
   the bar where the box is hidden while recording.
5. i18n (all languages), `changes/voice-live-text.md`, decision file, tests, review, UI check, QA rows, PR.

## Decisions

- `docs/decisions/20261117-voice-live-text.md`: voice input on OpenRouter teams sends pause-cut pieces while
  recording; local whisper keeps the whole-file job for now.

## Risks

- No migration. One new endpoint (auth user, multipart, at most 15.5 s WAV).
- Cost: every piece is metered by its seconds of sound (as one request is today); a piece with too little clear sound
  is not sent (the cutter's MIN_CLEAR_MS), so silence costs nothing.
- Confidential chats and Safe operations 1A: checked per piece, before the sound is read.
- Phones: ScriptProcessor (deprecated but in every browser and WebView; an AudioWorklet module would need a script
  URL the CSP allows). Five app languages + zh.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, unit tests: the chunker and session (moved), the
piece endpoint (voice: confidential, meter, rate limit, file deleted), `liveDictation` (order, finish, cancel,
refusal), `voiceInput` live finish; web e2e voice specs; ui-polish screenshots 1440/390 light/dark.

## Result

(filled in at the end)
