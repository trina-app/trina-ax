# A deleted team skill opens the files trash; a private @트리나 answer counts as unread live too

- Date (UTC): 2026-11-08 09:30
- Branch: `fix/skill-trash-room-unread`
- Status: done
- Where: Team AX core (web app, `server/src/skills/changes.ts`). Why: team skills, files and rooms are core (see
  docs/REPOSITORY-RULES.md)
- Version impact: patch, two bug fixes with no contract or migration change

## Goal

Two small bugs a design audit of dev found.

1. On 팀 스킬 › 최근 변경 a "삭제" row has a "삭제한 기록" button, and the skill-change notice for a deleted file has a
   link; both go to `/trash`, which lists deleted AI chats only. The deleted skill file is in 파일 › 휴지통, a tab with
   no address of its own. Owners and admins land on the wrong list.
2. A private @트리나 answer (visible only to the asker) counts as unread for the asker on the server, but the web adds to
   the live badge only for messages to the whole room. A member asks @트리나 in a room and opens another room: the sidebar
   and the dock badge show 0, after a reload 1.

## Scope

In:
- 파일 › 휴지통 gets an address, `/files?view=trash`, like `?view=people` in Admin › Folder permissions. The tabs
  follow the address, so Back and a reload keep the tab.
- The 최근 변경 button of a deleted file and the server's notice link go there. The button reads the trash tab's own
  word (`files.trash`, "휴지통"). The notice's button keeps "열기".
- The web's live count no longer tests `visibility === 'room'`: the server sends a room.message only to those who may
  see it (`canSee`), so the server is the one judge of who sees what, and a message that reached me counts as the
  server counts it. It also counts only after my read position (the server's `seq > last_read_seq`): sharing my
  private answer from my phone reads the room up to it first (room.read), so another window no longer adds 1 for it.

Out:
- Old notices that still carry `/trash` stay as they are (they open the chats list, as before).
- Sending each member's unread count with every room.message: one count query per member per message (hundreds in the
  everyone room) for a rule the client can follow from what it is sent.

## Steps

1. `web/src/pages/Files.tsx`: the view from `?view=trash`; the tabs set the address (other parameters kept); the
   "folder gone" climb keeps the trash view.
2. `web/src/pages/Skills.tsx` and `server/src/skills/changes.ts`: the delete link `/files?view=trash`; the button label
   `files.trash`. `web/src/store/live.ts`: the notice's "열기" for that link too. The mock server records a skills file
   it moves to the trash as a 삭제 change.
3. `web/src/store/rooms.ts` `withMessage`: no visibility test; nothing at or before my read position counts.
4. Tests, docs (DECISIONS.md, CHANGELOG).

## Risks

- The files screen's other parameters (`path`, `select`, `q`, `history`) stay in the address when the tab changes, as
  the tab state kept them before.
- No migration, no permission change, no new strings (five languages unchanged).

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, the skills and rooms unit tests
(`tests/unit/skill-*`, `tests/unit/*rooms*`), `bun run test:web`, `bun run build:web`, the e2e specs for rooms, team
skills and files.

## Result

Built as planned, plus what the review found:

- 파일 › 휴지통 is `/files?view=trash`. The tabs and the "folder gone" climb read the tab from the address itself
  (`window.location`, as Admin › Folder permissions does): the listing's callback lives as long as the folder and held
  the address from before a tab switch, so the climb could leave the trash. Clicking the tab already selected adds no
  Back step.
- 최근 변경's 삭제 row reads 휴지통 with the trash icon and opens the files trash; so does the server's notice (button
  열기). Old `/trash` notices are unchanged.
- `withMessage` counts what the server sends me (no visibility test) after my read position. The dock badge follows
  the room's notify level, so in a team room at the default (mentions) a private answer shows on the room's row only,
  as after a reload.
- PR: see the pull request for this branch.
