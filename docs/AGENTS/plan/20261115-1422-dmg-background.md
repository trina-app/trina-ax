# The Mac dmg opens on a Trina window: a light background, a line and an arrow from the app to Applications

- Date (UTC): 2026-11-15 14:22
- Branch: `feat/dmg-background`
- Status: done
- Where: desktop/ (electron-builder `dmg` settings, build-resources, scripts). Why: the dmg window is part of the
  desktop app's packaging (see docs/REPOSITORY-RULES.md)
- Version impact: patch, only the look of the installer window

## Goal

Opening Trina-AX-*.dmg shows a bare window: the app icon and an Applications alias on the default background. The
owner wants it on-brand. After a first orange design, they picked "Option C · Guided" (2026-11-16): near-white #FCFBF8
with soft peach corner glows, the line "To install, drag Trina AX to Applications" (English only, one picture for
every language) and a fading orange chevron between the app and Applications, icons 144 points.

## Scope

In:
- `desktop/scripts/dmg-background.svg`: the source art (text outlined from Geist, so it renders with no fonts), with
  the render command in the file, as `trina-icon.svg` does.
- `desktop/build-resources/background.png` (660×452) and `background@2x.png` (1320×904), rendered with rsvg-convert.
  The art is laid out on 660×420; the canvas runs 32 points lower in the background glow only (see Result).
- Base `dmg` settings in `desktop/electron-builder.config.ts` (the Developer ID config spreads them): background,
  icon size 144, label size 13, and the two icons at (170,210) and (490,210) over the art.
- The picture is light, so Finder writes the icon names dark in light and dark mode (checked in a real Finder).

Out: the Mac App Store build (no dmg) and Windows (NSIS).

## Steps

1. Plan (this commit).
2. Art, PNGs and the dmg settings.
3. A real `dist:mac` build on a Mac; mount a copy read-only and screenshot the window in light and dark. Check the icon
   positions, whether the window size counts the title bar, and how electron-builder 26.0.12 uses the @2x file.

## Risks

None for the app itself. A wrong window size or icon position only misplaces the art; the screenshots check it. The
release job's dmg (signed and notarized) uses the same settings; the background is just a file inside the dmg.

## Tests

`bun run typecheck`, `bun run check:docs`, a unit test in `tests/unit/e-desktop-common.test.ts` (the files, their
sizes, the window and the icon spots); the dmg build and the two screenshots.

## Result

Built as planned, with two changes found in real builds (mounted read-only from a copy, macOS 26.6):
- electron-builder 26.0.12 makes the dmg as APFS with an old dmgbuild, and Finder showed no background at all, in our
  dmg and in the released 0.5.7 dmg. With 26.15.3 (HFS+, newer dmgbuild) it shows. So this branch sits on the
  electron-builder 26.15.3 update (its own PR, `chore/electron-builder-26-15`).
- Finder counts the title bar in the window size (32 points on macOS 26, 28 before), and 26.15.3 makes the window the
  picture's size and ignores `window` when there is a background. So there is no `window`, and the canvas is 660×452:
  the 420 points of art and 32 points of background glow below, so an older system shows a little more of it.
- electron-builder joins `background.png` and `background@2x.png` into one TIFF (`tiffutil -cathidpicheck`); the
  dmg's `.DS_Store` has icon size 144, label size 13 and the two icons at (170,210) and (490,210).
- The first orange design was replaced by the owner's pick "Option C · Guided" (light, chevron, one line).
- Geist's notice is in NOTICE and docs/THIRD-PARTY-NOTICES.md (outlines only, no font file).

PR: https://github.com/trina-app/trina-ax/pull/985 (on top of the electron-builder 26.15.3 PR).
