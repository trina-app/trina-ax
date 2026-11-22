# A restore and a leave tell the chat; DMs stay in Chats; limits say until when

- Date: 2026-11-22
- Status: accepted
- Supersedes: none
- Branch: fix/qa-ux-followups-1122 (scenario QA 11-22: S-032, S-010, S-035; TC-v1c-01, TC-f2-d01/d02, TC-v1a-02,
  TC-v2g-04, TC-f2-b01, TC-f2-b02, TC-r2b-09, TC-f3-08, TC-f3-01; plan docs/AGENTS/plan/20261122-0820-qa-ux-followups-1122.md)

- **Ask:** in today's scenario QA a chat file's "Restore this version" ran at once and told nobody; when the last other
  person left a 1:1 shared chat, its creator got no line and no notice, while the leaver got a notice about their own
  leave; a guest without AI saw "Ask Trina" on files; a DM with a file was not in Activity; "Archived accounts" stayed
  English in a Korean screen and a deleted sharer's notice said "Someone"; a weekly AI limit said "try again a bit later".
- **Restore in the chat file panel.** The Files screen's confirm ("Restore v{n}?", whose later versions drop out of the
  newest; the person restoring is never named), plus one sentence naming who in the chat will see the change (the people
  who see it now). The restore tells the open windows as an edit does (the tiles) and writes the chat's line "{actor}
  restored {file} to version {n}" (`chat_file_events`, migration 439; read with GET …/audience `events`, kind
  `restored`, `names` = the file, `version`), shown only to people who may open the file. No Activity row: an edit has
  none either.
- **Leaving.** The creator gets one Activity row per person who left, chat and day ('chat.left', `chat_left_notices`;
  shown always, never pushed; the title and link while the chat is theirs). A chat that went back to being only its
  creator's keeps its lines for them (GET …/audience of a private chat outside projects gives its creator `events`), so
  "{actor} left" shows after the last one out too; the chat page reads them once per open. The person who left reads
  nothing about it: their "shared a chat with you" rows of that chat go.
- **DMs and Activity: unchanged.** No DM message is an Activity row, with or without files (rooms/inbox.ts LISTED_SQL,
  "Activity: the DMs tab is back": the tab holds mentions and thread replies inside DMs). The Chats list counts it, the
  rail badge does not, the push rings: a file DM behaves exactly as a text DM (test in b-rooms-inbox). The DMs tab's
  empty state now says DM messages are in Chats. Listing every DM message in Activity is the owner's call.
- **Guests without AI** (Me.guest.ai 'none', useGuestAiOff) get no "Ask Trina" on a team or room file in the panel.
- **Names.** "Archived accounts" (made in the team's language) shows in the reader's language (shared folderLabel). A
  "shared a chat with you" notice keeps the sharer's name after their account is switched off or deleted (the tombstone
  keeps it); the push label keeps its own rule.
- **Limits.** Claude Code's own limit report (stream-json `rate_limit_event` with `resetsAt`, or "limit reached|<epoch>")
  gives the answer's retry time, so a limit over an hour reads "used up until {date}" (usage_used_up, params.until) like
  the proxy's. A weekly limit without a time is usage_used_up too. "Try again" is not offered for usage_used_up while it
  lasts (or when its time is not known); "answer with another model" stays.
- Tests: `tests/unit/b-qa-ux-followups.test.ts`, `tests/unit/b-rooms-inbox.test.ts`, `web/test/unit/chat-file-panel.test.tsx`,
  `web/test/unit/shared-chat-leave.test.tsx`.
- Version impact: **minor** (a new Activity notice and chat line; migration 439 is additive).
