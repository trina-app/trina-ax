# Every section and folder of the Chats list folds, on a phone too, and the folds are kept on the account

- Date: 2026-11-16
- Status: accepted
- Supersedes: none (extends [List folders on screen](../DECISIONS.md) and the Chats panel's folding sections)
- Branch: feat/collapsible-chat-sections (the owner, QA TC-3770..3782)

Plan: docs/AGENTS/plan/20261116-0503-collapsible-chat-sections.md.

- **Ask (owner, 2026-11-16, phone 390 px):** on the phone's Chats tab the folders and sections could not be folded,
  though people make folders to fold them; a folded one should be remembered and should still show its unread count.
- **What Slack does** (its web app, read in a test workspace on 2026-11-16; Slack's help centre does not describe it):
  the ▸ beside a section's name folds it; folded, only the conversation that is open stays under the header (unread
  ones do not; "Unread conversations only" is a separate per-section filter, off by default); a folded section with
  unread conversations shows its name bold and a red count badge at the header's end.
- **Rule:**
  - Every section of the Chats list (Pinned, Conversation folders, each of my folders, Team rooms, Group chats, Direct
    messages) folds with its header, on the phone's Chats tab and in the computer's Chats panel, through the shared
    `ListSection` (web/src/components/list/List.tsx). One fold key per place (`section:chats:<kind>`,
    `room-folder:<id>`), so folding on one shows folded on the other.
  - Folded, a section's rooms go, except, on a computer, the room open on screen (as Slack). Its header turns bold in
    ink and shows one pill: "@" when an unread message in it mentions me, else how many of its rooms have unread
    messages. Muted rooms are left out, as the Chats tab count leaves them. All read: a plain header, no pill. The pill
    is the rows' own badge look (accent), not Slack's red, and its words are part of the fold button's name.
  - The folds are kept on the account: `prefs.listFolds` (UserPrefs, PATCH /api/me, merged with the other preferences;
    a map of at most 200 keys, each `open` or `folded`; a bad stored value reads as none and hides no other preference).
    `users.prefs` is JSON, so no migration. Every list that folds (Trina, Projects, Files, Activity) uses it. The browser
    keeps a copy (an older server, a failed save); folds kept only in a browser before are sent to the account once.
    Other open windows see a change on their next load (no live event).
- **Left out:** Slack's "More conversations" menu on a folded header, per-section "Show and sort", and "fold all".
- **Tests:** tests/unit/a-auth.test.ts (listFolds kept, refused, merged), web/test/unit/list-pieces.test.tsx (pill,
  bold, kept row, the account's folds), web/test/e2e/chat-list-folds.spec.ts (390 and 1440).
- **Version impact:** minor (a new preference on the account; the phone's Chats tab folds).
