# The Linux bundle carries the promo video's font and sounds

- Date (UTC): 2026-11-23 17:44
- Branch: `fix/bundle-promo-video-resources`
- Status: done
- Where: `scripts/build-bundle.ts`, `server/src/promo-video/`. Why: the MP4 reads these files from the version folder.
- Version impact: patch. A fix to the Linux bundle's app part; no root file changes.

## Goal

A real Linux kit said "이 서버는 영상 파일을 못 만들어요": the bundle had no `resources/promo-video`, so `renderTools` answered
`unsupported`. #427 was checked from a source checkout, which has the folder.

## Scope

In: the font, the nine sounds and their SOURCES.md in every Linux bundle; one list (`PROMO_RENDER_FILES`) that both the
bundle and the availability check read, so the build stops without a file; a guard test.
Out: the office and macOS bundles (the MP4 stays off there).

## Steps

1. The list in `promo-video/audio.ts`; `linuxBundleFiles` and the copy step; `renderTools` needs every file.
2. Guard test in `tests/unit/b-promo-video.test.ts`.
3. Real kit: build, install from `docker/` with the documented build argument, a second person downloads the MP4; amd64.

## Decisions

None. Follows `docs/decisions/20261123-linux-video-mp4.md`.

## Risks

Bundle size: about 3 MB before compression. No migration.

## Tests

`bun run typecheck`, `bun run check:prepush`, `b-promo-video`, `b-promo-video-save`, `system-packages`, a real kit.

## Result

See the PR.
