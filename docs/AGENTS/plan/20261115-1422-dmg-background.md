# The Mac dmg opens on a Trina window: orange background, an arrow from the app to Applications

- Date (UTC): 2026-11-15 14:22
- Branch: `feat/dmg-background`
- Status: done
- Where: desktop/ (electron-builder `dmg` settings, build-resources, scripts). Why: the dmg window is part of the
  desktop app's packaging (see docs/REPOSITORY-RULES.md)
- Version impact: patch, only the look of the installer window

## Goal

Opening Trina-AX-*.dmg shows a bare window: the app icon and an Applications alias on the default background. The
owner wants it on-brand. They picked "Option B" from two mockups: a burnt Signal Orange window, the Trina mark and
wordmark top left, a cream arrow from the app to Applications, and "Drag Trina AX to Applications" at the bottom.

## Scope

In:
- `desktop/scripts/dmg-background.svg`: the source art (text outlined from Geist, so it renders with no fonts), with
  the render command in the file, as `trina-icon.svg` does.
- `desktop/build-resources/background.png` (660×440) and `background@2x.png` (1320×880), rendered with rsvg-convert.
  The art is laid out on 660×420; the canvas runs 20 points lower in plain orange (see Result).
- Base `dmg` settings in `desktop/electron-builder.config.ts` (the Developer ID config spreads them): background,
  window size, icon size, label size, and the two icons' positions over the art.
- The orange is a mid tone on purpose: Finder writes the icon names in black in light mode and white in dark mode, and
  the background cannot follow, so the names must read on it both ways (about 4.5:1 each).

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

Built as planned, with one change found in the real build (`dist:mac:arm64` on macOS 26.6, mounted read-only from a
copy):
- Finder takes the window size with the title bar: with 660×420 its window was 660×420 in all, so the art's bottom was
  cut. The title bar is 32 points on macOS 26 (28 before), so the window is 660×452 and the canvas is 660×440, the extra
  20 points plain orange, so an older system shows a little more orange instead of a white edge.
- electron-builder 26.0.12 joins `background.png` and `background@2x.png` into one TIFF with `tiffutil -cathidpicheck`
  (`.background/*.tiff` in the dmg holds 660×440 and 1320×880); the dmg's `.DS_Store` has the window bounds, icon size
  128, label size 12 and the two icons at (180,190) and (480,190).
- With a background, electron-builder ignores the window's x/y, so they are not set.
- Geist's notice is in NOTICE and docs/THIRD-PARTY-NOTICES.md (outlines only, no font file).
