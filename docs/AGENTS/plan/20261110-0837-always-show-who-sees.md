# Always say who sees a chat — 누가 보는지 늘 한 줄로

- Date (UTC): 2026-11-10 08:37
- Branch: `feat/always-show-who-sees`
- Status: done
- Where: trina-ax core (web chat box and chat page, `server/src/chat/shared.ts`, the shared API types). Why: chats and
  permissions are core (see docs/REPOSITORY-RULES.md)
- Version impact: minor, a line that shows on every project chat box and open chat, and one optional response field

## Goal

The owner: "진짜 누가 볼 수 있는지 모르겠어서 개 헷갈리네". A project chat says who sees it only when other people do
("프로젝트 사람 N명이 볼 수 있어요"). Under a project page's box, and on a phone under an open chat, a chat only its
person sees says nothing, so "is this shared?" has no answer. Now one quiet line always says who sees it. For whoever may
change the project's members it opens the members dialog (#298).

## Scope

In:
- The line under a project's new-chat box (the project page and `/?project=`) and under an open chat's box, for every
  chat: a team project, a personal project, no project. On a computer it sits in the row under the box (after "AI는 실수할
  수 있어요. 중요한 내용은 확인해 주세요." in an open chat, in place of "내 채팅은 나만 볼 수 있어요"); on a phone it is
  the one line under the box.
- The words:
  - a chat of one person, or a shared one nobody else sees: "나만 봐요";
  - a shared one that others see only because they are the 팀장 or an admin: "나와 관리자만 봐요";
  - otherwise today's "프로젝트 사람 N명이 이 채팅을 볼 수 있어요." (the box: "새 채팅은 프로젝트 사람 N명이 볼 수 있어요.").
  - All in ko, en, es, id and ja.
- The line is a button only for a shared chat (or a box whose new chat will be shared) and only when the person may change
  the members (`Project.membersEditable`). It opens `ProjectMembersDialog`. Otherwise it is plain text: a personal project
  is never shared, and in a chat of one person the members do not change who sees it.
- Server: `Project.alone`, optional and only `true`. It means that nobody but the caller sees the project by a rule of
  its folder. The check is role-blind, and it goes only to who may read the rules (below). The chat page takes it from
  the chat's project.

Out: the Home box without a project (on a computer its page footer already says "내 채팅은 나만 볼 수 있어요"); the
trash and safe-operations (1A) lines under a chat (unchanged); the header's shared mark; the edit dialog's sharing switch; a
hint for people who may not change members (#298's hint stays on the 멤버 line); any new panel or button.

## Decisions

- **How the count treats admins.** `Project.audience` and `Chat.shared.audience` count everyone who can read the folder,
  the 팀장 and every admin included, for every caller (`chat/shared.ts Audiences.of`). #304 (open when this was planned, merged since) changes
  only the new-project dry run (`adminsApart`) and leaves these counts as they are. Nobody else ever sees a chat of one
  person, admins included (`chatFor`). So:
  - not shared → "나만 봐요". This is exact: admins cannot open it.
  - shared and the count is 1 → "나만 봐요". This is exact: the count includes the admins, so there is nobody else.
  - shared, and nobody else sees it by a rule (`alone`) → "나와 관리자만 봐요". Without this, a member alone in their
    shared project would read "프로젝트 사람 3명이 볼 수 있어요" and not know who. It names nobody, only the rule:
    "관리자", with the 팀장 included, as in "멤버는 관리자가 바꿔요".
  - otherwise → "프로젝트 사람 N명이 볼 수 있어요", with N as today (팀장 and admins included).
- **`alone` is role-blind.** Each other person in the audience is checked as if they were a member (`rules.access` with
  the role member). Someone who sees it through a person, group or everyone rule counts as "by a rule", whatever their
  role. So an admin who made a project for one member counts as an ordinary member there. The people directory hides
  roles, and that is #304's concern.
- **`alone` only for who may read the rules** (changed after the independent review). It goes to the owner, admins and
  whoever may change the members (`membersView`); they can read the participants anyway (GET access). To any other member
  `true` would say that everyone else who sees it is an admin, and with a name beside it (whose question is answered, a
  creator switched off or whose rule was taken out) who is one. They read the count.
- **#304.** If members' counts later leave the admins out (#304's `adminsApart` applied to `Project.audience`), `alone`
  stays right. A member's count of 1 would then also need "나와 관리자만". This is noted in DECISIONS.
- **Clickable only when shared.** In a team project that does not share chats, adding a member does not change "나만
  봐요", so the line opens nothing there.
- **After a save in the members dialog** the dialog reads the project again (`GET /api/projects/:id`), so the server
  gives both `audience` and `alone`. The chat page reads its chat again.

## Steps

1. Plan (this file).
2. Server: `Audiences.alone`, sent as `Project.alone` from `chat/project-access.ts membersView`; the field in
   `shared/src/api/entities.ts`.
3. Web: `lib/sharedChat.ts whoSees` and `components/chat/WhoSees.tsx`; Composer `who` replaces `phoneFooter`;
   NewChatComposer and the chat page use them; both open the members dialog; the dialog reads the project again after a
   save.
4. i18n in five languages, the mock server (`alone`), DECISIONS and CHANGELOG.
5. Tests and screenshots.

## Risks

- No migration.
- Permissions: one boolean per project and chat, role-blind (above).
- Cost: one pass over the audience per project. The list page already computes the audience; each admin gets one
  `rules.access` call.
- Phone: the same single line. The button takes taps from a 44 px box without growing (`touch-hit`).
- Five languages.
- Existing tests that expect "내 채팅은 나만 볼 수 있어요" under an open chat need updating.

## Tests

- Checks: `bun run typecheck`, `bun run check:i18n`, `bun run check:docs`.
- Server unit test for `alone`: the owner alone, a member alone, a member with someone else, an admin who made a project
  for one member (role-blind), and a member who may not read the rules with only admins left.
- Web unit test `who-sees.test.tsx`: only me vs N people, an admin vs a member caller, and clickable only when editable
  and shared.
- e2e `shared-project-chats.spec.ts`: a project with only me says "나만 봐요", and adding a member in the dialog changes
  it to "2명". Also `project-participants.spec.ts`, `chat-look.spec.ts` and `share-existing-chat.spec.ts`.
- Screenshots at 1440 and 390, light and dark.

## Result

Built as planned:
- Server: `Audiences.alone` in `server/src/chat/shared.ts`, sent as `Project.alone` by `chat/project-access.ts
  membersView` to the owner, admins and whoever may change the members. The field is in `shared/src/api/entities.ts`.
- Web: `lib/sharedChat.ts whoSees` and `components/chat/WhoSees.tsx`. Composer `who` replaces `phoneFooter`.
  NewChatComposer and the chat page use the line; it opens the members dialog from the project page and from an open
  shared chat. The dialog reads the project again after a save.
- Five languages and the mock server.

Differences from the first draft of this plan:
- The independent review found that `alone` sent to every viewer could tell a member who is an admin (a name beside it:
  whose question is answered, a creator switched off). It now goes only to who may read the rules. `Chat.shared.alone`
  was dropped; the chat page reads it from the chat's project.
- An open chat shows the line once the chat is loaded, not "나만 봐요" before. The button's tooltip says "멤버 관리".
- The line under `/?project=` on Home is plain text. The dialog lives on the project page, and Home does not load it.
- `chat-look.spec.ts`'s "the chat's name opens rename and delete" failed on dev too (focus); it passes after the rebase.
- The coordinator asked for the project page's 멤버 line (#298's `MembersRow`) to use the same words by the same rule
  and the same `alone` ("나만 봐요" instead of "1명이 봐요"). It does, through one helper, `whoSeesText`. The members
  dialog's count of the people being chosen (`AccessSummary`) is unchanged.

The PR link is in the pull request.
