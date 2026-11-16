# The light logo becomes the primary logo, and the app icon a light tile

- Date (UTC): 2026-11-16
- Branch: `brand/logo-light-primary`
- Status: done
- Where: editions/trina/branding (brand files), web/public, desktop, mobile, Microsoft Store build files, READMEs, docs
  site. Why: the owner's decision of 2026-11-16 (see docs/REPOSITORY-RULES.md: Trina branding lives in
  editions/trina/branding).
- Version impact: patch: new icon pictures and logo files, no behaviour change.

## Goal

The owner chose the light version of the Trina AX logo (ink sides, Signal Orange top) as the official logo, and the app
icon as a light tile. One folder holds the logo files and a short brand guide, so the website, the console and the app
all take the same files.

## Scope

In: `editions/trina/branding/logo/` (marks, wordmarks, app icon, PNG exports, README, the script that writes them); the
web app's favicon and installed-app icons; the desktop icon (DMG, Mac App Store, Windows); the phone icon, Android
adaptive icon and launch screen (light, with a dark-mode launch screen); Microsoft Store tiles; the READMEs' logo and the
docs site header (light mark, dark mark on the dark theme).
Out: store uploads (the next phone build 1.0.8 and desktop release 0.5.9 take the icons), the promo films, the
notification icon (a white silhouette) and the Mac menu bar helper (SF Symbols).

## Steps

1. `editions/trina/branding/logo/make.py` writes every SVG and PNG; `bun web/scripts/make-icons.ts` renders the web PNGs.
2. `mobile/app.config.ts`: optional Android icon background picture and a dark-mode launch screen.
3. READMEs and the docs header use the marks; DESIGN-SYSTEM.md and the branding README describe the change.

## Decisions

docs/decisions/20261116-logo-light-primary.md

## Result

Light tile on every app icon source; logo files and brand guide in editions/trina/branding/logo/.
