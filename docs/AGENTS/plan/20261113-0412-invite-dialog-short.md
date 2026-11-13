# Invite people dialog: short and readable

넣을 곳: Team AX core (`web/src/components/onboarding/TeamLinkPanel.tsx`, `InviteStep.tsx`), 이유: the team invite link is core.

QA sheet TC-196 (tracking TC-746). The Invite people dialog (admin Home, Admin > Members) had a two-line intro, the
message in large text with the whole address wrapped over two lines, and no link line (the link sat behind "Manage
link"). Keeps the decisions of the Manage link plan (`20261113-1400-manage-link-panel.md`): the facts list, "Copy
link", quiet replace / turn off.

## Plan
- Intro: one line, "Send this link to the people you want to invite." (all five languages, both the paste and the
  share-sheet variants).
- The link now shows at once, above the message: one mono line cut in the middle with "…" (the whole address stays the
  text and the title), "Copy link" inside it, the QR icon beside it. It moves out of "Manage link"; the facts, groups,
  replace and turn off stay there.
- The message below it: smaller and quiet (label-size muted text), with "Copy message" under it as before.
- Removed: the two-line large address in the message block weight, the link hidden behind "Manage link". Nothing
  removed that can be done: copy message, copy link, QR, manage, replace, turn off, done.

## Plain-words check
"Send this link to the people you want to invite." No jargon; the address is shown short.

## Tests
Unit: team-link, onboarding-polish, welcome. e2e: team-link, people-console, phone-invite-rows, handover,
welcome-notes, team-prepared. Screenshots 1440/390 light (`shots-team-link-manage.spec.ts`).
