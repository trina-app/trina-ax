# Voice input and recordings on an Apple silicon Office Mac, with no key

- Date (UTC): 2026-11-16 06:39
- Branch: `feat/mac-local-speech`
- Status: done
- Where: trina-ax/server (jobs, files), web (voice input, Team settings), scripts (office zip, CI). Why: the owner approved local speech-to-text for Office Macs on Apple silicon (AI scenario VIEW-08)
- Version impact: minor, a new way for voice input and recordings to work on Office Macs and a new release job

## Goal

On an Office Mac with Apple silicon, voice input works and the AI reads audio and video files, with no API key and the
sound never leaving the Mac. Intel Macs and Linux stay as they are.

## Scope

In: whisper-cli for darwin-arm64 built in CI (pinned whisper.cpp, Metal, no OpenMP), Developer ID signed and notarized,
only in the office zip; decoding with afinfo / afconvert / avconvert in the converter sandbox, cut into 30 s pieces;
voice input (local first, the OpenRouter key as the alternative) and the AI's reads; the model on first use with a plain
note; wording in 6 languages; docs.
Out: frames of a video on a Mac; whisper-cli in the role-account Mac bundle; a download at install.

## Steps

1. `scripts/macos/build-whisper.sh`, `scripts/release/mac-whisper.ts`, `.github/workflows/mac-whisper.yml`, release.yml build-mac-whisper → build-office `--whisper`.
2. `server/src/jobs/mac-audio.ts`; transcribe.ts / openrouter-stt.ts Mac path; files/media.ts + service.ts Mac tools.
3. `Me.team.voiceInputWav` and `web/src/lib/wavRecording.ts`; Team settings hint; local default on a ready Mac.
4. Notes and docs; tests.

## Decisions

docs/decisions/20261116-mac-local-speech.md (supersedes the Mac part of "Voice input on a team's own server" in docs/DECISIONS.md).

## Risks

Security: untrusted files parsed by macOS decoders, run in the converter sandbox without network, with time, memory and
write caps; decoded WAV read without following links; model sha256 checked. No migration. Built on PR #1063's notes.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, tests/unit/mac-audio, mac-local-speech (real whisper-cli
on this Mac), media-read, a-speech-settings, the speech and office tests, web wavRecording; `bun run ai:scenarios` VIEW-08.

## Result

Built as planned, PR #1090. Video on a Mac gives the sound only (the read says so). After the review: the read
decodes only when a piece is needed, and a saved OpenRouter key keeps OpenRouter (local is the default only without one).
VIEW-08 passes on the real AI with the bundled whisper-cli.
