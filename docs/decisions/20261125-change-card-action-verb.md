# A connector's change card says what the call does: send, save, add, delete or change

- Date: 2026-11-25
- Status: accepted
- Supersedes: none
- Branch: fix/ask-card-action-verb (QA on qa.trina.app, 11-25: a Gmail draft and a Calendar event)

- **Ask:** saving a Gmail draft and adding a Calendar event asked "The AI wants to send this to Gmail … Send it?" with
  "Send once" / "Don't send". The card said "send" for every change at every connected service.
- **Rule:** the card's sentence, question, buttons and details label follow what the call does
  (`changeAction`, server/src/integrations/connections/card-lines.ts), for every connector tool, by the tool's own
  words and the call's own arguments, never a list of tools:
  - **send** when the name or title says it reaches people anywhere in it (send, reply, forward, post, publish, share,
    invite, notify …), when a message, mail or comment is made with no other verb ("create_message",
    "schedule_email"), or when the call names someone it reaches (a "to", attendees: read-mark.ts `argsReachOthers`,
    empty values not counted) and it does not only save;
  - else the call's own `action` / `operation` / `op` argument for a "manage_*" tool (Google's `manage_event` with
    `action: "create"` is **add**);
  - else the first action word of the name, then of the title: **save** (draft, save, export …), **add** (create, add,
    insert, append, upload …), **delete** (delete, remove, trash, cancel …), **change** (update, edit, modify …);
  - else **change**.
  The words: "The AI wants to save this in Gmail: Save a draft · Save it? · Save once / Always allow / Don't save"; add,
  delete and change alike; a send keeps its words. An HTTP API request keeps "send this request" (it sends one), and
  the plain card of a call on the person's own things keeps its neutral Allow / Don't allow.
- **Why:** a person who asked for a draft was told it would be sent. The verb must be the call's, and a call that
  reaches people must never read as a quiet change, so any send signal wins.
- Only words change: who is asked, when, and what the answer does are as before.
- **Tests:** tests/unit/change-card-action.test.ts (every Google Workspace change tool, manage_* by its argument,
  generic MCP names, send words winning, recipients), tests/unit/c-google-apps-tools.test.ts (the draft and event
  cards).
- **Version impact:** patch.
