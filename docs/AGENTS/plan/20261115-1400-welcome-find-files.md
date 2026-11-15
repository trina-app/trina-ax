# The welcome card brings work files from this computer

- Date (UTC): 2026-11-15 14:00
- Branch: `feat/welcome-find-files`
- Status: done
- Where: trina-ax (Team AX core: web Home card, server onboarding/member-welcome.ts). Why: the invited person's welcome card and find-work-files are core features (see docs/REPOSITORY-RULES.md)
- Version impact: minor, a visible row on the desktop app's welcome card and an optional field in an answer

## Goal

Owner OK 2026-11-15: the invited member's welcome card on Home gets an optional fourth row, "Bring work files from
this computer", in the desktop app only. It opens the existing Find work files dialog in My files' mode and never
holds back "You're all set".

## Scope

In:
- `useMyWorkFiles` (FindWorkFiles.tsx): My files' dialog as a hook, used by the My files line and the card.
- Card row `FilesRow`: shown only with the desktop bridge's version, not on a narrow window (an open dialog stays).
- `steps.files` (optional): the server looks for a file in My files › From this computer; not counted, `allSet` unchanged.
- Every exit back to the card; the card reads its rows again on close and after Undo.
- Copy in en first, then ko/ja/zh/es/id; the guide names the row.

Out: counting the row, a new migration, a separate "files added" flag, the row on web or phones.

## Steps

1. Contract and server check, server unit test.
2. Hook refactor, card row, store, i18n.
3. Mock, web unit and e2e (stand-in bridge), screenshots 1440/390 light/dark.
4. DECISIONS entry, changes fragment, QA rows TC-3070..3077, independent review.
