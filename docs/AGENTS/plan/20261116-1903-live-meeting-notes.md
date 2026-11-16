# Meeting notes: the desktop app writes down a call or a meeting as people talk

- Date (UTC): 2026-11-16 19:03
- Branch: `feat/live-meeting-notes`
- Status: draft
- Where: trina-ax `desktop/` (capture, pieces, live words), `shared/src/desktop-bridge.ts` and `shared/src/api`
  (the bridge object and two calls' types), `server/src/jobs/meeting-piece.ts` + `server/src/routes/jobs.ts` (turn a
  piece of sound into text with the team's existing speech setting), `web/` (the entry, the live page, the note). Why: the desktop app, files,
  voice input and the speech setting are core (docs/REPOSITORY-RULES.md); nothing here is Trina-only.
- Version impact: minor. A new desktop bridge object, a new API route and a new page. Older desktop apps and browsers
  do not show the entry; older servers answer 404 and the app hides the entry.

## Goal

People in a Zoom, Google Meet or Microsoft Teams call, or in a meeting room, want the words written down while they
talk, then a clean note afterwards, without a bot joining the call. Today Trina has voice input for one message
(at most 5 minutes, text at the end) and nothing for meetings.

After this, in the Trina desktop app, **Take meeting notes** starts listening to two things at once: the person's
microphone ("You") and the sound of the call coming out of the computer ("Others"). The words show up on a Meeting
notes page a few seconds after each sentence. **Stop** saves the note as a file in My files › Meetings, like a
recording app on a phone saves a voice memo, but as text. No sound is kept anywhere.

The idea comes from Yogurt (github.com/FrigadeHQ/yogurt, MIT): two tracks, cut at pauses, words placed on meeting
time. We take the idea and the pause-cutting rules, not its screens or wording.

## The main choice: where the sound turns into text

The desktop app always captures the sound (the server cannot hear the call). The question is what turns it into
text. Two options, measured against what ships today:

| | **A. On this computer** | **B. Through the team server (picked for P1)** |
|---|---|---|
| What the desktop app adds | whisper.cpp (arm64 Metal build of #1090, a few MB; an x64 build for Intel and Windows) **and** a model download per person: small q8_0 264 MB, or small f16 488 MB | nothing heavy: capture and cutting only (TypeScript in the main process) |
| Memory during a meeting | ~0.6–0.9 GB on the person's computer (whisper.cpp README: small ~852 MB at f16) | ~50 MB in the app; the server does the work |
| Who it works for | Apple silicon Macs first; Intel Macs and Windows need their own builds | every team whose voice input works: hosted (OpenRouter), Office Mac (its whisper-cli, #1090), Linux with OpenRouter. Intel Macs and Windows capture the same way |
| Where the sound goes | nowhere | pieces of sound go to the team server; on hosted teams the server sends them on to OpenRouter (zero data retention, the same as voice input today) |
| Cost | none | hosted: the plan's free hours of transcription (see "Cost" below), about US$0.012–0.04 an hour of sound |
| Signing, releases | two more programs to sign and notarize in the dmg; universal-app merge must skip arm64-only files | none new in the desktop app |

**Pick: B for P1.** The owner asked for the hosted path to be live; B serves every team that has voice input with one
desktop change, needs no 264–488 MB download on each computer, and reuses the server code that already turns speech
into text (below). A stays possible later for teams that need "the sound never leaves this computer" (owner question
2); B's capture and cutting are written so a local engine can be plugged in behind the same interface.

### What is reused from #1090 (feat/mac-local-speech, session trina-ax-59) and from voice input

#1090 is not on `dev` yet (blocked on macOS runners). This branch starts from `dev` and does not need it: on `dev` the
route works with OpenRouter and with a Linux or Homebrew whisper.cpp. When #1090 merges, an Office Mac on Apple
silicon serves meeting notes with its bundled whisper-cli with no change here. Reused, not copied:

- `server/src/jobs/transcribe.ts`: `transcribeConfig()` (on an Office Mac its `whisperBin` is #1090's
  `app/bin/darwin-arm64/whisper-cli`), `modelReady()` and `ensureModel()` (the first-use model download; the meeting
  status call below reports its progress instead of a job), `whisperFile()` for the run, `parseWhisperJson()`.
- #1090's `localSpeechReady()` / `setLocalSpeechReady` and the `speechProvider` default (local first on a ready Office
  Mac): the route reads the same resolved provider as voice input.
- `server/src/jobs/openrouter-stt.ts`: `sendToOpenRouter()` with the app's WAV as it is (routing request, zero data
  retention, `openRouterFailure()` wording, a second try), and through `postAudio()` the hosted meter
  (`server/src/credentials/hosted-speech.ts`). Not `openRouterAudio()`: an isolated ffmpeg per piece (400–700 an hour)
  to make FLAC of ≤ 496 KB is not worth it, and an Apple silicon Office Mac has no ffmpeg.
- `server/src/jobs/whisper-turns.ts` `pieceTurn()`: one whisper at a time on the server. A meeting piece takes the
  same kind of turn as a video read's piece (voice input still goes first; a piece waits at most 20 s, then the app
  sends it again), so meetings neither stop video reads over and over nor hold voice input up. Not `dictationTurn`
  (it waits forever and stops every running piece).
