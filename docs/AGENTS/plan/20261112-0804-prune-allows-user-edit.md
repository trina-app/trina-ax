# A member's own Always allow goes when the user edit page takes away their access

- Date (UTC): 2026-11-12 08:04
- Branch: `fix/prune-allows-user-edit`
- Status: in progress
- Where: server `admin/users.ts`. Why: a follow-up to #583's rule that a member's own Always allow on a team connection
  goes when they lose access (see docs/REPOSITORY-RULES.md)
- Version impact: patch — fixes a gap in an existing rule; no new option or schema

## Goal

#583 removes a member's own Always allow on a team connection (`integration_user_allow`) when no rule of that
connection includes them any more, so it never comes back on its own when access is given again. It runs after a
connection's rule changes and after a group's members change on the group page. Removing someone from a group on the
user edit page (Admin › Members › a person › groups) skipped it, and disabling an account kept the rows, so an Always
allow could come back when the person was put back in the group or enabled again.

## Scope

In:
- The user edit page's group change calls `pruneMemberAllows` (the same check as the group page).
- Disabling an account removes that person's own Always allow rows (like their "Allow all websites", which goes off
  then too); enabling it again does not bring them back.
- Other paths checked: inviting and creating a group only add members; deleting an account already removes the rows;
  a role change does not change who may use a team connection (being an admin is not a rule).

Out: anything else about Always allow.

## Steps

1. Plan (this file).
2. `admin/users.ts`: prune after the group change; delete the rows on disable.
3. Test in `tests/unit/c-connector-approval-gate.test.ts`; `changes/prune-allows-user-edit.md`.

## Risks

Security only in the safe direction (fewer sends without a card). No migration.

## Tests

`bun run typecheck`, `bun run check:docs`, the connector approval and user admin unit tests.

## Result

Filled in at the end.
