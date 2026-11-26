# Shared chats: the asker's own tools work as in a private chat

- Date (UTC): 2026-11-26 11:30
- Branch: `fix/shared-chat-own-tools`
- Status: done
- Where: server (chat turn, connection tools, prompt), docs. Why: the owner asked Trina, in a five-person team project
  chat, to reply to a vendor with two PDFs and a business registration through their own Daum mail (Aside), and Trina
  refused ("team files can't go out from a shared chat; continue in a chat only you see").
- Version impact: minor (shared chats gain the browser and team-file attachments: new behaviour, nothing removed)

## Goal

In a shared chat the person who asked may use their own tools (connections, apps on their computer such as Aside, the
in-app browser) for their own request exactly as in a private chat (AI should match Claude Code; Rule A: teammates are
trusted). What others see is covered by the one "others may see it" notice per place (2026-11-23), and anything that
sends keeps its own card.

## Scope

In:
- Team-file attachments through a connection in a shared chat: no refusal. The files go through the chat's read check
  (someone here who cannot open one: the asker's file read card), then the send card as before.
- The in-app browser in shared chats, behind a one-time notice per place ("이 채팅의 다른 사람도 AI가 내 브라우저에서
  가져온 내용을 볼 수 있어요." [계속]); its pages join the answer's read record like the asker's own connection.
- Prompt: the browser leaves the "not available" list; one line says the asker's own tools work here as in a private
  chat; Trina says plainly that a team file cannot be attached through Aside or the in-app browser.
- An app on the computer (Aside) given a team-file handle: refused in plain words (its tools take code, not a file).
- Settings › Allowed for Trina lists the browser's notice and can reset it.
Out: a file upload tool for the in-app browser or Aside (no tool takes a file's content today).

## Steps

1. tools.ts: drop SHARED_NO_TEAM_FILES; after readTeamFiles in a shared chat call SharedConnections.attach (turn.ts
   confirmSharedAttach: sharedReadRefusal with the files' sources). Local apps refuse handles.
2. turn.ts: `browser = desktop` in shared chats; confirmSharedBrowser reuses confirmSharedConnection (notice kept in
   card_always_allow `seen:browser:<place>`: connector_tool_allow needs a connection row). chat/tools.ts lets the pane
   tools in and asks the notice before a call.
3. prompt.ts: SHARED_PROMPT_SECTIONS.browser on; shared section lines; BROWSER_RULES and ATTACH_HOW say what cannot attach.
4. Docs: decision file, chats-and-projects.md in every language, changes/, ASKS.md row.
5. Tests.

## Decisions

docs/decisions/20261126-shared-chat-own-tools.md (supersedes the team-file rule of 20261118-shared-chat-connections.md
and the browser exclusion of the shared chat allowlist).

## Risks

- Another member's message must never drive the asker's tools: each turn is its sender's (their connections, their
  window); tested.
- No migration (card_always_allow takes the notice rows).
- Six locales for the notice and the declined-file line.

## Tests

- b-shared-chat-connections: a team file everyone here can open → send card → sent; one some cannot open → file read
  card first; declined → nothing sent, the plain line.
- b-shared-connector-warning: the browser's one notice per place.
- c-local-apps-shared: a team file to Aside is refused plainly.
- Another member's turn never uses the asker's browser window or connection.

## Result

Built as planned. The notice for the browser is kept in card_always_allow (no migration). A team-file handle is refused
only where an app on the computer takes it as code or a task (Aside's repl/exec take no file's content: attaching team
files through Aside's web mail cannot work, and Trina now says so). Area tests under Bun 1.3.12: 1435 tests in 151 files,
all pass after one expected flip (b-shared-chats: browser now in SHARED_PROMPT_SECTIONS).
