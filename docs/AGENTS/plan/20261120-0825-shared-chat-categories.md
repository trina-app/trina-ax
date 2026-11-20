# Chats: team categories made by admins instead of personal conversation folders

- Date (UTC): 2026-11-20 08:25
- Branch: `feat/shared-chat-categories`
- Status: done
- Where: server/src/rooms, shared/src/api, web/src (Chats panel). Why: the owner asked to replace "Conversation folders · only you" with categories an admin makes and everyone sees (see docs/REPOSITORY-RULES.md)
- Version impact: minor, a new user-visible feature (team categories) with new endpoints; nothing removed from the API

## Goal

Each person had to build their own "Conversation folders" in Chats, and nobody else saw them. The owner wants the team
grouped once: an admin makes categories (Monitoring, Internal …), puts channels in them, and everyone sees the same.

## Scope

In: a team-wide category list (make, rename, order, delete: admins and the owner); a channel's category, the same for
every member; the Chats panel and the phone's Chats tab show categories between Pinned and Channels; live updates.
Out: deleting the personal folder API and its data (hidden from Chats now, cleanup later); Trina's own AI-chat folders
(unchanged); DMs in categories.

## Steps

1. Migration 428: `room_categories` and `rooms.category_id` (additive, reader 1).
2. Contract `shared/src/api/room-categories.ts`, `Room.categoryId`, ws `roomCategories.changed`.
3. Server `rooms/categories.ts` and route module; admin-only changes via `auth: 'admin'`.
4. Web store and `nav/RoomCategories.tsx`; RoomsByKind and pages/Rooms.tsx draw categories; the room row menu offers
   "Move to category" to admins; the personal room folders are no longer shown.
5. Strings in the six app languages; tests.

## Decisions

[docs/decisions/20261120-shared-chat-categories.md](../../decisions/20261120-shared-chat-categories.md).

## Risks

Migration number 428 (highest b on dev was 427). Permissions: every change is admin-only on the server; a category
never changes who is in a room or what anyone can open. A member only sees the channels of a category they are in.

## Tests

`bun run typecheck`, `bun run check:prepush`, tests/unit/b-room-categories.test.ts, web/test/unit/nav-folders.test.tsx,
full tests/unit and tests/security. Checked by hand on a local server as owner and member (screenshots in the PR).

## Result

Built as planned. Admins only; channels only (a 1:1 or unnamed group chat answers 409 room_category_personal).
