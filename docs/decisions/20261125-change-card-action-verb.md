# A connector's change card says what the call does: send, save, add, delete or change

- Date: 2026-11-25
- Status: accepted
- Supersedes: none
- Branch: fix/ask-card-action-verb (QA on qa.trina.app, 11-25: a Gmail draft and a Calendar event)

- **Ask:** saving a Gmail draft and adding a Calendar event asked "The AI wants to send this to Gmail … Send it?" with
  "Send once" / "Don't send". The card said "send" for every change at every connected service.
- **Rule:** the card's sentence, question, buttons and details label follow what the call does
  (`changeAction`, server/src/integrations/connections/card-lines.ts). The default is **send**. The card says
  **save**, **add**, **delete** or **change** only when Trina is sure nothing reaches anyone (review of #585: word lists
  of send words kept missing tools that reach people):
  - the action is known: Trina's own list of the Google Workspace library's change tools (a `manage_*` tool there by
    its own `action` argument, picking only among the non-send actions), else a non-send verb (create, add, insert,
    save, draft, export, delete, remove, update, edit …) as the first word of a plain ASCII name (or the second after a
    service prefix), then of the title, with no word in name or title that reaches people (message, comment, post,
    status, story, campaign, review, form, mention, share, permission, user, member, group, owner, meeting, video, phone
    …). Never from the call's own arguments alone;
  - and the call's arguments name no one and nowhere: no key about people or reach (attendee, invitee, recipient,
    assignee, forward, email, owner, user, member, share, channel, mention, notify, privacy, permission, to / cc / bcc
    …) with a value, no key that is not plain ASCII, no value that is an e-mail address, a phone number, an @handle or
    "public". Checked for every tool but a Gmail draft (Trina's list: a draft's "to" and the addresses in its body go
    nowhere until the person sends it from Gmail).
  Anything else is a send, a name or title not in plain ASCII included. The words: "The AI wants to save this in
  Gmail: Save a draft · Save it? · Save once / Always allow / Don't save"; add, delete and change alike; a send keeps
  its words. An HTTP API request keeps "send this request" (it sends one), and the plain card of a call on the person's
  own things keeps its neutral Allow / Don't allow.
- **Why:** a person who asked for a draft was told it would be sent. The verb must be the call's, and a call that
  reaches people must never read as a quiet change, so the quiet words need proof and send is the default.
- Only words change: who is asked, when, and what the answer does are as before.
- **Tests:** tests/unit/change-card-action.test.ts (every Google Workspace change tool, manage_* by its argument,
  the review's 40 tools that reach people, all read as a send), tests/unit/c-google-apps-tools.test.ts (the draft and event
  cards).
- **Version impact:** patch.
