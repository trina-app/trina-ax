# Voice input and recordings on an Apple silicon Office Mac, with no key

- Date: 2026-11-16
- Status: accepted
- Supersedes: the Mac part of "Voice input on a team's own server: the key turns it on" (docs/DECISIONS.md, 2026-11-07)
  and "A Mac server says video and audio are not supported there yet" (docs/DECISIONS.md "AI reads video and audio")
- Branch: feat/mac-local-speech (the owner, 2026-11-16; AI scenario check VIEW-08)

Plan: docs/AGENTS/plan/20261116-0639-mac-local-speech.md.

- **Ask (owner):** local speech-to-text for self-hosted Office Macs on Apple silicon only, so the AI can read audio and
  video files and voice input works with no API key. Intel Macs and Linux are unchanged.
- **whisper-cli in the office zip only.** `scripts/macos/build-whisper.sh` builds the pinned whisper.cpp (1.9.5, the
  Linux build's tag and sha256) for arm64 with Metal on and its shaders inside the program, OpenMP and BLAS off, and
  only system libraries. `.github/workflows/mac-whisper.yml` checks a spoken sentence, signs it with the Mac app's
  Developer ID Application identity (hardened runtime, timestamp, identifier `app.trina.ax.whisper-cli`) and has Apple
  notarize it; release.yml's build-office waits for it and `build-office.ts --whisper` checks the signature again
  before it goes to `app/bin/darwin-arm64/whisper-cli` (`codesign --verify --strict` against the requirement "anchor
  apple generic, leaf OU = the team, identifier", so a self-made certificate with the same name fails, plus arm64, the
  hardened runtime, a timestamp and system libraries only). Its sha256 is in `app/licenses/manifest.json` with the other
  programs, and the zip's sha256 in the signed office feed. The office zip is not notarized (the installer removes the
  quarantine); the program is, on its own. Not in the desktop dmg, the Intel folder or the Linux kit.
- **Decoding with macOS's own programs, not ffmpeg** (`server/src/jobs/mac-audio.ts`). afinfo says what a file holds,
  afconvert decodes it to 16 kHz mono WAV once, and avconvert takes the sound out of a video afconvert cannot open
  (Opus in mp4). Each runs as a converter (`tools/isolate.ts`: the macOS sandbox, no network, only its work folder),
  with a time limit, a memory cap and a cap on what it writes. Measured on macOS 26: 0.03 s for 9 s of AAC, mp3, flac,
  caf or Ogg Opus, and the sound of mp4, mov, m4v and 3gp; webm, mkv, avi, wma, Ogg Vorbis and AMR do not open. The
  read decodes only when a piece is to be made (a read that transcribes nothing, off, a guest or all cached, runs
  afinfo alone), once per read (afconvert has no seek); a voice input job hands afconvert's WAV to whisper.cpp
  without reading it into memory. The server cuts the decoded WAV itself into the transcript's 30 s pieces (`macWavPiece`: O_NOFOLLOW, one regular file,
  only the bytes of the piece, a plain 44-byte header, nothing of the file's tags), so whisper.cpp and OpenRouter get
  what they get from ffmpeg on Linux.
- **Which servers.** `macAudioTools()` is set only on `darwin` + `arm64` (`process.arch`, so an x64 bun under Rosetta
  counts as Intel). There ffmpeg is no longer a missing tool for "On this server" (`missingLocalTools`), and an AI read
  of video or audio uses these programs instead of saying a Mac does not read them (an Intel Mac still says it, PR #1063's
  plain words). Where ffmpeg is installed (Homebrew), voice input jobs still use it.
- **Browsers' recordings.** No macOS decoder opens webm, which Chrome and the desktop app record. On a server that
  decodes with macOS's programs (no ffmpeg), `Me.team.voiceInputWav` is true and the web app decodes its own recording
  (`decodeAudioData`), mixes it to one channel at 16 kHz and uploads WAV (`web/src/lib/wavRecording.ts`; 9.6 MB for
  the 5-minute cap). An older app's webm gets a plain "can't be read here" with the formats that work.
- **Default: local first.** At start (`main.ts`) a server with macOS's decoders and a whisper-cli sets
  `setLocalSpeechReady`; while no admin chose a provider and no OpenRouter key is saved, `speechProvider` reads `local`
  there. A saved key still reads `openrouter` (saving it was how a team turned voice input on before, so such a team
  keeps OpenRouter after the update and gets no surprise 488 MB download; review of the branch). Nothing is stored; an
  admin's choice, Off included, wins. "Turn video sound into text" keeps its own default (on for `local` with more than 2 cores).
- **The model on first use.** The `small` model (488 MB, sha256 pinned) is downloaded the first time it is needed, as
  on Linux; nothing is downloaded when the kit is installed. Voice input shows "Downloading the speech model (488 MB,
  first time only)" with its progress, as before. New on a Mac: an AI read may be the first use, so it starts the same
  download (one at a time) and waits for it while the read keeps a minute for the sound; when it is not done in time
  the read says "The speech model (about 488 MB, needed only the first time) is downloading now … Try again in a few
  minutes." and the download goes on. After a failed download a read starts another at most every 5 minutes. Linux reads still never download it. Team settings says on a Mac "Sound stays
  on this Mac and turns into text in a second or two" and, before the first use, how large the download is
  (`GET /api/admin/speech-host` `localMac`, `localModelMb`).
- **Video on a Mac: the sound only.** No frames are made there (no frame tool in macOS that runs in the converter
  sandbox without new code). The read says "Only the sound of this video was read. Its pictures can't be seen here."
  and refuses `transcript: false` and a single moment with a line for the AI. The media slot, voice input's turn before
  a read's pieces, the measured speed, the transcript cache, the confidential and guest rules are the existing ones.
- **OpenRouter on a Mac.** An admin who picks OpenRouter on an Apple silicon Mac: recordings are decoded the same way
  and go as WAV (no FLAC encoder runs there; a 10-minute piece is 19.2 MB, under OpenRouter's 25 MB; nothing of the
  file's tags goes). A voice input file longer than about 13 minutes is too large as WAV there; voice input stops at 5.
- **Not done.** Frames of a video on a Mac. whisper-cli in the role-account Mac bundle (`build-bundle.ts`, not
  released by CI). A background download at install.
- **Tests.** `tests/unit/mac-audio.test.ts` (afinfo, afconvert's header, 65 s cut into 30/30/5 s pieces from their own
  places, links and second names refused, which servers use it). `tests/unit/mac-local-speech.test.ts` on Apple
  silicon: `say` → afconvert → m4a, mp4, caf, mp3 → `transcribe()` with the real whisper-cli and the tiny model; a
  mov through afconvert, an Opus mp4 through avconvert, a silent mp4 named; the AI's read of an m4a and a mov through
  FileService. `tests/unit/media-read.test.ts` (the first read downloads the model, or says it is downloading).
  `tests/unit/a-speech-settings.test.ts` (no ffmpeg needed, `voiceInputWav`, `localMac`, `localModelMb`).
  `web/test/unit/wavRecording.test.ts`.
- **Version impact:** minor (a new way for voice input and recordings to work on Office Macs; a new release job).
