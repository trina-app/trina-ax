# The Projects place shows its unread mark: the rail, the phone tab and the app icon

- Date (UTC): 2026-11-22 05:01
- Branch: `fix/projects-rail-badge` (stacked on #339 `fix/shared-chat-new-message-notices`; compatible with #321)
- Status: done
- Where: web (rail, phone tab bar, session markers), shared (attention count), server (push badge). Why: the Projects
  list showed an unread "1" on a team project while the rail's Projects icon had no mark (the owner, 11-22: "팀프로젝트에
  알림이 있는데, 프로젝트 아이콘에 알림이 없는게 이상한듯"; "모바일도 잘 생각해줘").
- Version impact: patch (a mark and a count that were missing; no new API, no migration)

## Goal

What makes a project's row show a number in the Projects list also marks the Projects place: the rail's icon on a
computer, the 프로젝트 tab on a phone (web at 390 and the iPhone and Android apps, which load the same web UI). The app
icon's number (desktop Dock, installed web app, phone app, a push's badge) counts the same mentions. Opening the chat
or the thread clears the row and the place's mark at once, on every device (the Inbox's notificationsChanged).

## Scope

In:
- `rail/railBadges.ts projectsMark`: how many projects have something for me, as 대화 counts conversations (not
  messages): a thread mention of me there that I have not read (store/chatMentions.ts byProject, the list's own count),
  or a chat of it with unread messages for me that I did not mute (#339's `Chat.unreadCount`, summed by the chat's
  project; the server sends it only for chats shared with people today, which are never in a project, so today the
  mentions carry it).
- Rail.tsx and BottomTabs.tsx show it (count style of 대화; words for a screen reader in six languages).
- The one count n (`attentionCount`'s new `mentions`): my unread thread mentions add to the Dock, the installed web
  app's icon, the phone app's icon and a push's badge (server/src/notifications/push-badge.ts counts the same notices).
  The 트리나 mark does not change (`chats` stays the AI chats' part).
Out: the project room's own unread messages (a room: 대화 counts it and it opens there; the row's chat icon keeps its dot);
plain followed-thread replies without a mention (the list does not count them: 대화's 멘션·스레드 after #321).

## Steps

1. This plan.
2. web + shared + server, unit tests.
3. Screenshots 1440/390 light/dark in a QA team; PR into dev.

## Decisions

none new (follows docs/decisions/20261120-project-chat-accordion.md counts and railBadges' one-count-per-kind rule)

## Risks

- Counted on two places: a thread mention in a project chat marks 프로젝트, and after #321 also 대화's 멘션·스레드 dot
  (a dot, not a number). The app icon counts it once.
- Phone push badge: one more query per push (bounded to 500 notices).

## Tests

`bun run typecheck`, `bun run check:prepush`, web unit (rail, session markers, bottom tabs), server push badge unit,
web e2e for the rail.

## Result

Built as planned, plus one fix found in the QA copy: a chat opened straight by its address (a reload, a link) mounted
before the mentions were read, so it never read them and the rail kept its mark; pages/Chat.tsx now reads them once
they are known. Checked in a copy of the local QA team (1440 and 390, light and dark; a second window cleared without a
reload): shots in the shared shots-projbadge folder. Unit: rail-badges, session-markers, b-chat-thread-mentions (push
badge); e2e: projects-rail-mark.spec.ts with the rail, session-markers and phone-tab specs.
Found, not this branch's: tests/unit/b-shared-chat-message-push.test.ts fails on #339's head too (badge [2, 4], not
[1, 2]), with the mention count turned off.
