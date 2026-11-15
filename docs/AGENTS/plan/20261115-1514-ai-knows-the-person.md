# The AI knows who it is talking to and where

- Date (UTC): 2026-11-15 15:14
- Branch: `fix/ai-knows-the-person`
- Status: in progress
- Where: server/src/chat (prompt, a new situation block). Why: chat instructions are Team AX core (docs/REPOSITORY-RULES.md).
- Version impact: patch: the AI's instructions change, no API or data change.

## Goal

Trina often answers as if every person were the owner on a computer: it sends members to Admin, tells phone users to
use the desktop browser without saying so, says its server is "a computer in the office" on a hosted team, and does
not know whose AI account answers. Give the AI a short, true "about this person and place" block built from real
state, and make capability text depend on the person's real permissions and platform.

## Scope

In:
- Audit every fact the AI gets per turn (prompt.ts, turn.ts, tools, connection and Slack sections) against user
  states: owner, admin, member, member with own AI only, member without personal sign-ins, Office Mac, hosted, web,
  phone, desktop, project, room side chat, scheduled run, Slack, folder without access.
- A "## About this person and place" section: role and what that role may open (Admin or not), the app they use,
  whose AI account answers and where their own usage is, the team's plan for owners/admins on a hosted server.
- "Where you run" by the way the server runs (hosted, office Mac, own server) instead of always "the office".
- Screen names in the person's language from one table that a test compares with the web app's labels.
- Fix screen names the AI is told that no longer match the app.
- Unit tests per state.

Out:
- The guest part of the instructions (another branch fixes it); this block says nothing about guests' capabilities.
- Live usage numbers or budgets left in the prompt (they change every answer and break the prompt cache).
- Server asleep / update pending: the AI only runs while the server is awake.

## Steps

1. Capture the prompt and tool list per state on a private QA-Acme copy (managed mode, scripted AI, `@fake echo`).
2. Write the audit table.
3. Build the situation block (chat/situation.ts), wire it into turn.ts, the instructions and the resumed-turn context.
4. Tests, docs, review, PR to dev.

## Risks

- Every prompt grows: keep the block to a few lines.
- Privacy: nothing about other people (no admin names, no seat holders), no secrets, no connection names.
- Shared chats: the block is left out (the person's role is not the chat's people's to know).
- Prompt cache: the block changes only when the person's role, app or AI account changes.
