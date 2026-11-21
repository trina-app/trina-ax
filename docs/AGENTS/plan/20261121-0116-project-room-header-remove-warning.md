# Project room: one-line header on a phone, and the remove confirm names the chat room

- Date (UTC): 2026-11-21 01:16
- Branch: `fix/project-room-header-remove-warning`
- Status: in progress
- Where: web/ (pages/Room.tsx, components/GuestTag.tsx, components/ProjectMembersDialog.tsx, i18n). Why: QA walk of #182 on a private QA copy (QA sheet TC-6127, TC-6128).
- Version impact: patch (two small web-only UI fixes)

## Goal

1. TC-6127 (P3): at 390 px "3 members · Includes 1 guest" wraps to two lines in a project room's header; the header grows
   from 40 to 56 px and the title touches the top edge.
2. TC-6128 (P3 wording): the "Change the members?" confirm says only "1 person loses access: <name>". Removing someone
   from a project also removes them from its chat room and its history; say so, as the add dialog does.

## Steps

1. Room header on a phone: the count line is one line (`truncate`), and the guest part uses a short form ("3 members · 1 guest",
   new key `guest.includesShort`). Computers keep "Includes 1 guest".
2. Confirm: a new line `projects.loseRoom` under the access line when people are removed and the project has a chat room.
   English first, then ko (대화방), ja, zh, es, id.
3. Tests: unit for both; e2e asserts the header is 40 px at 390 with a guest in the room.

## Decisions

Same words as `projects.widenRoom` mirrored for removal. No change to who loses access.
