# Team link: a tidy "Manage link" panel

넣을 곳: Team AX core (`web/src/components/onboarding/TeamLinkPanel.tsx`), 이유: the team invite link is core.

The owner opened Invite people › "Manage link" (and the same details in Admin › Members' team link popup) and said
the UI is poor: the whole token address in large monospace over two lines dominates and looks technical; "Copy link
only" is an odd label; the facts are loose sentences with uneven gaps ("Joined 3 of 20 · Works until …", "Joins no
groups · Change groups", "Everyone who joins with this link is a member."); "Replace with a new link" floats alone.
Users are office workers, not developers.

## Plan
- The link: one read-only line on a light tint (no border), the address cut with "…" (the full address stays the
  element's text, selectable, and its `title`), "Copy link" inside it at the right, the QR code as an icon button with
  a tooltip beside it. The QR code still opens under it.
- The facts: one aligned two-column list, label left (muted), value right: Joined (3 of 20), Works until (date), Skill
  (when there is one), Groups (names or "None", with a quiet "Change" at the row's end), Joins as (Member), Seats left
  (only with a plan limit). Replaces three sentences.
- "Replace with a new link" (and "Turn link off" on Admin › Members) stay quiet text buttons at the bottom.
- Copy: "Copy link only" → "Copy link" (also the Members row and the handover invite: same action); "Change groups"
  → "Change" inside the Groups row. New keys for the row labels. English first, then es/id/ja/ko.
- Removed: the two-line monospace address, the three loose fact sentences (the member sentence becomes the
  "Joins as: Member" row; the form for a new link keeps its sentence). No capability removed: copy, QR, change groups,
  replace, turn off, Done all stay.

## Tests
- `web/test/unit/team-link.test.tsx`, `web/test/unit/onboarding-polish.test.tsx`: labels and the list.
- e2e `team-link.spec.ts`, `people-console.spec.ts`, `phone-invite-rows` (labels via keys).
- Screenshots 1440/390 light/dark before/after (`shots-team-link-manage.spec.ts`, env-gated).
