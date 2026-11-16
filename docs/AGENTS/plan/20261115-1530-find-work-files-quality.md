# Find work files: fewer, better files

- Date (UTC): 2026-11-15 15:30
- Branch: `fix/find-work-files-quality`
- Status: done
- Where: trina-ax (desktop look desktop/src/common + main, shared/src/file-scan.ts, the page's list web/src/lib/workFiles.ts, the AI pick's prompt server/src/onboarding/file-rank.ts). Why: find-work-files is a core feature (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a quality fix of an existing list (one optional field in the bridge's file entry)

## Goal

The owner tried Find work files on 0.5.7 against qa.trina.app: one real plan, then eleven `f(N).txt` pieces of a
saved web page from `aif.notion.so`. "They're work files, but it only brought really useless ones." Show fewer files,
and only ones that are clearly work; say so when there are none.

## Scope

In:
- Hard rules for junk in the shared name rules (saved pages, tool and code folders, program-given names, tiny files),
  applied by the app's look and by the page (so an older app's list is held to them).
- Copies and numbered series collapsed on the page.
- A company match only from the company's own host or workspace label; shared work-app hosts alone never count.
- The AI's answer vetoes what it was shown; without AI only strong signs (the company's, or a real document opened
  lately); txt and csv only with the company's sign.
- Coverage: newest-first walk; files opened lately (Spotlight / recent lists) join a walked folder even when it was cut.
- A bench on a made-up home with precision and recall before and after; docs (guide, DECISIONS), changelog fragment.

Out: Windows' "opened" from last-accessed (another branch changes work-index*.ts and work-places-run.ts), new copy on
screen, reading file contents.

## Steps

1. Shared rules and desktop walk (savedPage, softwareFolder, installFolder, autoNamed, tooSmall, FolderQueue,
   LookOptions.recentIn, mdfind per folder on a Mac).
2. Page list (workCandidates, companyHost, strongWork, workList with the AI's `sent` set) and the screen.
3. Unit tests (desktop, web), e2e of find-work-files, bench before/after, independent review, QA rows.

## Risks

Over-broad rules hiding real work files (reviewed: "Client_files", "License Agreement.pdf", CamelCase names stay); a
new macOS question (mdfind runs only after the folder's own question); time (each walked folder waits at most 1.5 s
for its recent files and 2 s to check them). No migration. No screen text changes.

## Result

Bench (made-up home, 35 recent work files), no AI: precision 0.28 → 1.0, recall 0.40 → 0.77. Worst-case AI (picks
everything): 0.58 → 0.85 precision, recall 0.83 → 1.0. The look about 0.1 s, the list under 15 ms.
