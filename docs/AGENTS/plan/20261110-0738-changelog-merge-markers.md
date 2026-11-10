# Plan: remove leftover merge markers from CHANGELOG.md

## Why
Eight `||||||| <sha>` lines (diff3 base markers from merge resolutions) were left in the `## Unreleased` section of `CHANGELOG.md` on `dev`. The base sections themselves were empty, so no entry is duplicated or lost; only the marker lines are stray.

## Change
Delete the eight `||||||| …` lines. No other line changes.

## Check
`grep -E '^(\|{7}|<{7}|>{7})' CHANGELOG.md` finds nothing; every Unreleased entry is still present once.
