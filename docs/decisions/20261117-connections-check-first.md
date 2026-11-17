# What is connected is a checked fact in every answer, with both ways to connect

- Date: 2026-11-17
- Status: accepted
- Supersedes: none
- Branch: fix/connections-check-first (QA TC-4528, AI scenario CON-04)

- **Ask:** asked about team connections ("where do I connect Slack for the whole team, can members connect their own?"),
  the AI said "no Slack is connected" with nothing in the turn that showed it had looked. It also left out that a member
  links their own Slack account.
- **What the AI had:** the connections section (integrations/connections/tools.ts) was left out entirely when the
  person could use no connection. "Nothing connected" was then a guess from silence. The Slack section
  (integrations/slack/read.ts) said, when the team had no Slack, only that an owner or admin adds it. It did not say that
  each person links their own account after that.
- **Rule:** the connections section is always there for a person (not for guests, as before). With no usable
  connection it says "Checked by the server for this answer: this user has no app connection", scoped: Google Drive and
  Slack are separate (Slack has its own section, Drive answers through its tools). The list of connections says it was
  checked too. Both end with how connections are added: an owner or admin adds one for the whole team in Admin ›
  Connected apps and, while the team lets people add their own, can ask a member to connect theirs (Ask a member to
  connect); each person connects their own in Settings › Connectors, or asks the AI (connect_service; not offered in a
  scheduled run). When the team turned people's own connections off, it says so, and that Google Drive, Google apps
  and template apps can still be connected. A resumed session gets only the short fact, not the routes, with each
  message. The Slack section says its state was checked and gives both routes (team
  Slack by an owner or admin, then each person's own link in Settings › Connectors › Slack).
- **Why a fact, not a prompt rule:** the server knows the answer at the start of every turn. A fact the AI reads
  cannot be skipped the way a "check first" rule can, and it costs no tool call.
- **Left out:** a separate "list connections" tool, since the fact covers the same question for free. The screen names
  are in English, like the Slack section already was. The provider gets no locale.
- **Tests:** `tests/unit/c-integrations-tools.test.ts` "what is connected is a checked fact", `tests/unit/c-slack-read.test.ts`
  (Slack not added yet).
- **Version impact:** server only; no migration, no screen text.
