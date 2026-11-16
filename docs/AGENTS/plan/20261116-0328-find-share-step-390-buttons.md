# Find work files: the share step's buttons in the sheet's footer

- Date (UTC): 2026-11-16
- Branch: `fix/find-share-step-390-buttons`
- Status: done
- Where: trina-ax (Team AX core: web/src/components/ui.tsx Modal, onboarding/ShareFoundFiles.tsx). Why: the shared
  dialog and the core Find work files step (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a layout fix

## Goal

QA TC-3522 (from TC-3502): at 390, with files ticked and a person picked, Not now sat at the sheet's bottom edge, cut
off until scrolled to. The buttons must stay whole and in sight.

## Scope

In: `ModalFooter` in ui.tsx: content inside a Modal puts its buttons in the Modal's own footer row (the same row as
`footer`: border, padding, the phone's safe-area inset), so the body scrolls above it. The share step's Share and Not
now use it. e2e: at 390 both buttons are wholly in the viewport.

Out: the other steps of Find work files (their buttons fit; unchanged).

## Result

Done; the new e2e fails on dev and passes here.
