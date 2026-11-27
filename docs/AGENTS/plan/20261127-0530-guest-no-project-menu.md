# A guest's project page has no name menu again

- Date (UTC): 2026-11-27 05:30
- Branch: `fix/guest-no-project-menu`
- Status: done
- Where: web/src/pages/Projects.tsx. Why: the shared-menus change (3781ea2cf) gave every project page a menu (Copy link first), so a guest, whose project page is a quiet screen with no menu, got one; web e2e `guest-view.spec.ts` "a guest in a project with AI off" fails on dev (line 127).
- Version impact: patch (restores the guest view's old behaviour; no API change)

## Goal
A guest sees no project name menu, as before 11-26 (the old menu was null for anyone who could not edit or leave).

## Scope
In: `menu` is null for a guest on a computer and a phone.
Out: guest room menus, other menu changes.

## Steps
1. `const menu = p.inTrash || guestHere ? null : orderMenu([...])`.
2. Run guest-view.spec.ts.

## Decisions
none (20261126-shared-menus.md did not decide guests; the existing e2e line is the rule).

## Risks
None for members; guests keep the page without a menu.

## Tests
guest-view.spec.ts, typecheck.

## Result
guest-view.spec.ts 18 passed; typecheck clean.
