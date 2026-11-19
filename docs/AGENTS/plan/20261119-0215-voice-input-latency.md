# Voice input: words sooner while talking, and the on-device plan

- Date (UTC): 2026-11-19 02:15
- Branch: `fix/voice-input-latency`
- Status: done
- Where: trina-ax `web/src/lib/liveDictation.ts`, `shared/src/speech-pieces.ts` (cutter options only),
  `server/src/jobs/no-speech.ts`. Why: the owner, 2026-11-19, on the chat microphone: "받아쓰기가 되긴 하는데, 오래 동안 말을
  안해야만 이전게 적혀" and "뒤에 소음이 있어도 괜찮나?".
- Version impact: patch: voice input shows words sooner; no new endpoint, setting or permission.

## Goal

The chat's microphone (desktop, web, and the iPhone and Android apps, which all run the same web page) shows the words
while the person talks, or within a second or two of a short pause, as Yogurt does. Today an average word shows 5.7-7.2
s after it was said, and up to 12 s (measured below); with steady noise more pieces run to the 15 s cap.

## Where the time goes (measured 2026-11-19, this Mac, local server)

The real cutter and session (voice input's options) in real time against a local dev server, `POST
/api/transcribe/piece`, whisper.cpp small (the server's own local path). 150 s of talk-like speech per run (LibriSpeech
en / Zeroth ko sentences joined with meeting-like pauses: 60% 0.2-0.6 s, 30% 0.6-1.2 s, 10% 1.5-3 s), speech at -26
dBFS, real noise (DEMAND café, ESC-50 vacuum as fan, FMA instrumental music). Seconds, mean per piece:

| run | piece | at the 15 s cap | cut wait (avg word) | queue | upload + server + whisper | order wait | word → screen mean / p90 / max |
|---|---|---|---|---|---|---|---|
| en quiet | 9.3 | 40% | 5.73 | 0.01 | 1.05 | 0.00 | 6.8 / 9.8 / 10.0 |
| ko quiet | 7.7 | 19% | 4.47 | 0.01 | 1.26 | 0.00 | 5.7 / 9.2 / 9.7 |
| en café 10 dB | 8.4 | 19% | 4.95 | 0.00 | 1.64 | 0.64 | 7.2 / 11.3 / 12.1 |
| ko café 10 dB | 7.6 | 25% | 4.61 | 0.01 | 1.21 | 0.36 | 6.2 / 9.1 / 9.8 |
| en fan 5 dB | 10.0 | 57% | 6.06 | 0.01 | 1.10 | 0.00 | 7.2 / 10.0 / 10.5 |
| ko music 10 dB | 8.5 | 27% | 4.81 | 0.01 | 1.46 | 0.00 | 6.3 / 8.9 / 10.5 |

The wait is the cut: a word waits for its piece to close, at a 1 s pause or at 15 s. The server's part is 1.0-1.6 s
(OpenRouter: 1.3-1.6 s, measured 2026-11-17). The first words already show in about 3.2-3.5 s (the short first piece).
Teams whose voice input runs on whisper.cpp on their own server get no live words at all: the whole recording is
transcribed after Stop (decision 20261117-voice-live-text).

## Scope

In (this PR, every platform at once, since all run the web page):
- Voice input's later pieces: cut at 7 s (not 15) at the quietest 100 ms of their last 1.5 s, and closed by a 0.6 s
  pause (not 1 s), through new cutter options (`maxMs`, `searchMs`, `pauseMs`); the cutter's defaults stay.
- The no-speech filter drops a line that is one letter over and over ("ლლლლლ", a Sinhala letter 120 times): whisper
  wrote these for fan and office noise, and the sound passed as speech-like, so they reached the box.

Out (the on-device plan below; each its own PR):
- On-device transcription on the Mac, iPhone and Android.
- Live words for teams whose own server runs whisper.cpp (a client switch once x86 speed is checked).

## On-device: options and the recommendation

Checked on this Mac (macOS 26.6, M1 Max) and in Yogurt's source (github.com/FrigadeHQ/yogurt, 3baa117): Yogurt shows
live words from Apple's SpeechAnalyzer/SpeechTranscriber (macOS 26, Apple silicon, `.volatileResults`) and keeps
whisper.cpp (whisper-server, Metal, large-v3-turbo q5_0 574 MB) for the saved text. SpeechTranscriber here: ko-KR and
en-US supported (30 locales, no Indonesian); the locale asset downloads once (ko 20 s, en 11 s) with no prompt; a
Korean TTS clip transcribed exactly in 0.26-0.48 s for 10 s of sound; fed in real time with `.fastResults`, live words
about every 1 s, 0.01-0.4 s behind the sound (without `.fastResults` nothing showed until the end). The old
SFSpeechRecognizer has no on-device Korean on this Mac. Real-speech Korean quality is not checked yet (TTS only).

| platform | option | live words | Korean | cost | estimate |
|---|---|---|---|---|---|
| Mac desktop | **SpeechTranscriber in a small Swift helper** (stdin 16 kHz PCM → JSON lines volatile/final) | ~1 s | supported, TTS exact | macOS 26 + Apple silicon only; server fallback elsewhere | 3-4 days |
| Mac desktop | whisper.cpp + Metal in the app (we already build whisper-cli for the office zip) | per piece (cut + 0.3-1 s), or partial re-runs | whisper small: CER 11-15% quiet | 190-574 MB download per person, first-use flow | 4-5 days |
| iPhone | SpeechAnalyzer (iOS 26) / SFSpeechRecognizer on-device (older), Expo native module | ~1 s | to check on a device | app store release | 3 days + review |
| Android | system SpeechRecognizer, `createOnDeviceSpeechRecognizer` (Android 13+) | partial results | depends on the phone's language pack; to check on the Note10 | Play release | 3 days + review |
| browser | this PR (shorter pieces); the Web Speech API sends sound to Google/Apple, against the team's speech settings | — | — | — | done here |

Recommendation: Mac first, with SpeechTranscriber behind the desktop bridge (as Yogurt), server path as the fallback
(Intel, macOS before 26, Windows, a language it lacks, or the asset not yet there). It is stricter than every server
setting (the sound never leaves the computer), so it is allowed in confidential chats and under Safe operations 1A, and
it uses none of the plan's speech hours. The team's "voice input off" still hides the mic. Then iPhone, then Android,
after a device check of Korean. Each is more than 2 days, so this PR stops at the plan.

## Steps

1. Plan (this file), first commit.
2. `shared/src/speech-pieces.ts`: `maxMs`, `searchMs`, `pauseMs` options (defaults unchanged); tests.
3. `web/src/lib/liveDictation.ts`: 7 s / 1.5 s / 0.6 s; test.
4. `server/src/jobs/no-speech.ts`: `letterLoop`; tests.
5. Decision file, `changes/voice-input-latency.md`, QA rows, PR.

## Decisions

`docs/decisions/20261119-voice-input-latency.md`. Changes the later-piece numbers of
`20261117-voice-live-text.md` for voice input; the cutter's defaults and `20261116-live-meeting-notes.md` are untouched.

## Risks

- Cost: OpenRouter bills by the second, so more, shorter pieces cost the same seconds; about 2× the requests (about 10 a
  minute of talk), inside the server's 40 pieces and 120 s of sound a minute and two at once.
- Accuracy: shorter pieces give whisper less context: about one point more word errors on average (below).
- No migration, no permission, no UI text.

## Tests

`tests/unit/speech-pieces.test.ts` (later-piece options), `web/test/unit/liveDictation.test.ts` (a piece at least
every 7 s, a 0.6 s pause ends one), `tests/unit/no-speech.test.ts` (letter loops). The offline harness (not in the repo)
is described in the decision file.

## Result

Same runs after the change: word → screen 3.7-4.2 s mean (was 5.7-7.2), p90 4.9-5.2 s (was 8.9-11.3); about one
point more errors (19.6% vs 18.6% over 10 mixes); noise alone wrote no text (was 4 one-letter loops). Numbers and the
settings tried in docs/decisions/20261119-voice-input-latency.md. The on-device work above is the next step.
