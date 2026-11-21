# A shared chat's header says who shared it

- Date (UTC): 2026-11-21 05:10
- Branch: `feat/shared-chat-header-sharer`
- Status: done
- Where: web/ (chat header). Why: a recipient of a chat shared with people saw only its title and a people icon, with no
  sign of who shared it (owner, 2026-11-21)
- Version impact: patch, a small change to an existing screen with no new API

## Goal

Someone who opens a chat another person shared with them (`Chat.shared.kind === 'people'`) sees the chat's name and
who shared it in the header: "Shared by Muhammad Rayandika" / "Muhammad Rayandika님이 공유", with a small avatar.

## Scope

In:
- The chat header (web/src/pages/Chat.tsx) of a people-shared chat, for anyone but its creator: a muted "Shared by
  {name}" with the sharer's face after the title on a computer, a second muted line under the title on a phone.
- The sharer is `Chat.shared.by`: only the creator can share such a chat (server/src/chat/people-share.ts
  `chat_share_creator_only`), so the creator is always the one who added each person. No API change.
- A long title truncates on one line and shows the whole name as a tooltip.
- i18n in the 6 languages.

Out:
- Project chats keep "Project / Title"; nothing is added there.
- The creator sees no "Shared by" (the people count already says who sees it).
- Nothing about the other recipients beyond the existing count.

## Steps

1. `SharedByLine` in web/src/components/chat/SharedChat.tsx (avatar from the people directory, name, truncate).
2. Chat.tsx: show it for a people-shared chat whose `shared.by` is not me; phone: under the title, inside the 48px bar.
3. Tooltip with the full title on the title button (components/TitleMenu.tsx, plain heading in ChatTitleMenu.tsx).
4. Keys `chat.sharedBy` in en, ko, ja, zh, es, id.
5. Unit test for the rule (who sees the line); e2e at 1440 and 390, light and dark: recipient, creator, project chat.
6. changes/shared-chat-header-sharer.md.

## Decisions

none

## Risks

No migration. Privacy: `shared.by` already reaches everyone who can open the chat. Phone: the bar stays 48px, the
title button keeps its 44px target.

## Tests

`bun run typecheck`, `bun run check:prepush`, web unit tests, e2e for the chat header.

## Result

Built as planned, with no API change: `Chat.shared.by` is the sharer. `sharedByOf` and `SharedByLine` are in
web/src/components/chat/SharedChat.tsx, so lib/sharedChat.ts is unchanged. On a phone the line sits in the title
button's lower padding and lets taps through, so the bar stays 48px. Tests: web/test/unit/shared-chat-sharer.test.tsx
and web/test/e2e/shared-chat-header-sharer.spec.ts (recipient, creator, project chat at 1440 and 390, light and dark
screenshots with SHOTS_DIR).
