# The Mac dmg opens on a Trina window: orange background, an arrow from the app to Applications

- Date (UTC): 2026-11-15 14:22
- Branch: `feat/dmg-background`
- Status: in progress
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
- `desktop/build-resources/background.png` (660×420) and `background@2x.png` (1320×840), rendered with rsvg-convert.
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

`bun run typecheck`, `bun run check:docs`; the dmg build and the two screenshots.

## Result

Filled in at the end.
