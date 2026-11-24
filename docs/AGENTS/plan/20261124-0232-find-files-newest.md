# Name search keeps the newest readable files, not the first ones ripgrep lists

- Date (UTC): 2026-11-24 02:32
- Branch: `fix/find-files-newest`
- Status: done
- Where: server/src/team-files/find.ts, tests/unit/find-files-cap.test.ts. Why: with more than HIT_CAP readable matches the newest file can be dropped before the sort (CI flake in find-files-cap)
- Version impact: patch, a search result fix

## Goal

A broad name search shows the best and newest readable files whatever order ripgrep lists them in. Today the check loop stops at HIT_CAP (1000) hits and only then sorts, so a newer file listed later is never seen.

## Scope

In: check every candidate (already capped at CANDIDATE_CAP, in CHECK_CHUNK chunks, event loop free between), sort, then keep the best HIT_CAP. `truncated` stays true when more than the limit or the cap remain.
Out: the caps, the chunk size, permission checks, anything else.

## Steps

1. Test: force ripgrep's order so the newest file comes after the first HIT_CAP names; it fails on the old code.
2. Drop the early stop in the check loop; sort, then slice to HIT_CAP.

## Decisions

None.

## Result

See the PR.
