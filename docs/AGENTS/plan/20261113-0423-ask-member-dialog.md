# Ask a member to connect: a member list with pictures, a simpler popup

- Date (UTC): 2026-11-13 04:23
- Branch: `fix/ask-member-dialog`
- Status: in progress
- Where: web (Admin › Connectors, RequestDialog.tsx). Why: the popup is a web screen (see docs/REPOSITORY-RULES.md)
- Version impact: patch — a screen's layout and words change; what is sent and the 7-day wait stay the same

## Goal

QA TC-188 (tracking TC-738). In Admin › Connectors › "Ask a member to connect…", the Member field is the browser's own
dropdown (rows read "Name (id)", no pictures, no search), a three-line paragraph opens the popup, every field has a
long note under it, and "Choose a member." is red on a popup nobody has touched yet. The admin should pick a person
the way they do in Folder permissions: a search with each member's picture, name and id, and a popup as plain as Team
settings.

## Scope

In:
- Member: the people search Folder permissions and Team skills already use (pages/admin/AddNamed.tsx), members only.
  Once picked, one row (picture, name, id) with a "Change" button. AddNamed gets optional props (its label, test id,
  "no match" words, error wiring); the two places that use it now do not change.
- One short line instead of the paragraph; short notes under the fields (the 7 days move into the Member note).
- Red errors only after Send is pressed (no error on leaving a field).
- New words in ko, en, id, ja, es; the popup's own keys only (the team dialog's shared keys stay as they are, another
  branch changes that dialog).

Out: the request itself (what is sent, 7-day expiry), the team "Add an app" dialog, the member's side.

## Steps

1. AddNamed: optional label / testId / noMatch / describedBy / invalid props.
2. RequestDialog: Member block with AddNamed + chosen row; one-line intro; short hints; errors after Send only.
3. i18n in five languages; e2e integration-requests.spec.ts picks through the list; axe on the open list.

## Risks

AddNamed is shared (AccessEdit, SkillManagers): only optional props, defaults unchanged. No migration. Phone width
390 px: the list is in the flow (inline), as in SkillManagers.

## Plain-words check

No "OAuth", "header", "id" or "user" in new words: "member", "Change", "Find a member", "gets a notice and a link".

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run test:web`, `bun run build:web`, e2e
integration-requests, access-edit / skill-managers specs (AddNamed), screenshots 1440/390 light.

## Result

Filled in at the end.
