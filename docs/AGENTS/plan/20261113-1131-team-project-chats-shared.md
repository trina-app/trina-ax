# Team project chats are shared by default, with a per-chat "Only me" lock (phases 1a and 1b)

- Date (UTC): 2026-11-13 11:31
- Branch: `feat/team-project-chats-shared`
- Status: done (not pushed; no PR yet)
- Where: Team AX core (`server/src/routes/chats.ts`, `server/src/chat/{shared,share-chat,chat-groups,prompt,members-only-once}.ts`,
  migration 292, `shared/src/api/chats.ts`, `web/src/pages/{Projects,Chat}.tsx`, `web/src/components/chat/*`,
  `web/src/components/ProjectForm.tsx`, `web/src/i18n/*`). Why: chats, projects and permissions are core
  (docs/REPOSITORY-RULES.md).
- Version impact: minor (a default changes for team projects, an optional API field, an update-only migration).

## Goal

The owner's decisions of 2026-11-13. A chat started in a team project (a project with members, its folder outside
`users/`) is seen and continued by the project's members by default. Before the first message of a **new** chat the
person may choose **🔒 Only me**; that chat stays private (it can be shared later with the existing "Share with project
members…", a shared chat never goes back). The next new chat starts shared again. The project switch "Share this
project's chats with its members" goes away. Existing private chats are never shared by the update. Personal projects
do not change. While safe operations (1A) are on, new chats are private and confidential and the box says why.

Supersedes the 2026-11-07 default ("Shared project chats", a project setting off by default) and D2 ("no per-chat
나만 보기").

## Scope

In, phase 1a (no behaviour change, less confusion):
1. The Projects panel's count: every chat of the project the viewer can open (theirs, and every shared one while they
   see the project), never another person's private chat (`chat/chat-groups.ts projectActivity`).
2. One not-found text for every 404 of a chat; the owner and admins keep the "add yourself in Projects" line. The
   server's 404 body does not change. (Reuses the tests of the unmerged `fix/project-chat-share-not-found`.)
3. Copy link of a private chat in a team project: "Only you can open this chat. People you send the link to can't."
   with the action **Share with members**.
4. A project page chat row's ⋯: **Share with project members…** for the creator's private chats in a team project.

In, phase 1b:
1. Store: `projects.share_chats` stays the stored truth (a rollback build behaves the same). Migration 292 sets it to 1
   for every team project and writes one audit row `project.share_chats` per changed project (actor system,
   `{on: true, reason: 'default'}`). `createProject` (team) and `shareProject` set it to 1, and so does a leftover folder
   adopted as a project. `PATCH /api/projects/:id {shareChats: false}` → 409 `share_chats_always` (the field stays so
   older apps parse). Sharing one chat (`POST /api/chats/:id/share`) needs a team project, not the setting.
2. `CreateChatBody.private?: boolean`: `shared = sharesNewChats(p) && !body.private`. The lock in
   `NewChatComposer` (the project page and every place a project's new chat starts), 44 px on phones; it does not stick.
   A private chat in a team project shows a lock in its rows (only its creator ever sees it).
3. Wording, English first, then ko, id, ja, es (below).
4. A shared chat asked for a personal tool: the AI's instructions say it plainly and point to **Continue in a chat only
   you see** (the chat title menu), which opens a new private chat in the same project with the person's last question
   in the box.
5. A one-time notice on a team project page for a creator with private chats there: "🔒 {N} chats only you see ·
   choose chats to share", opening a list of those chats, each with the existing per-chat share (no bulk share).
6. The switch and its strings (`projects.shareChats*`) go in all five languages.

Extra (coordinator): the "Bring in chats" dialog says brought-in chats stay private; a member removed from a team
project while their turn in a shared chat runs or waits: the turn stops and they get nothing more (checked, fixed if
not).

Out (phase 2): bulk share, per-viewer unseen markers, live answers for viewers.

## Wording (en)

- Box line, team project: "👥 New chats are seen and continued by the project's {n} members." + toggle "Only me".
- Lock on: "🔒 Only you see this chat · your apps and memories work here".
- Empty team project: "No chats yet. Ask here and every member sees it."
- Personal → team confirm: "{names} can see and edit this project's files and instructions. Chats started here from now
  on are shared with them too. Your {N} chats so far stay yours (you can share them later). This can't go back to only
  you."
- Safe operations: "Because of your team's security settings, new chats are only yours for now."
- Not found: "This chat can't be opened. It may be a chat only its creator can see, it may have been deleted, or it may
  belong to a project you're not a member of. Ask the person who sent the link to share it with the project's members."
- Bring in: "Chats you bring in stay visible to you only. To show them to members, use Share with project members."

## Risks

- Security: a `private` chat becomes shared only through `POST /api/chats/:id/share`; counts and lists use the same
  "may open" rule as `chatFor('view')`; the 404 body stays the same for a missing and a private chat.
- Migration number: 292 is the next free number of component B on dev; renumber right before merge if taken.
- The five languages; phone 390 (the lock's 44 px target), light and dark.

## Tests

`bun run typecheck`, `check:i18n`, `check:docs`, `docs:api` + `docs-site`, the unit tests of the touched areas
(`b-shared-chat*`, `b-chat-groups`, `b-share-existing-chat`, `b-project-*`, `security/shared-project-chats`,
`permission-matrix`, `p4-route-coverage`, `server-app` migration ranges), a new `b-team-project-chats-shared`,
`test:web`, the full web e2e.

## Result

Built as planned on `feat/team-project-chats-shared`, migration 292. Differences: "Continue in a chat only you see" is
in the chat's title menu only (not also under the box: lean UI, and the AI names that one place); its question is kept
in the window, not in the address's state (a phone's tab stack may go back to the project page's own entry). Sharing
one chat no longer needs the project setting, only a team project. Found while building: the AI's members tool and the
other own-chat tools now need an "Only me" chat in a team project (a shared chat never had them); a member removed
while their turn ran in a shared chat kept it running (fixed, `stopTurnsIn`). Not pushed, no PR yet.
