# Team link: show and change the groups people join

넣을 곳: Team AX core (`server/src/auth/team-links.ts`, `web/src/pages/admin/Members.tsx`,
`web/src/components/onboarding/TeamLinkPanel.tsx`), 이유: accounts, invites and groups are core.

QA TC-458 (a real team): the team link was made with the group "leads"; everyone who joined through it was put in
leads, so in the #leads room and a project that group can write. The Invite links row did not say which groups it
adds, and the groups could only change by making a new link (which breaks the link already sent).

## Plan
- Server: `PATCH /api/admin/team-link` takes `groupIds` (replace; `addGroupIds` stays for the welcome steps). Admin
  only (the endpoint already is). Unknown group ids → 400; groups deleted since are dropped from the link. Refused
  (409 gone) while the open link has expired or stopped; no open link (revoked) → 404. The token, uses and expiry stay.
  Audited `team_link.update` with `groupIds` (after) and `from` (before). People who already joined keep theirs.
- Web: the team link row on Admin › Members says "Joins: leads" / "Joins no groups" (desktop and the phone row of
  TC-390, details still under the name); single-use invite rows the same.
- The team link popup: the facts line says "Joins: …" with a quiet "Change" that opens the same group checks in place
  (Save / Cancel) and one line "People who already joined keep their groups."
- The group checks (making a link and changing one) get a small "Make a new group" link to Admin › Groups; no inline
  group making.
- 5 languages, English first; Korean short 해요체.

## Tests
- `tests/unit/a-team-links.test.ts`: admin only, groups replaced, token unchanged, next join gets the new groups,
  earlier joiners unchanged, audit row, unknown ids, deleted groups dropped, expired refused.
- `web/test/unit/team-link.test.tsx`: the row text and the picker (change, save body, the Groups link).
- `web/test/e2e/team-link.spec.ts` if the mock supports it.
