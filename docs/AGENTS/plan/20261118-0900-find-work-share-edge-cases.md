# Find work files: edge cases from the Windows QA rerun of a picked folder

- Date (UTC): 2026-11-18 09:00
- Branch: `fix/find-work-share-edge-cases`
- Status: in progress
- Where: desktop/src/common (work-files.ts, folder-access.ts) and desktop/src/main/work-files.ts. Why: the walk and the
  pick checks of "find work files" live there (see docs/REPOSITORY-RULES.md).
- Version impact: patch, a fix to the picked-folder walk and one more check on a pick

## Goal

The Windows QA rerun of "Choose a folder…" on 0.5.16 passed but found edge cases (QA TC-4880..4883):

- A. On a picked network share, a link entry whose lstat never answers ends the whole walk at once (only the top file
  is kept). A local pick just skips it.
- B. A folder whose listing never answers (while its date answers) waits the whole root time (10 s) before the walk
  ends.
- C. A device path pick is checked only after realpath, which drops the device prefix.
- D. A share whose top folder gives file number 0 is refused (recorded only, no change).

## Scope

In: A, B, C with unit tests. Out: D (needs a product decision, TC-4883).

## Steps

1. scanRoots: a per-folder listing cap (LIST_MS) below the root's time; a listing that does not answer marks the root
   cut and the folders beside it are walked.
2. scanRoots: on a picked share (one call at a time), a link entry whose lstat does not answer is skipped (cut), never
   entered or listed.
3. Both keep a bound on hung calls per walk (HUNG_MAX): a call that never answers may hold one of the system's few file
   threads, so the second one ends the walk, as before on a share (a folder date that hung counts too).
4. folder-access.ts exports isDevicePath; pickFolder and pickRoot refuse a device path as picked, before realpath.
5. Unit tests in tests/unit/e-desktop-work-files.test.ts and tests/unit/e-desktop-folder-window.test.ts.

## Decisions

none (the share rules of docs/decisions/20261118-find-work-pick-network-share.md stay: links on a share are never
followed, every folder below a share's top passes the identity guard).

## Risks

Security: a skipped link stays skipped (never entered, never listed). The identity guard is unchanged. Threads: at most
two hung calls per walk on a share, as before. A big folder on a very slow share whose listing takes longer than
LIST_MS is cut where it used to be listed.

## Tests

`bun run typecheck`, the desktop find-work unit tests (Bun 1.3.12), desktop e2e work-files.

## Result

Filled in at the end.
