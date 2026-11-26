# Chat, room and project menus share one item list; delete and leave go through one helper; one word per action

- Date: 2026-11-26
- Status: accepted
- Supersedes: in part, [Guests from Invite people](../DECISIONS.md#guests-from-invite-people-featinvite-people-guest-owner-2026-11-15)
  (초대하기 "right after the pin": now in the people-and-tools group); [Phones: the room header and the file viewer's bar](../DECISIONS.md#phones-the-room-header-and-the-file-viewers-bar-fixphone-room-header-viewer-2026-11-12-qa-tc-257)
  ("the duplicate rename comes out of the header's ⋯": a phone room header has 이름 바꾸기 again, as every other menu);
  [20261123-do-then-undo.md](20261123-do-then-undo.md) in its words only (the posted and share cards' "취소" and "지우기"
  are now "실행 취소" and "삭제"; what they do is unchanged)
- Branch: feat/shared-menus (the owner, 2026-11-26: "컴포넌트화, 공통관리", UX consistency package C)

- **Ask:** the 11-26 UX audit found the same action in a different place, with a different name and a different way of
  asking on each screen: Copy link 2nd in one menu and 9th in another, mute 2nd in the title menu and 6th in the row
  menu, "앱에서 열기" only in an AI chat's title menu, a project page's "수정" where its row says "이름 바꾸기", no
  rename in a phone room header; Undo after deleting a chat but not after trashing a project, no toast after deleting a
  scheduled task or leaving a group chat, "프로젝트 나가기" red in one menu and not in another; and several words for one
  action.
- **Rule: one item list.** `web/src/components/menus/entityMenu.tsx` holds every kind of item a chat's, room's or
  project's menu (its title menu and its rows' "···") may have, with its one label, icon and place:
  search (a room header's, first as ⌘F: [20261120-search-shortcuts-slack.md](20261120-search-shortcuts-slack.md));
  pin / unpin, section; notifications (a room's 알림 설정, a shared chat's 알림 끄기 / 켜기); copy link, open in the app;
  rename (a group chat's 비공개 채널로 만들기); move (to a project; make a project); share, members, invite, apps,
  continue in a chat only you see, project settings; then hide / show again, leave, delete — always last, leave and
  delete always in the danger style. Each surface says only which kinds it offers and what they do, and `orderMenu`
  puts them in this order. A phone's sheet still puts danger items under a line at its end (rooms/MenuButton.tsx
  sheetOrder), which this order already does; a phone room header's "threads with new replies" (a status) stays above.
- **Rule: open in the app everywhere a title menu is.** A chat's, a room header's and a project page's menu offer it by
  the same rule (a computer's browser on macOS, Windows or Linux, an https team: lib/team-link.ts `pageOpenInAppHref`);
  the desktop app already opens `/rooms/<id>` and `/projects/<id>` at once (desktop common/address.ts). Rows do not have
  it (a row opens the thing first).
- **Rule: a project page's menu** is its row's: Copy link, Open in the app, Rename (the row's prompt), then
  "Project settings" (the edit dialog that was "수정": its instructions and the shared-chats setting), Leave, Delete.
- **Rule: one destructive helper.** `web/src/lib/destructive.ts` `destructive({ confirm?, run, done })`: it asks only
  where a confirm is the rule today, never a new one (the direction of [20261123-do-then-undo.md](20261123-do-then-undo.md)),
  runs, then shows one toast with `common.undo` when the thing can be taken back. Chat delete (confirm, Undo), chat
  and room hide (Undo), chat, group chat and project leave (confirm, a "you left" toast; no undo: only someone in it can
  add me again), a project to the trash (confirm, **Undo** when the project the server answers with says
  `canRestore`; the undo is `trashProject`'s own restore on the same optimistic key, so a refusal says the server's
  words; someone it is not kept for, such as its creator who does not manage it, gets no Undo), a project deleted for
  good or any other project delete (confirm, a "deleted" toast), a scheduled task (confirm, a "deleted" toast; the
  server keeps no deleted task, so no undo). The AI's scheduled card keeps saying "deleted" in place.
- **Rule: one word per action** (en.ts is the meaning; all six locales):
  undo is "실행 취소" / "Undo" (`common.undo`) and bringing back from the trash is "되돌리기" / "Restore"
  (`common.restore`), as Google Drive's Korean has it; delete is "삭제" (`common.delete`), "지우기" stays for Clear,
  Discard and Remove, which are other actions; rename is `chat.rename`; copy link is `rooms.menu.copyLink`, link copied
  `rooms.menu.linkCopied`, copied `common.copied`; hide from my list is `chat.hide` for chats and rooms alike;
  "휴지통으로 옮기기" is `files.moveToTrash`; don't allow is `devEnvSite.deny` ("허용 안 함", not "거부"). In Korean
  one AI chat is "채팅" everywhere (not "기록" or "대화"); the list of them stays "기록" (트리나 기록) and a room stays
  "대화". The keys this removed are listed in `web/test/unit/shared-menus-guard.test.ts` (`MERGED`), which fails if
  one comes back.
- **Left out:** where the menus sit (an AI chat's name ▾ on the left, as Claude has it; a room's "⋯" on the right, as
  channel headers have it): the items and their order are what people read, moving them is a layout change for
  another time. Copy button behaviour and the message menus are package B's; the composers are package A's. Keys used
  only in their files keep their names with the canonical words (`rooms.copied` = `common.copied`'s words,
  `chat.edit` / `rooms.editLabel` = `chat.editMessage`'s) until B switches them.
- **Tests:** `web/test/unit/shared-menus-guard.test.ts` (the builders' real items come out in MENU_ORDER; a menu item
  is never labelled with a kind's key outside entityMenu.tsx; the confirm count in web/src does not grow; an undo toast
  is made only by destructive.ts or a file already on its list; the removed keys stay removed), `shared-menus.test.tsx`
  (the helper), `web/test/e2e/shared-menus.spec.ts` at 1440 and 390.
- **Version impact:** minor (menu items added and reordered, a new Undo; no API change).
