# The AI says who can open a thing, and a refusal gets a one-tap next step

- Date (UTC): 2026-11-16 11:50
- Branch: `feat/ai-share-who-can-open`
- Status: done
- Where: Team AX core (`server/src/files`, `server/src/chat`, `web/src/components/chat`). Why: chat, permissions and
  files belong to the core (see docs/REPOSITORY-RULES.md)
- Version impact: minor. A new AI tool, a new endpoint and one additive migration

Put in: core, reason: sharing rules and the chat's tools live there.

## Goal

A teammate's hands-on tests (QA tab "Manual AI tests", MAN-003, MAN-013) ended in dead ends: after a post to a room the
person read "3 people can't see some of the sources" with nothing to press, "share a colleague's file" ended in "only
the owner can", and a chat moved into a project stayed private without a word. This is package 3 of the plan "AI
sharing" (2026-11-16, approved by the owner): the AI can read who can open a file, a folder or a chat and by which
route, and every such refusal offers one button.

## Scope

In:

1. Tool `who_can_open` (read-only): who can open a file, a folder or a chat and how (owner, shared by name, through a
   group, Everyone, a folder's access, project membership, a chat shared with people), and for one named person whether
   they can and why. The full list only for someone the screens show it to (a file: its owner or whoever may share it;
   a folder: owner and admins; a chat: whoever sees the chat). Anyone else learns only their own access.
2. `accessRouteFor(ctx, personId, path)` in a new module, so the share tool can say "Jun can already open it through
   Sales" (the share tool calls it before its card).
3. After `post_to_room`, when some members cannot open a linked file that did not go as a copy, or cannot see a file the
   text came from: the step says how many, and offers **Let them view** (the sender may share the file: a normal share to
   exactly the people shown, via `ai`, audited) or **Ask <owner>** (the existing access request, asked for those people).
4. `share_with_person` refused because the file is someone else's: **Ask <owner> to share it**.
5. A team folder as a member: **Ask an admin** (a 1:1 message to an admin with the folder and the people; nothing
   changes by itself).
6. Moving a chat into a team project: the toast says "Moved to <project>. Only you can see it." with **Share with
   project** (the existing share flow). "Why can't Jun see this chat": `who_can_open` answers and its step offers the
   same button.
7. A service that is not connected: the existing `connect_service` card already finishes in the chat and the answer
   goes on; this package checks it and adds nothing but a test and a note where it falls short.

Out: folder sharing by members (designed separately), the result card itself (package 2 mounts our button), the words
of refusals (package 1), a new Activity notice type for folder requests.

## Steps

1. Server: `files/access-routes.ts` (routes, lists, the names), `chat/who-can-open.ts` (the tool), the prompt line.
2. Server: `files/share-fixes.ts` (offers kept in `share_fix_offers`, the checks at the tap), `POST
   /api/share-fixes/:id/run`; `FileShares.requestFor` (a request asked for other people: `file_access_requests.asked_by`).
3. Server: `post_to_room` and `share_with_person` attach offers to their step (`Step.fixes`); other viewers of a shared
   chat never get them.
4. Web: `StepFix` (the shared button: a line, one button, its result), mounted under a step; the move toast; the
   Activity row of a request asked for someone else; a path link opens through a grant.
5. Tests, hands-on checks on a private copy of the QA team, screenshots, docs.

## Decisions

`docs/decisions/20261116-ai-share-who-can-open.md`: the names of people who cannot open a file are shown to the file's
owner (the earlier rule was counts only); a request for access may be asked for other people; a grant opens the file
from a path link.

## Risks

- Migration `363_c_share_fix_offers.sql` (additive; a number with a gap, because three other packages are built at the
  same time).
- Permissions: every tap is checked again as the person, at the tap; the list granted is the list shown, minus people
  who left the room, became guests or can open it already; nobody is added.
- Shared files: `shared/src/tools.ts`, `server/src/chat/prompt.ts`, `server/src/chat/i18n.ts`, `server/src/chat/tools.ts`,
  `server/src/chat/store.ts` get small additive edits.
- Six languages for every new string.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, unit tests for every route of `who_can_open` and every
tap's permission check, web unit tests and a Playwright spec for the buttons, hands-on with the dummy or real AI recipe.

## Result

Built as planned, on `origin/dev` + `batch/prompts-1116` + `batch/1116c` (no PR opened: the coordinator opens it once
the batches are on dev).

- `who_can_open`, `accessRouteFor`, the offers (`Step.fixes`, `share_fix_offers`, `POST /api/share-fixes/:id/run`), Let
  them view, Ask <owner> (a request asked for other people), Ask an admin (a 1:1 message), Share with project, the move
  toast, "already open" in `share_with_person`, a path link opened through a share.
- Different from the plan: the offers show under the answer, not inside the step list (the list folds away once the
  answer is done). `who_can_open` marks the chat as holding other people's words (the batch's `chats.others_words`,
  added while this was built). "Already open" is said only where nobody else's words are in the turn.
- Not built: a Connect button for a Google app under the AI's sentence, and "Ask an admin" for a connection a member
  may not add (step 7 found the connect card of other services already finishes in the chat and goes on with the
  request). No AI tool moves a chat into a project, so there is no "the AI moved it" line.
- Checks: see the decision note's tests; hands-on on a private copy of the QA team with the scripted AI.
