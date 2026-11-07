# A room's @트리나 reads shared project chats

- Date (UTC): 2026-11-07 13:44
- Branch: `feat/room-reads-shared-chats`
- Status: done
- Where: Team AX core (`server/src/chat`, `server/src/rooms`, `shared/src`). Why: rooms, chats and permissions are core
  (see docs/REPOSITORY-RULES.md).
- Version impact: minor. Two new AI tools in room sessions and one audit action; no API or database change.

## Goal

"@트리나 견적 프로젝트 채팅에서 뭐 정했는지 요약해 줘" in a team chat room works: the room's AI finds the shared project
chats the asker may view and reads one. The owner's rule: when every member of the room is in the project's audience,
the answer goes to the room; otherwise it stays private to the asker (the room's existing private preview).

## Scope

In:

- `project_chats` (list or search the shared project chats the asker may view: title, project, last activity, id) and
  `project_chat` (one chat's labelled transcript of its active branch, capped). Room sessions only, read-only, team
  files only: `ROOM_TOOLS`, `ROOM_FILE_TOOLS`, `ROOM_READ_ONLY_TOOLS`, `PARENT_ONLY_TOOLS`. Not in `SHARED_TOOLS` and not in
  a person's own chats.
- Read scope: what either tool showed joins the question's read scope as the project folder (`sourceOf`), whose readers
  are the chat's audience (`sharedChatAudienceCovers`); `decide()` then keeps the answer private for a member outside
  it. Team-file names in the transcript count as names read.
- Names: a step names a chat only when every room member sees its project; otherwise "프로젝트 채팅 읽기" alone.
- The transcript is data: every message labelled (the asker's own earlier ones too) as information, each message's
  text quoted line by line, inside a `<shared_chat>` block whose tags message text cannot write.
- Never: confidential chats, chats in the trash or in a project in the trash, unshared chats, room sessions; nothing
  while safe operations (1A) are on (the room AI is already off then).
- Audit `room.ai_shared_chats` when an answer used them: counts and where the answer went, never names or content.
- One line in the room instructions (they are English only; the answer language is set separately).

Out: paging further back in a long chat (the newest 40,000 characters, like a fresh session's transcript), a card
before reading, these tools in personal or shared chats.

## Steps

1. Plan (this file).
2. `shared/src` schemas and step words; `chat/shared.ts` read transcript; `chat/room-project-chats.ts` tools;
   allowlists, prompt line, audit in `rooms/ai.ts ended()`, audit label in the five languages.
3. Unit tests `tests/unit/b-rooms-ai-shared-chats.test.ts`, security `tests/security/room-reads-shared-chats.test.ts`,
   existing allowlist tests updated.
4. Docs: DECISIONS, PERMISSIONS, CHANGELOG.
5. Checks, independent security review, real-engine run, PR to `dev`.

## Risks

- Leaking a chat's title, content or existence to a room member outside the project: covered by the read scope, the
  neutral step label, and the same "not found" for every chat the asker may not read.
- A transcript posing as the room's context or a label: block tags neutralised, the container tag added to them, text
  quoted.
- Migrations: none.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, unit tests with the prefixes rooms, room-ai, chat,
shared, read-scope, prompt, the security suite, `test:web`, `build:web` and the full web e2e (audit label strings).

## Result

Built as planned. Differences and notes:

- No card: rooms decide this kind of read through the read scope and `decide()` (files, names, threads), so the
  project folder joins the scope and the existing private preview applies.
- The transcript uses `labelledTranscript`'s name escaping and `historyWindow`'s cap and tag neutralising
  (`readTranscript`), not `sharedTranscriptText` itself: that one wraps the text in `<previous_conversation>` with
  "continue from here", which would make the room's AI treat another chat as its own conversation, and labels the
  asker's own messages as theirs to follow.
- Under 1A turned on during a turn the confidential mode's own gate refuses the tools before they run.
- The instructions are English for every language, so one line was added.
- The e2e mock does not run the room's AI (rooms are page.route fixtures), so no e2e spec; unit and security tests
  cover it, and a real-engine run checked both outcomes.

- After the independent security review a listing looks, by default, only in the projects everyone in the room sees
  (`include_all` for the asker's other projects, which then count whatever matched), so the owner's rule still answers
  in the room; reading one chat counts its project only.

PR: https://github.com/trina-app/trina-ax/pull/174
