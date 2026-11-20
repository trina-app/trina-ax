# Phone app: the switch-team card's buttons stay inside the card (QA AP-078)

- Date (UTC): 2026-11-19 14:30
- Branch: `fix/ios-switch-team-card-padding`
- Status: done (not run on a device: see Checks)
- Where: `mobile/App.tsx` (setup screen, the `setup-ask` card)
- Version impact: phone app, patch; ships with the next app build. No server change.

## Problem

QA "AI parity 2026-11-19", AP-078 (Bug, Low, iPhone): on "Join your team" with another team's address, the card
"Leave … and connect to …?" has Cancel and Switch touching the card's left, right and bottom border, and Cancel goes
slightly past it.

## Cause

The two buttons sit in a row (`askRow`, gap 10). Cancel's outlined text has `secondaryText.minWidth: 160`. On a 393 pt
iPhone the card's inner width is 393 − 2 × 24 (screen) − 2 × 16 (card) − 2 (border) = 311 pt, but the row needs at
least 160 + 10 + 160 = 330 pt: the row runs past the card's padding. (`askButton` already set `minWidth: 0` on both
Pressables, but not on Cancel's text.)

## Fix

`askButtonText: { minWidth: 0 }` on Cancel's text in the card: both buttons share the row evenly inside the padding.

## Checks

`npm --prefix mobile run typecheck` passes. No automated layout test: React Native layout does not run in the unit
tests, and this Mac has no iOS Simulator runtime now. Check on an iPhone with the next build.
