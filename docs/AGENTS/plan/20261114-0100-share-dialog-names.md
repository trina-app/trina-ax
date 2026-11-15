# Share dialog: name who and where (last lows of the #783 review)

- Date (UTC): 2026-11-14
- Branch: `fix/share-dialog-names`
- Status: done
- Where: Team AX core (`web/`). Why: the Share dialog is core (see docs/REPOSITORY-RULES.md)
- Version impact: patch, words in the Share dialog; no data or API change

## Goal

Make the dialog's lines exact: the cut-off link names the folder the greyed rows come from, the line under a lower
General access names everyone it keeps out, and the team's line says "Everyone else" when people are listed. Align
DECISIONS with what the Restricted confirm does.

## Scope

In: the three wordings, en first then ko, id, ja, es; DECISIONS. Out: P2.

## Risks

Words only.

## Tests

Web unit (`folder-sharing.test.ts`, `folder-sharing-panel.test.tsx`), e2e `folder-access.spec.ts`, checks.

## Result

As planned. QA TC-1341..TC-1343.
