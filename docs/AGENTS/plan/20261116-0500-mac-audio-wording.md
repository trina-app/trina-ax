# Plain notes when a recording or video cannot be read

- Date (UTC): 2026-11-16 05:00
- Branch: `fix/mac-audio-wording`
- Status: in progress
- Where: trina-ax/server/src/files. Why: the AI passes these notes on to the person word for word.
- Version impact: patch, wording of tool results only

## Goal

On the Office Mac a voice memo cannot be read. The note the AI got said "This Mac server cannot read video and audio
files yet. Linux servers can.", so the AI told an office worker to "switch the server to Linux" (AI scenario check
VIEW-08, FIND-03). The notes should say plainly what is not possible here and what to do instead.

## Scope

In: the notes of `server/src/files/media-text.ts` (all 6 languages, English first): no "server", "Linux", "ffmpeg",
"whisper.cpp" or "package" in what members read. The Mac note offers the way out (play it and tell me the main points,
or paste a transcript; by voice when voice input works here) and the result tells the AI not to suggest changing the
install. The missing-tool note names ffmpeg only when the person is an admin. A unit test keeps the rule.
Out: reading audio on a Mac (a separate proposal, not built here); the image notes in vision-text.ts; admin docs.

## Steps

1. Rewrite the notes; add `macVoice` and `noToolAdmin`.
2. files/service.ts readMedia: Mac note + voice sentence when voice input works + one English line for the AI.
3. Tests: tests/unit/media-read.test.ts and a jargon test over MEDIA_TEXT.

## Decisions

none

## Risks

None for data or permissions: text only. About 20 English words more in a Mac audio read's result (not in the prompt).

## Tests

`bun run typecheck`, `bun run check:docs`, `bun run changelog:check`, `bun test tests/unit/media-read.test.ts`, the
AI scenario cases VIEW-08, VIEW-08.project and FIND-03.

## Result