- `server/src/credentials/speech-key.ts` `speechKeySource()` / `readSpeechKey()` and the team setting
  `speechProvider`, as voice input reads them.
- If the STT plan (`20261116-1500-stt-live-text`) moves Linux to small q8_0 (264 MB), meeting notes get it for free.

Not reused, on purpose: #1090's afconvert/avconvert decoding (`server/src/jobs/mac-audio.ts`) and the web
`wavRecording.ts`: the desktop app sends 16 kHz mono WAV already, so nothing is decoded on the server. Not reused:
`files/media.ts` `localSpeed()` (it is measured by video reads only, per model and thread count, and starts at 2.5 s
per second, so a new Office Mac would refuse every meeting); meetings measure their own speed (below).

## Scope

In (P1, macOS 14.4 and later, Apple silicon and Intel; Yogurt's floor, step 0 checks 14.2):
- Capture: microphone + the computer's sound, in the desktop app's main process, as two 16 kHz mono tracks.
- Cutting at pauses (Yogurt's `chunker.ts` rules, ported), pieces of at most 15 s.
- Each piece goes to the team server (`POST /api/meetings/piece`), which turns it into text with the team's voice
  input setting (local whisper or OpenRouter) and returns the lines.
- Live words on a Meeting notes page, placed on meeting time (Yogurt's `liveWords.ts` idea, ported); "You" for the
  microphone, "Others" for the call.
- The mic copy of the call's voice (no headphones) is dropped (Yogurt's `echo.ts` + `echoDetect.ts`, ported).
- whisper's made-up lines over silence are dropped (Yogurt's `hallucination.ts` idea plus the existing
  `[BLANK_AUDIO]` filter).
- Stop saves `My files › Meetings › 2026-11-17 14:00 Meeting notes.md`; a checkpoint every 2 minutes so a crash loses
  little; the app keeps the lines on the computer until the file is saved.
- Auto-stop after 10 minutes with no speech on either track (warned 1 minute before), and at 4 hours.
- The app's own start dialog on every start (what is heard, where the sound goes, "tell everyone"), drawn by the
  app, not the page; the first one is followed by macOS's own questions.

Out of P1:
- P2: an AI summary of the note (a new AI chat in the person's own budget, the note attached); a prompt when a call
  starts and stop when it ends (watch which app holds the microphone); names of speakers from the call app; telling
  "Others" apart (speaker turns).
- P3: Windows (Electron's built-in loopback, documented for Windows).
- Later / owner question 2: option A, on the computer.
- Not planned: keeping the sound, the Mac App Store build (entry hidden there), a bot that joins the call, a floating window over Zoom (owner question 3), a Linux
  desktop build, meeting notes in a browser tab or on
  the phone (they cannot hear the call), partial words that change while someone talks (see "Live words").

## How it works

### 1. Capture (desktop main process)

**macOS.** Two candidate ways; step 0 picks one in half a day on a real Mac with Zoom and Meet. Plan and size for the
Swift helper (way 2): Chromium's `getDisplayMedia` normally needs a video source, which would bring the Screen
Recording question.

1. **Electron's own capture (try first, no new program).** Electron 39 and later use Apple's Core Audio process tap
   for "loopback" sound on macOS 14.2+ (Electron docs, desktopCapturer). A hidden app-owned window (not the team page:
   a page reload must not stop a meeting) calls `getDisplayMedia` and the main process answers with
   `setDisplayMediaRequestHandler(... { audio: 'loopback' })`, plus `getUserMedia` for the microphone. Electron's own
   session docs still say loopback is Windows-only, and whether a video source is required (which would ask for
   Screen Recording, a bigger prompt) is not documented: step 0 checks both. If it needs Screen Recording, we do not
   use it.
2. **A small Swift helper (fallback, Yogurt's way).** `desktop/native/meeting-audio/` built with `swiftc` like
   `menubar/build.sh` (no Xcode project), universal (arm64 + x86_64), signed with the app's Developer ID and hardened
   runtime by electron-builder, notarized with the app (the inherit entitlements already carry
   `device.audio-input`; `mac.x64ArchFiles` names it for the universal merge). It taps the sound of the call apps
   that are running (Zoom, Teams, Webex, Slack, FaceTime, and the browser a Meet tab plays in) with `CATapDescription`
   for those processes and `AudioHardwareCreateProcessTap`, so music or alerts from other apps are not written down as
   "Others"; with no call app running it taps nothing and the meeting is mic only. It reads the microphone with
   AVAudioEngine, resamples both to 16 kHz mono and writes framed PCM on stdout. The main process starts it per
   meeting and stops it (its own PID only). About +300 KB in the dmg.

Either way the app gets two tracks on one clock. Sound is kept in memory only for the piece being cut (≤ 15 s).

**Permissions on macOS (one explanation, the owner's no-extra-popups rule).**
- Microphone: already asked for voice input (`NSMicrophoneUsageDescription`, entitlement
  `com.apple.security.device.audio-input`, both in place). Its text changes to cover meetings: "Voice input and
  meeting notes use the microphone."
- The computer's sound: macOS's **System Audio Recording** permission (Settings › Privacy & Security › Screen & System
  Audio Recording › "System Audio Recording Only"). Needs the new Info.plist key `NSAudioCaptureUsageDescription`
  ("Meeting notes listen to the sound of your calls. The sound is never saved.") in `electron-builder.config.ts` and
  the six `mac-infoplist/*.strings`. No new entitlement for the Developer ID build (hardened runtime, no sandbox).
  macOS asks the first time the tap starts. When it is refused there is **no error**, only silence (Electron docs; dev
  reports), so the app checks the call track for sound in the first seconds of a call and, when the mic hears speech
  but the call track is flat for 20 s, shows one line: "Trina can't hear the call. Allow it in System Settings" with a
  button that opens that settings page.
  The check runs only while a call app is running (the helper knows); an in-person meeting has no call track and
  shows no warning. The settings page is "Screen & System Audio Recording" on macOS 15+ and "Screen Recording" on
  macOS 14.4 (step 0 finds the `x-apple.systempreferences:` link for each).
- The app's start dialog (below) explains both before macOS asks, so the person sees one explanation and then macOS's
  own question once.
- The office kit ships the unsigned `dist:mac` dmg (`scripts/build-office.ts`), so on an Office Mac's own computers
  macOS may ask again after each app update (its permission is tied to the signature). Known; the office docs say so.
  Signing the office kit's dmg is a separate change.

**Windows (P3).** Electron documents `audio: 'loopback'` for Windows (WASAPI loopback). No permission prompt for the
computer's sound; the microphone follows Windows' privacy setting. Same pieces and route.

### 2. Cutting into pieces (`desktop/src/common/meeting/chunker.ts`)

Port of Yogurt's `app/src/main/asr/chunker.ts` rules: a piece ends at 1 s of silence, or at 15 s cut at the quietest
100 ms of its last 2 s; the noise floor is the quietest tenth of the last minute per track, speech is 1.5× that within
-56…-34 dB; pieces with under 300 ms of clear speech are dropped. Each piece carries its track and its start in meeting
time. Pure functions, unit-tested with fixed sample arrays.

### 3. The calls (`server/src/jobs/meeting-piece.ts`)

Two calls in `shared/src/api/jobs.ts` (component C, `server/src/routes/jobs.ts`; no new route module, so
`routes/index.ts` is untouched):

- `GET /api/meetings/status` → `{ state: 'ready' | 'off' | 'too_slow' | 'getting_ready' | 'confidential', modelMb?,
  progress? }`. The app asks it before showing the entry and at Start. An older server answers 404: no entry.
  `getting_ready` starts the first-use model download (`ensureModel`, one at a time) and reports its progress, so the
  first meeting on a local server says "Getting ready (488 MB, first time only)…" instead of failing.
- `POST /api/meetings/piece` (multipart like `/api/transcribe`, so the piece is spooled to disk; one file of at most
  496 KB = 15.5 s of 16 kHz mono 16-bit WAV, optional `language`). Signed-in members only (guests are refused by the
  guest allow-list), CSRF as the other desktop calls, at most 2 pieces under way per person (429).

For a piece the server:
1. Reads the team's `speechProvider`. `off`, or no key, or no whisper-cli → 409 with the person's sentence.
2. Safe operations 1A on (`MYCEL_SAFE_OPS_1A`: every new chat is confidential, sound never leaves the server) and
   the provider is OpenRouter → 403 `confidential`: meeting notes need "On this server" there.
3. `openrouter`: the WAV as it is through `sendToOpenRouter` (the hosted meter counts its seconds).
4. `local`: whisper.cpp in a `pieceTurn` (waits ≤ 20 s for the one whisper, else 503 and the app sends it again).
   The server keeps its own measure of meeting pieces (wall time per second of sound, model loading included, in
   memory): above 0.45 s per second (two tracks may talk at once) the status turns `too_slow` and new meetings are
   refused; a meeting under way goes on and the page says words are coming late. Unmeasured counts as ready (an Office
   Mac with Metal answers a 15 s piece in about a second; a 2-vCPU Linux box measures itself out after a few pieces).
5. Returns `{ lines: [{ start, end, text }], language }`, times in the piece; `[BLANK_AUDIO]`-like lines dropped. The
   WAV is deleted right after. Nothing else is logged.

No job, no WebSocket event, no new table.

### 4. Live words (`desktop/src/common/meeting/lines.ts`)

The main process places each answer on meeting time (piece start + line times; with no changing words there is
nothing for Yogurt's `liveWords.ts` to merge, so it is not ported),
drops echoes (`echo.ts` / `echoDetect.ts` port: the mic's loudness follows the call track at a steady lag → the mic
copy is dropped, the call copy kept) and made-up lines, and sends the line list to the page through the bridge.

No words that change while someone is still talking in P1: on the server path each extra re-read of an open piece is
another paid request (re-reading every 0.8 s costs about 9× the sound), and the Office Mac is shared by the team.
Instead the page shows a soft "…" with the speaker's level while a piece is open; the words land when the speaker
pauses: 1 s after a short sentence, up to 15 s for a long run without a breath, plus 0.5–3 s for the answer.
Option A would allow changing words later.

**Language:** whisper guesses the language of each piece (no fixed language), because a fixed one turns an English
line into Korean in a mixed meeting (`openrouter-stt.ts` notes). The start dialog has no language select.

### 5. The bridge (`shared/src/desktop-bridge.ts`, `MEETING_BRIDGE_VERSION = 1`)

`meeting: { version, state(), start(), stop(), onLines(cb), onState(cb), openSoundSettings() }`.
The page never gets sound, only lines and state (`idle | starting | listening | saving`, elapsed time, which tracks
hear sound, a problem code). The main process re-checks every call (top frame, team origin, like `workFiles`).

**Nothing listens without a click in the app's own window** (the "Find work files" bridge rule, review MUST):
`start()` makes the main process show its own dialog (`dialog.showMessageBox`, not drawn or answered by the page),
with Cancel as the default button, every time. It is the start step itself, not an extra popup:

> **Take notes of this meeting?**
> Trina listens to your microphone and the sound of your call, and writes down what is said. Pieces of the sound go
> to Trina's speech service (OpenRouter) to be turned into text and are not kept. *(On a team's own server: "go to
> your team's server".)* Let everyone in the call know you're taking notes.
> [Cancel] [Start]

While listening, the app draws its own red dot and time in the host bar (the page cannot hide it). The meeting
belongs to the main process: a page reload or a switch to another page keeps it running; switching teams is refused
while a meeting runs ("Stop the meeting notes first").

### 6. The note (web)

At Stop (and every 2 minutes) the page writes the note with the existing file API (`uploadFile`, the person's own
folder, `onExists: 'replace'` so checkpoints do not make "(1)" copies). The folder is `users/<me>/Meetings`, a fixed
name in `shared/src/folder-labels.ts` with a label per language, as `FROM_COMPUTER_DIR` has. The file is
plain Markdown so people can open it anywhere:

```
# Meeting notes, 17 Nov 2026, 14:00–14:42

14:00:05 You: Let's start with the launch date.
14:00:11 Others: We said the 24th, right?
```

The main process also keeps the lines in its data folder until the file is saved (a crash or a lost connection keeps
them; the next start offers "Save the last meeting notes"). Then they are removed.

## What people see (lean UI)

- **One entry:** "Take meeting notes" in My files' header actions on the desktop app (next to the existing "Find work
  files" line, same row style), and in the app menu (File › Take meeting notes, ⌘⇧M). Not shown in a browser, on the
  phone, to guests, in the Mac App Store build, on an older app or server, or when the status is `off`; shown greyed
  with its one-line reason for `too_slow` and `confidential`.
- **Start:** the app's dialog above, every time. The first time, macOS then asks for the microphone (if voice input
  never did) and for the call's sound.
- **The Meeting notes page:** the lines as they come, "You" / "Others", the time, a red dot with the elapsed time and
  **Stop**. Nothing else: no tabs, no summary panel, no speaker editing in P1.
- **While on another page:** the host bar shows a small red dot and the time ("● 12:03"); a click goes back to the
  page. The dock icon shows nothing new.
- **Stop:** "Saved to My files › Meetings" with **Open**. A meeting with no words saves nothing and says so.
- **Words coming late** (the server falls behind): one line under the list, "Words are coming in late. They'll all
  be in the note." Nothing for the person to do.
- **Not added:** a floating window, a waveform, a list of meetings (My files › Meetings is the list), speaker renaming,
  a summary button (P2), a settings page (it follows Team settings › Voice input), any automatic message in the call.

Plain words in the UI: "meeting notes", "your microphone", "the sound of your call", "Trina's speech service
(OpenRouter)" or "your team's server", "free hours of transcription" (the existing Team settings term). Never "STT",
"transcription engine", "loopback", "tap", "chunk", "server is too slow" (instead: "Meeting notes need a faster
setup. Ask your admin." with the admin's detail in Team settings).

## Privacy and consent

- **Sound:** captured on the computer, sent piece by piece to the team server, turned into text and deleted. Never
  written to the person's folder, never kept on the server. With OpenRouter the server sends each piece on, asking for
  zero data retention and no data collection. The hosting key's own guardrail at OpenRouter limits it to DeepInfra and
  Groq (US); with a team's own key that list is only requested, because OpenRouter's transcription endpoint does not
  apply it yet (decision "Hosted speech-to-text"). On an Office Mac with #1090, or a server with whisper.cpp and "On
  this server", the sound never leaves the team's own server.
- **Text:** the note in the person's own folder (private until they share it); it is written there during the meeting
  (checkpoints). Nothing goes to the AI unless the person asks (P2's summary is the person's own action).
- **The others in the call:** recording rules differ by country (some places let a participant record without asking,
  others need everyone's consent, and the EU requires telling people). Trina does not decide this; it tells the person
  in the start dialog every time ("Let everyone in the call know you're taking notes"). The Meeting notes page has
  **Copy a message for the call's chat** ("I'm taking notes of this call with Trina. The sound isn't kept."), which
  they paste into Zoom/Meet/Teams themselves. Nothing is posted into the call by Trina. Not legal advice; the help
  page says so.
- **Admins:** meeting notes follow Team settings › Voice input (off there = off here). Hosted teams have voice input
  on by default, so meeting notes would be on for every member with no separate switch: owner question 1. Audit: none
  per piece (the file's own history is the record).
- **Confidential (Safe operations 1A):** with 1A on, sound never leaves the server, so meeting notes work only with
  "On this server" and are refused (greyed, with the reason) with OpenRouter.

## Cost and limits (hosted teams, OpenRouter)

Measured prices on openrouter.ai (2026-11-16, `openai/whisper-large-v3-turbo`, the default `speechModel`):
DeepInfra US$0.00000333 per second of sound (US$0.012/h), Groq US$0.0000111/s (US$0.04/h); Groq is billed at least
10 s per request (Groq's own pricing page; pieces are often shorter, so a Groq fallback costs up to ~2× its rate).

- A 1-hour call: both tracks, only the parts with speech are sent, roughly 1–1.3 h of sound → about US$0.015 on
  DeepInfra, at most ~US$0.10 if every piece fell back to Groq. Pieces per hour: ~400–700.
- Pieces of up to 15 s keep each request small (≤ 496 KB WAV, ≤ ~250 KB FLAC), far under the 25 MB cap.
- **Free hours:** pieces count against the plan's free hours of transcription (decision "Hosted speech-to-text hours
  per plan": Starter 50, Team 100, Business 200 a month; one pool for voice input and the AI's video and audio reads).
  The risk is that meetings now share that pool: five people with a one-hour meeting every workday use ~100 h a month.
  When the month's hours run out mid-meeting, the page says "This month's free hours of transcription are used up",
  keeps the lines so far, saves them, and stops. A team's own key is not counted. The meter counts the seconds sent,
  not Groq's 10 s minimum per request (the key's dollar limit is the backstop).
- Per person: one meeting at a time, 2 pieces in flight, 4 hours per meeting.

## Steps

0. **Spike (half a day, Mac, real Zoom + Meet).** Electron 44 loopback without Screen Recording: does audio-only
   work, does it hear Zoom, Meet in Chrome and Teams, does a refusal give silence. Pick capture way 1 or 2. Measure
   the Office Mac's whisper-cli on a 15 s piece (Metal, small) and OpenRouter's answer time from Korea and Indonesia.
1. **Capture** (desktop): the hidden capture window or the Swift helper; `NSAudioCaptureUsageDescription` and the
   microphone text in six languages; the "can't hear the call" check.
2. **Pieces and lines** (desktop/common): ports of chunker, live-word placement, echo and made-up-line filters, with
   the Yogurt notice; the meeting state machine in the main process; the local copy of the lines.
3. **Calls** (server): `server/src/jobs/meeting-piece.ts`, `routes/jobs.ts`, types in `shared/src/api/jobs.ts`;
   status, speed measure, Safe operations 1A, the meter.
4. **Bridge** (shared + preload + main): `meeting` object, version, checks.
5. **Web:** the entry, the first explanation, the Meeting notes page, the host-bar dot, saving, recovery, six
   languages (English first in `web/src/i18n/en.ts`), the help page.
6. **Docs:** decision file, `changes/live-meeting-notes.md`, NOTICE (Yogurt), `docs/PERMISSIONS.md` (the new macOS
   permission), the for-teams guide.

## Decisions

- New: `docs/decisions/<day>-live-meeting-notes.md`: meeting notes in the desktop app only; sound turns into text on
  the team server (option B) with the voice input setting; no sound kept; pieces at pauses ≤ 15 s; no changing words in
  P1; counted in the plan's free hours of transcription; the app's own start dialog every time, then the macOS
  questions once; only the call apps' sound is tapped; Safe operations 1A refuses OpenRouter.
- Builds on "Voice input through OpenRouter" and "Hosted speech-to-text" (docs/DECISIONS.md) and
  `docs/decisions/20261116-mac-local-speech.md` (#1090) without changing them.

## Risks

- **Silent permission refusal** on macOS → the call track is flat; handled by the check in step 1, tested by hand.
- **Electron capture way may need Screen Recording** → then the Swift helper (more signing work, ~1 day more).
- **Hours pool:** meetings can use up a hosted team's month of transcription, leaving none for voice input and video
  reads. Shown in Team settings' existing hours line; watched after release.
- **Echo** without headphones: the port's thresholds come from Yogurt's tests in English; Korean needs QA (row 5).
- **Server load:** an Office Mac serving several meetings at once plus voice input; one whisper at a time means pieces
  queue. A piece that waits over 20 s is answered 503 and the app sends it again later (pieces are kept in order in
  the app, at most 5 minutes behind); the page says words are coming late. Measured in step 0.
- **Cost on a team's own key:** a one-hour meeting sends about one hour of sound; Team settings' Voice input text says
  "Meeting notes count the sound of your meetings" next to the existing hours line.
- **Privacy:** the route takes sound from any signed-in member; it keeps nothing and is capped per person.
- **Licences:** Yogurt is MIT; ported files keep "Based on Yogurt (MIT), Copyright (c) 2026 Frigade" at the top and
  NOTICE lists it.
- No migration (highest on dev: 701). Six app languages. Desktop and web; nothing on the phone.

## Tests

- Unit: `tests/unit/e-desktop-meeting-chunker.test.ts` (1 s pause cut, 15 s cut at the quietest 100 ms, noise floor,
  short scraps dropped), `e-desktop-meeting-lines.test.ts` (meeting-time placement, echo drop with and without echo
  evidence, made-up lines), `e-desktop-meeting-bridge.test.ts` (team origin only, start shows the app's dialog and
  Cancel is the default, page reload keeps the meeting), `tests/unit/c-meeting-piece.test.ts` (guest 403, off 409,
  Safe operations 1A + OpenRouter 403, not a WAV 400, too long 413, 2 under way 429, OpenRouter path with a fake
  endpoint and the hosted meter, local path with a fake whisper-cli and the speed measure, the file deleted every
  time, status states).
- Desktop e2e: a fake capture source (two WAV fixtures, `MYCEL_MEETING_FAKE_AUDIO`) → lines on the page → Stop →
  the file in My files (mock team server).
- Web unit + e2e with a mock bridge: entry hidden in a browser and for guests, the first explanation once, the page,
  recovery offer.
- `bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run test:unit`, the desktop CI job.

QA rows (QA tab, assignee dion; servers → pras):
1. Mac app, hosted team: Zoom call with a second person, notes on, both voices appear as You / Others within a few
   seconds of each pause.
2. Same with Google Meet in Chrome and with Teams.
3. In-person meeting, no call: only the mic, words appear.
4. First use: the app's start dialog (Cancel is the default), then the macOS questions; refusing the call sound
   shows "Trina can't hear the call" and the button opens the right Settings page (macOS 14.4 and 15+).
5. No headphones, Korean call: the other side's words are not shown twice.
6. Stop: the file is in My files › Meetings with the right times; reload during a meeting keeps it running.
7. Quit the app during a meeting, start again: "Save the last meeting notes" saves them.
8. 10 minutes of silence: warned, then stopped and saved.
9. Hosted team out of free hours of transcription mid-meeting: the message, lines kept and saved.
10. Office Mac (after #1090): notes served by its whisper-cli; first use shows the model download.
11. 2-vCPU Linux server with local whisper: the entry says the server is too slow (no broken meeting).
12. Browser tab, phone, guest, voice input off, Mac App Store build: no entry.
14. Music playing in another app during a call: not written down as "Others".
15. Safe operations 1A team with OpenRouter: entry greyed with the reason.
13. 1440 and 390 px (the desktop window narrow), light and dark: the page and the host-bar dot.

## Size

About 11 working days for P1: spike 0.5; capture with the Swift helper 2.5; pieces and lines ports 2; routes and
status 1.5; bridge and the app's dialog 1; web 2; docs, QA rows and review 1.5. P2 (summary, call start prompt and auto-stop on call end, speaker
names) about 5 days. P3 Windows about 3 days (same capture through Electron, an installer check). Option A later about
5 days (engine builds per platform, model download in the app).

## Owner questions

1. **Who may take meeting notes.** Hosted teams have voice input on by default, so every member would get meeting
   notes with no admin step. Writing down calls carries more legal weight than dictating a message. Add one switch in
   Team settings › Voice input, "Meeting notes", on by default (recommendation), or keep no switch?
2. **"The sound never leaves this computer".** P1 sends pieces of sound to the team server (and on hosted teams on to
   OpenRouter, as voice input does). Do we need option A (the engine on each computer, a 264–488 MB download per
   person) for any customer soon? Recommendation: not now; build it only when a customer asks.
3. **Where the live words show.** In the Trina window only (recommendation), or also a small strip that stays on top
   of Zoom?

## Result

Filled in at the end.
