# Share dialog follow-ups after the #779 re-review

- Date (UTC): 2026-11-14
- Branch: `fix/share-dialog-followups`
- Status: done
- Where: Team AX core (`web/`). Why: the Share dialog is core (see docs/REPOSITORY-RULES.md)
- Version impact: patch, words and one confirm in the Share dialog; no data or API change

## Goal

The re-review of #779 (Share like Google Drive, P1) left five low items. Fix them before the release.

## Scope

In:
1. Restricted that cuts off people the folders above let in asks first, by name ("Take access away?", Save anyway).
2. The cut-off link reads plainly: Don't let people from "<parent>" in.
3. General access before the first answer shows no value (not "Restricted") and no line with a stray " · ".
4. A lower General access is one plain sentence: Anyone at <team> can edit "Company-wide" but can only view this folder.
5. Stale comments about the removed edit panel.

Out: P2 (Drive's additive model).

## Risks

None beyond the dialog; the confirm only adds a step before a narrowing save.

## Tests

Web unit (`folder-sharing-panel.test.tsx`), e2e `folder-access.spec.ts`, typecheck, i18n and docs checks, screenshots.

## Result

As planned. QA TC-1328..TC-1331.
