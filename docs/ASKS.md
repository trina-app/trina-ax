# Ask registry: every place the product asks the person

One list of every card, confirm dialog and system prompt the product shows before it does something: the AI's cards
(server checks and the AI's own questions), connector, site and command cards, Slack's post buttons, the web app's
confirm dialogs, and the system prompts of the desktop, menu bar and phone apps. Built from the code on `dev`
(2026-11-22, 0.14.1-dev; updated 2026-11-23 for [decisions/20261123-do-then-undo.md](decisions/20261123-do-then-undo.md), which removed 11 screen dialogs: the delete and move-to-trash confirms, remove and stop sharing, restore version, a folder-sharing row, sign out and the four "project skills switch on" notices, now an Undo toast or a notice); file:line points at the line that raises the ask. Decision:
[decisions/20261122-ask-registry.md](decisions/20261122-ask-registry.md). Rule A:
[decisions/20261116-always-allow-final-rule-a.md](decisions/20261116-always-allow-final-rule-a.md) and
[decisions/20261122-always-allow-holds-everywhere.md](decisions/20261122-always-allow-holds-everywhere.md).

`tests/unit/ask-registry.test.ts` fails when the code has an ask this list does not (see "Code index").

## How to add a new ask

1. Raise it through one of the existing calls (server: `askPerson`, `askAlways`, `withAlways`, a TurnPerson `confirm` /
   `askConfirm`; web: `confirmDialog`, `choiceDialog`, `useConfirmStep`; apps: the dialog helpers named in the Code
   index). A hand-built confirm (a `Modal` or an inline strip) gives its container or button a `data-testid` that ends
   in `-confirm` so the scan sees it. A new way of asking adds its pattern to `SCANS` in the test.
2. Add its entry below, in its category, with every field. No field is empty: write `none` or `n/a` with a reason.
3. Decide **Always**: an AI card for the person's own action that can come again offers "Always allow" on the first
   card, per person and card kind (a new kind goes in `CARD_ALWAYS_KINDS`), and the Always holds in every chat and in
   the person's own scheduled runs (Rule A). No Always only for a one-off destructive step, an admin action, a
   sign-in, or an operating-system prompt, and the entry says so.
4. Give a **revoke path**: Settings › 트리나에게 허용한 것 (GET/DELETE `/api/ai-allowances`) for the AI's cards, the
   setting that holds the choice, or a written reason there is none.
5. Set **Rule A**: OK, VIOLATION (it asks again for the person's own action after Always, per chat or per call) or
   OPEN (an owner decision is needed). A new VIOLATION needs the owner's OK in the PR.
6. Update the file's row in "Code index" (the number of matching lines and the ids) and, for a new kind, "Kinds".
7. Decide **auto mode** for a new kind: its `auto` value in "Kinds" (`ask` unless the card is free of the floor of
   [decisions/20261125-auto-mode.md](decisions/20261125-auto-mode.md)), and the same value in `AUTO_KINDS`.

## Fields

- **id**: stable and dotted, the area first in lowercase (`share.file`, `ui.files.delete`, `os.mac.mic`).
- **where**: the file and line that raise it (lines drift; the test checks the file).
- **trigger**: when it shows, and when it is skipped.
- **text (en / ko)**: the title or question, cut with … when long, and the i18n key.
- **buttons**: the labels in English.
- **always**: none; `card:<kind>` (per person and card kind, table `card_always_allow`); per connector tool; per site;
  per room; or what the code keeps. There is one Always per person: it holds in every chat (a shared chat with a guest
  too) and in their scheduled runs, and no card offers an Always for one chat (decision 20261123-one-always-allow).
- **revoke**: where the person takes it back.
- **scheduled**: what happens in a scheduled run (nobody watches it): runs under Always, refused at once, waits in the
  call, or n/a.
- **guests**: what changes when a guest is the person or is among the people.
- **reason**: sends-to-others, shows-private-to-others, irreversible, security, cost, or other:<word>.
- **rule A**: OK, VIOLATION: <why>, or OPEN: <the decision needed>.

Common to the AI's server cards: the card shows only to the person whose turn it is; in a shared chat the others see
"waiting for {name}". Cards of the tools in `CARD_LATER_TOOLS` wait after the answer ends and the call runs again with
the answer (decision 20261119-safety-cards-wait). With the team switch "Always allow" off (Admin › Team AI settings),
no card offers Always. A confidential chat keeps no Always.

## Summary

"With Always" counts asks that remember the answer (an Always option, a per-site or per-version memory, a
switch); "ask every time" counts the rest (most are one-off confirms of the person's own press).

| category | asks | with Always | ask every time | VIOLATION | OPEN |
|---|---|---|---|---|---|
| My files and folders (내 파일·폴더) | 13 | 13 | 0 | 0 | 0 |
| Sending and sharing (다른 사람에게 보내기·공유) | 19 | 9 | 10 | 0 | 0 |
| Connectors (커넥터) | 16 | 6 | 10 | 0 | 0 |
| Websites (웹사이트) | 8 | 5 | 3 | 0 | 0 |
| Commands and dev environment (명령 실행·개발 환경) | 3 | 3 | 0 | 0 | 0 |
| Memory, skills and schedules (기억·스킬·예약) | 13 | 8 | 5 | 0 | 0 |
| Rooms (대화방) | 5 | 4 | 1 | 0 | 0 |
| AI questions (AI의 질문) | 2 | 0 | 2 | 0 | 0 |
| When guests are there (게스트가 있을 때) | 4 | 0 | 4 | 0 | 0 |
| Screen confirm dialogs (화면 확인창) | 102 | 4 | 98 | 0 | 0 |
| Sign-in, setup and updates (로그인·설정·업데이트) | 15 | 7 | 8 | 0 | 0 |
| System permissions (시스템 권한) | 21 | 18 | 3 | 0 | 0 |
| **all** | 219 | 75 | 144 | 0 | 0 |

## Registry

### My files and folders (내 파일·폴더)

| id | where | trigger | text (en / ko) | buttons | always | revoke | scheduled | guests | reason | rule A |
|---|---|---|---|---|---|---|---|---|---|---|
| `save.wider` | `server/src/chat/turn.ts:4904` | A save where more people can see than can see what the chat read. Skipped: same sources allowed for that folder in this answer or by the 12 h approval in this chat, the person named the place, schedule cover, or a project chat saving into its own folder from the person's own files where only people of the chat see it (docs/decisions/20261123-do-then-undo.md). | Save {file} to {area}, where {n} people can see it? / {area}에 {file} 저장할까요? {n}명이 볼 수 있는 곳이에요. (`widenConfirm`, `widenWhy*`) | Save / Always allow / Don't save | `card:save_wider`; yes also keeps a 12 h approval | Settings › 트리나에게 허용한 것 | runs under Always or cover, else refused | Always holds with a guest too (one Always, decision 20261123-one-always-allow) | shows-private-to-others | OK |
| `share.save` | `server/src/chat/turn.ts:4471` | In a shared chat, a save into a place some people in the chat cannot open. | The AI wants to save a file in {sources}. {m} of {n}… can't open it… / AI가 {sources}에 파일을 저장하려고 해요… (`sharedSaveConfirm`, `sharedSaveManyConfirm`) | Save / Always allow / Don't save | `card:shared_save` | Settings › 트리나에게 허용한 것 | runs under Always (a guest among the people: refused) | Always holds with a guest too (one Always, decision 20261123-one-always-allow) | shows-private-to-others | OK |
| `share.chat_file` | `server/src/chat/turn.ts:4471` | A new file or version in a shared chat's files built from sources some people there cannot open (`confirmChatTarget`). | the `share.read` / `share.copy` words | Read and share / Always allow / Don't read | `card:shared_read` | Settings › 트리나에게 허용한 것 | as `share.read` | as `share.read` | shows-private-to-others | OK |
| `files.delete` | `server/src/chat/delete-files.ts:350` | `delete_files` with a plan. No card for the AI's own files from this chat; none after a no in this answer. Refused up front in a shared chat and a chat others wrote in, unless the person's Always is on (Rule A). | The AI wants to move {n} items to the trash… Move them to the trash? / AI가 {n}개 항목을 휴지통으로 옮기려고 해요… (`DELETE_TEXT.ask`) | Move to trash / Always allow / Don't | `card:delete_files` | Settings › 트리나에게 허용한 것 | runs under Always, else refused | Always holds with a guest too (one Always, decision 20261123-one-always-allow); a guest's own card where things can be restored | irreversible, shows-private-to-others | OK (decision 1: Always holds in shared chats; decision 20261123-ask-registry-findings) |
| `files.move` | `server/src/tools/file-moves.ts:255` | `move_files` when who can see changes (or after a room read). Skipped when the person's own message named the place and only more people gain access. | The AI wants to move {n} items to {to}… Move them? / AI가 {n}개 항목을 {to} 폴더로 옮기려고 해요. (`move`, `askMove`) | Move / Always allow / Don't | `card:move_files` | Settings › 트리나에게 허용한 것 | runs under Always (`TurnPerson.alwaysOn`), else refused (`unattended`) | Always holds with a guest too (one Always, decision 20261123-one-always-allow) | shows-private-to-others | OK (fixed: decision 20261123-ask-registry-findings) |
| `files.copy` | `server/src/tools/file-moves.ts:255` | `copy_files`, the same rule (skipped when the same file is there). | The AI wants to copy {n} files to {to}… Copy them? / AI가 파일 {n}개를 {to} 폴더에 복사하려고 해요. (`copy`, `askCopy`) | Copy / Always allow / Don't | `card:move_files` | Settings › 트리나에게 허용한 것 | as `files.move` | as `files.move` | shows-private-to-others | OK (fixed: as `files.move`) |
| `files.copy.places` | `server/src/chat/places-copy.ts:429` | `copy_files` from the chat's files or work folder into a team folder after a room read. Skipped for new files in the person's own folder. | The AI wants to copy {n} files to {to}. Copy them? / AI가 파일 {n}개를 {to} 폴더에 복사하려고 해요. 복사할까요? | Copy / Always allow / Don't | `card:move_files` | Settings › 트리나에게 허용한 것 | runs under Always (`askConfirm` reads it first), else refused | Always holds with a guest too (one Always, decision 20261123-one-always-allow) | shows-private-to-others | OK (fixed: as `files.move`) |
| `files.bulk.move` | `server/src/tools/file-moves.ts:143` | More than 3 moves in one answer in places others see. A yes covers the rest of the answer. | The AI wants to move {n} items that {people} other people see to {to}… / AI가 {people}명이 함께 보는 곳에서… (`bulkMove`, `bulkRest`) | Go ahead / Always allow / Don't | `card:move_files` | Settings › 트리나에게 허용한 것 | not asked, goes on | Always holds with a guest too (one Always, decision 20261123-one-always-allow) | other:bulk-change | OK |
| `files.bulk.rename` | `server/src/tools/file-moves.ts:143` | The same, for renames. | The AI wants to rename {n} items that {people} other people see. / …이름을 바꾸려고 해요. (`bulkRename`) | Go ahead / Always allow / Don't | `card:move_files` | Settings › 트리나에게 허용한 것 | not asked | Always holds with a guest too (one Always, decision 20261123-one-always-allow) | other:bulk-change | OK |
| `download.big` | `server/src/tools/save-url.ts:259` | `save_url` of a file over 1 GB. | The AI wants to download a large file. This file is {size}… / AI가 큰 파일을 받으려고 해요… (`large`, `largeUnknown`) | Download / Always allow / Stop | `card:big_download` | Settings › 트리나에게 허용한 것 | runs under Always (`TurnPerson.alwaysOn`), else skipped | Always holds with a guest too (one Always, decision 20261123-one-always-allow) | other:disk | OK (fixed: decision 20261123-ask-registry-findings) |
| `folder.access` | `server/src/chat/folder-access-tool.ts:298` | `change_folder_access`, one change (owner or admin). | Give {who} view access to {folder}? … Take {who} off {folder}? / '{who}'에게 {folder} 폴더 보기 권한을 줄까요? (`askAddView`, `askRemove` …) | Change / Always allow / Cancel (with file links: Change and remove file shares / Change, keep file shares) | `card:folder_access` | Settings › 트리나에게 허용한 것 | runs under Always (with the owner's or admin's own rights), else refused | a guest's turn is refused | shows-private-to-others | OK (decision 2: Always holds in the person's scheduled run and shared chats, offered there under Always; the who and folder checks stay; decision 20261123-ask-registry-findings) |
| `folder.access.many` | `server/src/chat/folder-access-tool.ts:438` | `change_folder_access` with a list of changes. | Change who can open {folder}? / {folder} 폴더를 열 수 있는 사람을 바꿀까요? (`askManyOne`, `askMany`) | as `folder.access` | `card:folder_access` | Settings › 트리나에게 허용한 것 | runs under Always (with the owner's or admin's own rights), else refused | as `folder.access` | shows-private-to-others | OK (decision 2: Always holds in the person's scheduled run and shared chats, offered there under Always; the who and folder checks stay; decision 20261123-ask-registry-findings) |
| `files.picture.notown` | `server/src/tools/own-picture.ts:37` | `edit_hwp` image change or `edit_office` `insert_picture` with a signature or seal the person did not upload themselves (`isOwnUpload` on the sha256 of the bytes read). Skipped for their own upload of these exact bytes and for a picture they chose Always for. Lists every picture still to approve. | The AI wants to put {pics} into {doc}. You did not upload this picture yourself. Put it in? / AI가 {pics}을(를) {doc}에 넣으려고 해요. 직접 올린 그림이 아니에요. 넣을까요? | Put it in / Always allow / Don't | per person and exact picture (`picture:t:<team path>` or `picture:c:<chat file id>` in `card_always_allow`); covers exactly the pictures the card lists | Settings › 트리나에게 허용한 것, one row per picture | runs under Always for an approved picture; any other is refused at once, nothing saved | the same card to the person whose turn it is | security | OK: the owner, 2026-11-23, "클로드랑 동일한 기준 ㄱ": scoped to the approved picture as Claude Code scopes "don't ask again" ([decision](decisions/20261123-picture-always-allow.md)) |

### Sending and sharing (다른 사람에게 보내기·공유)

| id | where | trigger | text (en / ko) | buttons | always | revoke | scheduled | guests | reason | rule A |
|---|---|---|---|---|---|---|---|---|---|---|
| `share.read` | `server/src/chat/turn.ts:4471` | In a shared chat, a read of a place some people in the chat cannot open, also a team file the person's call attaches through a connection (confirmSharedAttach; a no sends nothing: `sharedAttachSkipped`, decision 20261126-shared-chat-own-tools). Asked once per place per answer. | The AI wants to read {sources}. {m} of the {n} people who see this chat can't open it… / AI가 {sources}을(를) 읽으려고 해요. 이 채팅을 보는 {n}명 중 {m}명은 이곳을 열 수 없어요… (`sharedReadConfirm`) | Read and share / Always allow / Don't read | `card:shared_read` | Settings › 트리나에게 허용한 것 | runs under Always; a guest among the people: refused | Always holds with a guest too (one Always, decision 20261123-one-always-allow) | shows-private-to-others | OK |
| `share.skill` | `server/src/chat/turn.ts:4471` | The same path, for a group skill some people in the chat may not use. | The AI wants to use the skill of {sources}… / AI가 {sources}의 스킬을 쓰려고 해요… (`sharedSkillConfirm`) | Read and share / Always allow / Don't read | `card:shared_read` | Settings › 트리나에게 허용한 것 | as `share.read` | as `share.read` | shows-private-to-others | OK |
| `share.copy` | `server/src/chat/turn.ts:4471` | The same path, for a copy into the chat's files or work folder. | …copy files from {sources} into this chat… / AI가 {sources}에서 파일을 읽어 이 채팅으로 복사하려고 해요… (`sharedCopyWorkConfirm`, `sharedCopyChatConfirm`) | Read and share / Always allow / Don't read | `card:shared_read` | Settings › 트리나에게 허용한 것 | as `share.read` | as `share.read` | shows-private-to-others | OK |
| `share.files` | `server/src/chat/share-with-person.ts:309` | `share_with_person` after every check. Skipped when the asker's own message asked for exactly this share (every file and person named, or a title that resolves to one person), also in a shared or project chat nobody else wrote in and after content others wrote, never after a room read or with a guest; or under Always. The share card offers 취소 for 10 s (docs/decisions/20261123-do-then-undo.md). | Share {n} files with {who}? They can only view them… / {who}님에게 파일 {n}개를 공유할까요? (`fileShareAsk*`) | Share / Always allow / Don't share | `card:share_files` | Settings › 트리나에게 허용한 것 | runs under Always, else refused at once | a guest is never a recipient; with a guest in a shared chat, Always counts only when the asker named every recipient | sends-to-others, shows-private-to-others | OK |
| `share.files.pick` | `server/src/chat/shared-actions.ts:61` | Shared chat: several people match a name. A title's pick is kept as the person's alias and not asked again. | Several people match '{ref}'. Who should get it? / '{ref}'에 맞는 사람이 여러 명이에요… (`fileSharePick`) | each match / Don't share | none (a choice) | n/a | no answer, refused | same | other:choice | OK |
| `share.folder` | `server/src/chat/share-folder.ts:275` | `share_folder` add, unless Always or the asker's own message asks to share their own folder (named or guessed from the chat) with people they named, a title that resolves to one person, or "팀원들" (the project's or their group's people) (docs/decisions/20261123-do-then-undo.md). | Share {name} with {who}? They can view everything in it, including files you add later. / {name} 폴더를 {who}에게 공유할까요? (`folderShareAsk`) | Share / Always allow / Don't share | `card:share_folder` | Settings › 트리나에게 허용한 것 | runs under Always, else refused | a guest's own turn is refused | sends-to-others, shows-private-to-others | OK |
| `share.folder.pick` | `server/src/chat/shared-actions.ts:61` | Shared chat: several matches for a folder share. | (`fileSharePick`) | each / Don't share | none | n/a | no answer | same | other:choice | OK |
| `share.folder.stop` | `server/src/chat/share-folder.ts:264` | `share_folder` remove or stop, unless the message names the folder (and every person). | Stop sharing {name}? / {name} 폴더 공유를 중지할까요? (`folderStopAsk*`) | Stop sharing / Keep sharing | none | n/a | refused | same | other:narrows-access | OK, kept exception: stopping a share only narrows access and has Undo; no card when the message names it (decision 20261123-ask-registry-findings) |
| `unshare.files` | `server/src/chat/stop-sharing.ts:238` | `stop_sharing`, unless the message names every file and person. | Stop sharing {n} files with {who}? / {who}님과 파일 {n}개 공유를 중지할까요? (`fileStopAsk*`) | Stop sharing / Keep sharing | none | n/a | refused up front | same | other:narrows-access | OK, kept exception: as `share.folder.stop` |
| `unshare.files.pick` | `server/src/chat/shared-actions.ts:61` | Shared chat: several people on the file match. | Several people match '{ref}'. Who should lose access? (`fileStopPick`) | each / Keep sharing | none | n/a | refused earlier | same | other:choice | OK |
| `post.room` | `server/src/chat/post-to-room.ts:692` | `post_to_room` with no files. Skipped: the asker's own message asks to post and names the place (room, person, a title that resolves to one person, @everyone in their words), with no source some there cannot see that they did not name (chat/explicit-send.ts floor), also in a shared or project chat nobody else wrote in; Always; a Send for the same room, thread and members in this chat (12 h). The step then offers Undo for 10 s and Delete after (docs/decisions/20261123-do-then-undo.md). | Send to {room} ({n} people)? / {room}({n}명)에 보낼까요? (`postRoomAsk`, `postRoomAskThread`, `postRoomAskNewDm`) | Send / Always allow / Don't send | `card:post_to_room`; plus a 12 h exact-target yes in this chat | Settings › 트리나에게 허용한 것 | runs under Always, else refused | see `post.room.guest`; @everyone with a guest keeps the card | sends-to-others | OK |
| `post.room.files` | `server/src/chat/post-to-room.ts:692` | The same card when the post carries copies of linked files. Skipped like `post.room` when every copy is the asker's own, made in this answer or named by them; a source the person sent on a card in this chat goes to the next named place without a card (one card per source, `post_sources`). | as `post.room` + Files sent with it | Send / Always allow / Don't send | `card:post_files` | Settings › 트리나에게 허용한 것 | as `post.room` | as `post.room` | sends-to-others, shows-private-to-others | OK |
| `post.room.pick` | `server/src/chat/shared-actions.ts:61` | Shared chat: several rooms or people match. A title ("팀장님") that resolves to one person picks them; the person's pick for a title is kept as their alias (Settings › 트리나에게 허용한 것) and not asked again. | Several rooms or people match '{ref}'. Where should it go? / '{ref}'에 맞는 곳이 여러 개예요… (`postRoomPick`) | each / Don't send | none | n/a | no answer | same | other:choice | OK |
| `project.members` | `server/src/chat/project-members.ts:458` | `change_project_members`. One at a time; none after a no. | Change the members of the project '{project}'? / '{project}' 프로젝트의 멤버를 바꿀까요? (`MEMBERS_TEXT.ask`) | Change members / Always allow / Don't change | `card:project_members` | Settings › 트리나에게 허용한 것 | runs under Always (with the person's own project rights), else refused | Always holds with a guest too (one Always, decision 20261123-one-always-allow) | shows-private-to-others, sends-to-others | OK (decision 2: Always holds in the person's scheduled run and shared chats, offered there under Always; a guest is refused; decision 20261123-ask-registry-findings) |
| `dialog.answer.room` | `server/src/chat/answer-share.ts:911` | The answer's "Send to a conversation" button: the first press is a preview; it sends at once (with Undo in the toast) when the server marks the confirm `direct` (nothing from a source some members cannot see, every copy the person's own), else it asks; asks again when files or the state changed. Skipped under `post_to_room` / `post_files` Always. | {n} people in this conversation will see it… / 이 대화에 있는 {n}명이 보게 돼요. (`shareRoom.audience`) | Send (Attach and send) / Cancel | reuses `card:post_to_room` and `card:post_files` | Settings › 트리나에게 허용한 것 | n/a | same (the person's own press) | sends-to-others, shows-private-to-others | OK |
| `dialog.chat.people` | `server/src/chat/people-share.ts:590` | The chat Share dialog brings in new people (its confirm key is missing or stale). | what the new people would see; Share "{title}" / "{title}" 공유 (`chat.share.title`) | Share / Cancel | none (a one-off) | n/a | n/a | guests cannot be added | shows-private-to-others | OK |
| `dialog.chat.people.files` | `server/src/chat/people-share.ts:564` | "Share the files too": the files' key is missing or changed. | Share the files too ({n}) / 파일도 같이 공유 ({n}개) (`chat.shareFiles.*`) | Share / Cancel | none | n/a | n/a | same | shows-private-to-others | OK |
| `dialog.chat.project` | `server/src/chat/share-chat.ts:138` | Sharing a chat with its project's members. | Share this chat so {n} people can see it? … Sharing can't be undone. / 이 채팅을 공유해서 {n}명이 볼 수 있게 할까요? (`chat.shareChat.title`) | Share / Cancel | none | n/a | n/a | same | irreversible, shows-private-to-others | OK |
| `dialog.access.chat` | `server/src/chat/access-requests.ts:410` | Approving a chat access request when the server's check needs a confirm. | Share this chat with {by}? / 이 채팅을 {by}님에게 공유할까요? (`accessRequest.confirmTitle`) | Cancel / Share | none (a new key on each change) | n/a | n/a | same | shows-private-to-others | OK |

### Connectors (커넥터)

| id | where | trigger | text (en / ko) | buttons | always | revoke | scheduled | guests | reason | rule A |
|---|---|---|---|---|---|---|---|---|---|---|
| `conn.connect.service` | `server/src/chat/connect-service.ts:382` | The AI calls `connect_service` for a new MCP or HTTP service. No card for Slack, a connected one, a private address or a key in the input. | Connect {name} / {name} 연결 (`connect.title`); an address not in the app's list adds, beside its host in bold: This address is not in Trina's list of apps. Check that it matches the address in the service's official docs. / 트리나 앱 목록에 없는 주소예요. 이 서비스의 공식 문서에 나온 주소와 같은지 확인해 주세요. (`connect.unlisted`; a listed name at another address gets `connect.notOfficial` instead; decision 20261124-connect-card-unlisted) | Connect / Not now | none (a sign-in step) | n/a | skipped, no card | guests never get the tool | security, other:sign-in | OK |
| `conn.connect.reconnect` | `server/src/chat/connect-service.ts:382` | The person's own connection needs a new sign-in or key. | Sign in to {name} again / {name} 다시 로그인 | Sign in / Not now | none | n/a | skipped | n/a | other:sign-in | OK |
| `conn.connect.template` | `server/src/chat/connect-service.ts:382` | An admin's connection template covers this person. | Connect your own {name} account / 내 {name} 계정 연결 | Connect / Not now | none | n/a | skipped | n/a | other:sign-in | OK |
| `conn.connect.drive` | `server/src/chat/connect-service.ts:382` | Drive is set up for the team and the person is not connected. | Connect Google account / Google 계정 연결 (`drive.connect`) | Connect Google account / Connect for the team (admin) / Not now | none | n/a | skipped | n/a | other:sign-in | OK |
| `conn.connect.google_app` | `server/src/chat/connect-service.ts:382` | A person asks for Gmail, Calendar, Docs or Sheets that they can connect and have not. | Connect {name}; for an owner or admin also Connect it once for the whole team… (`connect.teamWay`) | Owner or admin: Connect for the team / Connect my own / Not now. Member: Connect my {name} / Not now | none | n/a | skipped | n/a | other:sign-in | OK |
| `conn.shared` | `server/src/chat/turn.ts` confirmSharedConnection and `server/src/integrations/connections/tools.ts` sharedGate | Shared project or shared chat, the person's first use of that connection (their own or the team's) there. Once per person, connection and place (the project, or the chat when it is in no project); never in a private chat (decision 20261123-shared-connector-warning-once). | Other people in this chat can also see what the AI gets from {service}. / 이 채팅의 다른 사람도 {service}에서 가져온 내용을 볼 수 있어요. (`sharedConnectionWarn`) | Continue (계속) | per person, connection and place (`connector_tool`, shared, `warned`); an Always from the old card still counts | Settings › 트리나에게 허용한 것 (removing it shows the notice again) | runs once seen there, else refused | a team connection is refused while a guest sees the chat | shows-private-to-others | OK |
| `conn.shared.browser` | `server/src/chat/turn.ts` confirmSharedBrowser and `server/src/chat/tools.ts` browserTool | Shared project or shared chat, the person's first use of their own in-app browser there (a turn from their desktop window). Once per person and place; never in a private chat (decision 20261126-shared-chat-own-tools). | Other people in this chat can also see what the AI gets from your browser. / 이 채팅의 다른 사람도 AI가 내 브라우저에서 가져온 내용을 볼 수 있어요. (`sharedBrowserWarn`) | Continue (계속) | per person and place (`card_always_allow` kind `seen:browser:<place>`, listed as `connector_tool` "Browser", `warned`) | Settings › 트리나에게 허용한 것 (removing it shows the notice again) | opens nothing without it | a guest among the people is said on the notice | shows-private-to-others | OK |
| `browser.shared.change` | `server/src/chat/turn.ts` confirmSharedBrowserChange and `server/src/chat/tools.ts` browserTool | A shared chat where someone else wrote or a guest is among the people: an in-app browser call that acts (anything but the page reads `read_page`, `get_page_text`, `find`, `tabs_context`, console and network reads), after the place's notice (security review of #647, decision 20261126-shared-chat-own-tools). The same call again in the answer goes on. | Other people wrote in this chat, so the AI asks before it acts in your browser. {ai} wants to do this: {what}. Allow it? / 이 채팅에는 다른 사람이 쓴 메시지가 있어서, AI가 내 브라우저에서 무언가를 하기 전에 먼저 물어봐요… (`sharedBrowserConfirm`) | Allow once / Always allow / Don't allow | `card:room_change` (the person's Always for changes after other people's words) | Settings › 트리나에게 허용한 것 | runs under Always, else refused | Always holds with a guest too | shows-private-to-others, sends-to-others | OK |
| `conn.read.unsure` | `server/src/integrations/connections/tools.ts:873` | Shared chat; a read-only tool whose name looks like a change or an export. | Read from {name}: {what} / {name}에서 읽어 와요: {what} (`unsureRead`) | Allow / Always allow / Always allow all of {name} / Don't allow | per connector tool; Allow covers the rest of the answer; or "Always allow all of {name}" (every tool of that connection, per person; decision 20261123-one-always-allow) | Settings › 트리나에게 허용한 것 | runs under Always, else refused | Always holds with a guest too (one Always, decision 20261123-one-always-allow) | security | OK |
| `conn.write` | `server/src/integrations/connections/tools.ts:720` | A change at a service (MCP write tool, `api_request`, a Google app send) where the connection is not set to send without asking. Skipped when the person's own message asked for it, the same tool and recipients were approved in this chat, or the tool only makes something new (the create tier: the service marks it `destructiveHint: false`, a create verb and no other change, message, share or money word, no recipient; not after a room read or in a run; in a shared chat only while nobody else wrote there, and a create's short answer does not end it: decision 20261123-shared-connector-warning-once). A call repeated with the same arguments while its card waits shares that card. (docs/decisions/20261123-do-then-undo.md). | The AI wants to send this to {name}: {what} / AI가 {name}에 이 내용을 보내려고 해요: {what} (`confirm`) | Send once / Always allow / Don't send | per connection (own connection's write rule, or a per-person allow on a team connection) | Settings › 트리나에게 허용한 것 (`connector_send`, `send:<connection>`); also the connection's write rule in Settings › Connectors | runs under Always; else refused | guests have no connectors | sends-to-others, irreversible | OK (decision 6; decision 20261123-ask-registry-findings) |
| `conn.write.noalways` | `server/src/integrations/connections/tools.ts:728` | As `conn.write` with no Always offered: a Slack turn, the team switch off, a demo server, and in a shared chat every send to others, every team-connection change, `api_request`, a call with team files. | as `conn.write` | Send / Don't send | none | n/a | refused | same | sends-to-others | OK, kept exception: in a shared chat a send to others asks every time (decision 20261122-connector-always-allow; decision 20261123-ask-registry-findings) |
| `conn.write.own` | `server/src/integrations/connections/tools.ts:873` | Shared chat; a call on the person's own connection that reaches nobody else. | {what} in {name} / {name}에서 "{what}" 작업을 해요 (`actTool`) | Allow / Always allow / Always allow all of {name} / Don't allow | per connector tool, or the own connection's write rule; or "Always allow all of {name}" (every tool of that connection, per person; decision 20261123-one-always-allow) | Settings › 트리나에게 허용한 것 | runs under Always, else refused | Always holds with a guest too (one Always, decision 20261123-one-always-allow) | other:own-action | OK |
| `desktop.localapp.connect` | `desktop/src/main/local-apps.ts:102` and `desktop/src/common/local-apps.ts:459` | The first call to a local-app connector on this computer, and again when its command changes. | Connect this program? {name} for {team} wants to run this on your computer… / 이 프로그램을 연결할까요? (`localApp.*`) | Cancel / Connect | per team, connection and command on this computer | Settings › Connectors › Programs on this computer › Remove (desktop app; bridge `localApps.forget`) | runs only if the app is open; times out as not confirmed | n/a | security | OK (decision 9; decision 20261123-ask-registry-findings) |
| `slack.link` | `web/src/pages/SlackLink.tsx:83`, `server/src/routes/slack.ts:142` and `server/src/integrations/slack/service.ts:89` | An unlinked Slack user asks the app in Slack. | Connect {product} account; Link your Slack account / Slack 계정 연결 (`slack.link.title`) | Link / Cancel | none (one sign-in) | Settings › Connectors › Slack (unlink) | n/a | n/a | security, other:sign-in | OK |
| `slack.post` | `server/src/integrations/slack/service.ts:85` | An answer to a channel question goes to the asker only, with a button. | Post to channel / 채널에 올리기 (`post`) | Post to channel | none (the person presses it each time) | n/a | n/a | n/a | sends-to-others | OK |
| `slack.post.anyway` | `server/src/integrations/slack/service.ts:87` | "Post to channel" while the answer used places not everyone can see. | This answer used places not everyone on the team can see: {places}. Post it to the channel anyway? / 이 답에는 팀 사람 모두가 볼 수는 없는 곳의 내용이 들어 있어요… (`postCheck`) | Post anyway / Cancel | none | n/a | n/a | n/a | shows-private-to-others | OK |
| `slack.card.notice` | `server/src/integrations/slack/service.ts:1553` | A Slack turn waits on any card: Slack says to answer in the app. No Always is read or offered in a Slack turn. | {product} needs your answer. Answer it in {product}. / {product}가 확인할 것이 있어요… (`needsAnswer`) | a link to the chat | none | n/a | n/a | n/a | other:notice | OK (a limit decision 20261122-always-allow-holds-everywhere keeps) |
| `conn.consent` | `web/src/pages/ConnectorConsent.tsx:106` | An outside app (Claude, ChatGPT) connects to the Trina AX MCP (OAuth consent). | Allow an app connection / 앱 연결 허용 (`connectors.consentTitle`) | Allow and continue / Deny | per connection (scopes chosen once) | Settings › AI apps › Disconnect | n/a | a guest sees a not-for-guests notice | security | OK |

### Websites (웹사이트)

| id | where | trigger | text (en / ko) | buttons | always | revoke | scheduled | guests | reason | rule A |
|---|---|---|---|---|---|---|---|---|---|---|
| `site.office` | `server/src/chat/tools.ts:1708` | The in-app browser opens an office-network (private) address. Skipped when allowed in this answer or for good. | May the AI open the office-network address {host}? / 사내망 주소 {host}를 열어도 될까요? (`browserSite`, web `ask.siteTitle`) | Allow once / Always allow / Deny | per person per site (`browser_site_grants`); only while the team's Always switch is on (off: not used, the card sends `noAlways`) | Settings › 트리나에게 허용한 것 (site, office) | runs if granted, else refused | Always for good even with a guest | security | OK (fixed: follows the team switch; decision 20261123-ask-registry-findings) |
| `desktop.site.web` | `desktop/src/ui/pane.ts:245` and `desktop/src/main/pane/net-guard.ts:98` | The desktop app's in-app browser opens or sends to a public site not yet allowed (site access "ask"). Skipped: Always, "all" on, once in this turn, and what the team server says the person already allowed for the call (`BrowserCall.sites`: their sites for good, the address the server card or their own message approved; docs/decisions/20261125-one-site-always-desktop-browser.md). | The AI wants to use {host} / AI가 {host}을(를) 쓰려고 해요 (`perm.site.title`) | Allow once / Always allow / Allow all websites (team allows) / Deny | "Always allow this site ({site})": the site the button names (shared `siteToKeep`, the address card's rule; a host with a long or random name before its site keeps only that host on this computer), saved on this computer and sent with the next call's result to be kept as the person's site for good on the server (`user_allowed_sites`, the row of `site.web`'s "Always allow this site"): it holds on every computer, every port and on the server's card | both places: the server's site in Settings › 트리나에게 허용한 것 (any app, DELETE `/api/ai-allowances/:id`), and this computer's copy in the pane's ⚙ › Allowed sites or Settings › Browser (desktop app); remove both to be asked again on this computer | only while the app is open; 180 s, then Deny | same | security, sends-to-others | OK (decision 8: kept on the device, listed in 트리나에게 허용한 것 in the desktop app; decision 20261123-ask-registry-findings) |
| `desktop.site.private` | `desktop/src/ui/pane.ts:245` and `desktop/src/main/pane/net-guard.ts:121` | The in-app browser opens an office-network address the person did not open. Skipped: what the team server says the person already allowed (`BrowserCall.office`: the server's office card, for good or for this answer). | The AI wants to open the office-network address {host} / AI가 사내망 주소 {host}을(를) 열려고 해요 (`perm.private.*`) | Allow once / Always allow / Deny | per private host per team on this computer, and kept in the person's office grants on the server (`browser_site_grants`), sent to the app with every call to that host on every port | both places: the server's office grant in Settings › 트리나에게 허용한 것 (site, office), and this computer's copy in the pane's ⚙ › Allowed sites | as `desktop.site.web` | same | security | OK |
| `desktop.browser.allowall` | `desktop/src/main/app-window.ts:1299` | Settings › Browser turns on "Allow all websites" (needs the team switch). | Let the AI open any website without asking in {team}? / {team}에서 AI가 묻지 않고 모든 웹사이트를 열게 할까요? (`allowAll.message`) | Cancel / Allow all websites | sets the person's own switch on this computer | Settings › Browser ("Ask for each new site") | n/a | n/a | security | OK |
| `site.web` | `server/src/tools/url-gate.ts:903` | `web_fetch`, `save_url` or an in-app browser address the person did not type, allow or that was not learned within the budget (30 per answer, 150 per chat), a long query, or an unknown exit address. A plain address the person typed (or allowed on a card, also their schedule's) opens without the card while the exit address is unknown too (docs/decisions/20261123-do-then-undo.md). | The AI wants to open an address that wasn't in this chat… / AI가 이 대화에 없던 주소를 열려고 해요… (`unseen`, `budget`, `longQuery`) | Open / Always allow this site ({site}) / Allow all websites (turn off in Settings) / Don't open | per person per site (`user_allowed_sites`) (none with the team switch off or in a Slack turn); "Allow all websites" is the person's own switch | Settings › 트리나에게 허용한 것 (site); Settings › Browser (all websites) | allowed sites and Allow all hold; else refused | guests have no web tools | security | OK |
| `site.web.marked` | `server/src/tools/url-gate.ts:909` | An address with long random-looking parts, a long name before the site, or a user name or password (highlighted). | …The address has long strings that are hard to read (highlighted)… (`opaque`, `longName`) | Open / Don't open | none (a hard limit) | n/a | refused | same | security | OK |
| `site.web.echo` | `server/src/tools/url-gate.ts:909` | The address carries something the AI sent earlier in this chat. | The AI wants to open an address a connected app gave it, but the address contains something the AI sent earlier… (`echo`) | Open / Don't open | none (a hard limit) | n/a | refused | same | security | OK |
| `site.redirect` | `server/src/tools/connection-urls.ts:295` | A fetch or download is sent on to an address that echoes what the AI sent. | The address the AI is opening sends it on to another one, and that address contains something the AI sent earlier… (`redirectEcho`) | Open / Don't open | none (a hard limit) | n/a | not followed | same | security | OK |

The desktop browser's `file_upload` ([decisions/20261126-browser-file-upload.md](decisions/20261126-browser-file-upload.md))
adds no card of its own: the page's site needs `desktop.site.web` (or `desktop.site.private`) first, as any browser action
there; in a shared chat `conn.shared.browser`, `browser.shared.change` and, for a team file some people there cannot
open, `share.read` come first; the hard blocks (read permission, the safety check, a stored key in the file, 20 files and
100 MB) refuse without asking. Auto mode treats it as the other browser tools that act: every card it can meet is `ask`
(the site cards, `always:shared_read`, `always:room_change`), so auto mode never lets one of its files through on its own.

### Commands and dev environment (명령 실행·개발 환경)

| id | where | trigger | text (en / ko) | buttons | always | revoke | scheduled | guests | reason | rule A |
|---|---|---|---|---|---|---|---|---|---|---|
| `dev.bulk` | `server/src/chat/tools.ts:346` | A command made more new files in a project folder than one answer may add. 120 s; no answer moves them to the work folder. | An AI command made {files} new files in the folder of the project "{project}"… / AI 명령이 "{project}" 프로젝트 폴더에 새 파일 {files}개를 만들었어요… (`BULK_TEXT.ask`) | Keep in the project folder / Always allow / Move to the work folder | `card:bulk_files` | Settings › 트리나에게 허용한 것 | kept under Always, else moved | Always holds with a guest too (one Always, decision 20261123-one-always-allow) | other:clutter | OK |
| `dev.login` | `server/src/chat/tools.ts:354` and `server/src/devenv/tool.ts:634` | A command that can use a login, after other people changed project files since this person's last command. | This command can use a login: {command}. Other people changed files in the project… (English only in code; ko missing) | Run it / Always allow / Do not run | `card:dev_login` | Settings › 트리나에게 허용한 것 | runs under Always (the result lists the changes), else refused | Always holds with a guest too (one Always, decision 20261123-one-always-allow) | security | OK (wording not translated: a finding) |
| `dev.site` | `server/src/chat/tools.ts:362` | A command needs a site not on the allowed lists. No card: No network, a bad host, a host denied in this answer, a sub-agent. | The AI tried to reach {host}. Allow it? / AI가 {host}에 접속하려고 했어요. 허용할까요? (web `devEnvSite.title`) | Allow once / Always allow / Don't allow | per person per site (own dev site list); a full list (2,000): the card offers no Always and says so (`listFull`) | Settings › Dev environment sites (개발 환경 사이트; on a phone inside 트리나에게 허용한 것) | refused at once; listed sites work | Always kept for good even with a guest | security | OK (fixed: no silent "once"; decision 20261123-ask-registry-findings) |

### Memory, skills and schedules (기억·스킬·예약)

| id | where | trigger | text (en / ko) | buttons | always | revoke | scheduled | guests | reason | rule A |
|---|---|---|---|---|---|---|---|---|---|---|
| `memory.remember` | `server/src/chat/tools.ts:1540` | `remember` that is not an automatic save, after the chat read outside or room content. | The AI wants to remember this about you. OK? {text} / AI가 다음 내용을 기억하려고 해요. 기억할까요? (`rememberConfirm`) | Remember / Always allow / Don't remember | `card:remember` | Settings › 트리나에게 허용한 것 | runs under Always, else not kept | Always holds with a guest too (one Always, decision 20261123-one-always-allow) | security | OK |
| `skill.save` | `server/src/chat/turn.ts:5166` | The AI writes into a skills or rules folder (team, group, project). One card at a time; files of a new skill show on the SKILL.md card. | Save this as a team skill? Every teammate's AI will follow it… / 팀 스킬로 저장할까요? 팀 전체 AI가 따라요… (`confirm`, `confirmGroup`, `confirmProject`) | Save / Always allow skill saves / Don't save | `card:skill_save`; also covers the widening | Settings › 트리나에게 허용한 것 | runs under Always, else refused | Always holds with a guest too (one Always, decision 20261123-one-always-allow) | sends-to-others | OK (the label says what it covers) |
| `skill.own_change` | `server/src/chat/personal-skills.ts:183` | `write` or `edit` of one of the person's own skills (users/<id>/skills/) that the AI did not make (no `origin: auto`): one it made changes with no card (decision 20261125-auto-personal-skills). The card shows the diff; the file layer holds the approval for those bytes. Not in a side, scheduled, Slack, template or confidential chat (refused up front). | Change your skill {names} like this? It is one you made or asked for… / 직접 만든 {names} 스킬을 이렇게 고칠까요?… (`ownSkillChangeConfirm`) | Change / Always allow skill saves / Keep as it is | `card:skill_save` | Settings › 트리나에게 허용한 것 | refused up front (no scheduled run) | no personal skills for guests | other:ai-instructions | OK |
| `skill.own_delete` | `server/src/chat/personal-skills.ts:183` | `delete_files` of one of the person's own skills the AI did not make (its folder holds only SKILL.md); one it made goes to the trash with no card. | Delete your skill {names}? … It goes to the trash and can be brought back. / 직접 만든 {names} 스킬을 지울까요?… (`ownSkillDeleteConfirm`) | Delete / Always allow skill saves / Keep as it is | `card:skill_save` | Settings › 트리나에게 허용한 것 | refused up front (no scheduled run) | no personal skills for guests | other:ai-instructions | OK |
| `skill.save.name_taken` | `server/src/chat/turn.ts:5166` | A new project skill whose name a wider skill already has (it would never run). | (`sameNameNarrower`) | Save under another name / Don't save | none (a choice, not a permission) | n/a | refused | same | other:choice | OK |
| `skill.move` | `server/src/chat/tools.ts:1388` | The AI moves a skill to another level. Leads in plain words (`batch`: the skill, its description, who follows it); paths, names, the start of SKILL.md and the files (each opened on request) behind 자세히. Several of one answer to one place: one card (`card.batch`). | Move the skill "{name}"? {from} → {to} / "{name}" 스킬을 옮길까요?… (`moveConfirm`) | Move / Always allow / Don't move | `card:skill_files` | Settings › 트리나에게 허용한 것 | refused at once unless Always | Always holds with a guest too (one Always, decision 20261123-one-always-allow) | sends-to-others | OK |
| `skill.copy` | `server/src/chat/tools.ts:1388` | The same, as a copy. | Copy the skill "{name}"? The original stays… / "{name}" 스킬을 복사할까요? 원본은 그대로 있어요… (`copyConfirm`) | Copy / Always allow / Don't copy | `card:skill_files` | Settings › 트리나에게 허용한 것 | as `skill.move` | as `skill.move` | sends-to-others | OK |
| `skill.files` | `server/src/chat/skill-files.ts:126` | `skill_files` move, copy or rename that touches a skill folder. Refused up front in a shared chat or a chat others wrote in, unless the person's Always is on (then offered there too). A skill put in leads in plain words like `skill.move`; the card never carries all of its text and no skill is refused for its length (owner 2026-11-23). Several of one answer: one card (`card.batch`).| Take this out of the skill folder? / Put this into {where}? / 스킬 폴더에서 꺼낼까요? (`fileOut*`, `fileIn*`, `fileRename*`) | Move, Copy or Rename / Always allow / Don't | `card:skill_files` | Settings › 트리나에게 허용한 것 | runs under Always, else refused | Always holds with a guest too (one Always, decision 20261123-one-always-allow) | other:ai-instructions | OK (decision 1: Always holds in shared chats; decision 20261123-ask-registry-findings) |
| `video.make` | `server/src/tools/higgsfield.ts:138` | `generate_video`, every video (after the daily cap). | The AI wants to make a video with Higgsfield. This uses the team account's credits… / AI가 Higgsfield로 영상을 만들려고 해요. 팀 계정의 크레딧이 쓰이고… (`TEXT.confirm`) | Make it / Always allow / Cancel | `card:video` | Settings › 트리나에게 허용한 것 | runs under Always (the daily limit still counts), else refused | Always holds with a guest too (one Always, decision 20261123-one-always-allow) | cost, sends-to-others | OK (decision 3; decision 20261123-ask-registry-findings) |
| `schedule.create` | `server/src/tools/schedules.ts:545` | `schedule_create`. Skipped when the asker's own message says when it runs or asks for a schedule, in a turn they watch, after no room read, and the task sends nowhere (no connection, pinned recipient or save folder), every address in it was typed by them, nothing random-looking, and no guest in the shared chat: then made at once and its step shows Pause and Delete (docs/decisions/20261123-do-then-undo.md). | The AI wants to create a scheduled task. It runs the instruction below on its own, with nobody watching… / AI가 예약 작업을 만들려고 해요… (`TEXT.question`) | Create / Don't create (or Create, may send to those services / Create, never send / Don't create); note: "This card shows every time: a scheduled task runs when nobody is watching." | none | n/a | refused (a run cannot make tasks) | same | security, sends-to-others | OK: no Always. Asked in the person's own words and sending nowhere: made without the card, with Pause and Delete on its step (decision 20261123-do-then-undo); otherwise the card, since each task runs unwatched and may send (decision 20261123-ask-registry-findings) |
| `schedule.edit` | `server/src/chat/schedule-edit.ts:101` | Settings › Scheduled tasks › Edit of a free-text task. | Change this scheduled task to the following?… / 예약 작업을 이렇게 바꿀까요?… (`editQuestion`) | Save changes / Don't change | none (the person's own edit) | n/a | n/a | same | security | OK |
| `schedule.review` | `server/src/chat/schedule-review.ts:71` | "Check again" on a task made without its card (paused). | This scheduled task was made without its confirmation card, so it is paused… / 이 예약 작업은 확인 카드 없이 만들어져서 멈춰 뒀어요… (`reviewQuestion`) | Resume / Keep it paused | none | n/a | the task does not run until confirmed | same | security | OK |
| `schedule.recheck` | `server/src/chat/schedule-review.ts:71` | "Check again" on a task whose save folder lapsed. | Saving for this scheduled task is paused: {why}… / 이 예약 작업의 저장 허용을 멈춰 뒀어요… (`recheckQuestion`) | Allow again / Leave it | none | n/a | saves to My files until answered | same | shows-private-to-others | OK |

### Rooms (대화방)

| id | where | trigger | text (en / ko) | buttons | always | revoke | scheduled | guests | reason | rule A |
|---|---|---|---|---|---|---|---|---|---|---|
| `room.change` | `server/src/chat/turn.ts:3410` | Any change after the chat read room messages (other people's words). Skipped: read-only tools, a tool with its own card, a call already allowed in this answer, an undoable own-folder command, a new file in the person's own folder, a room grant, the 12 h exact-file approval, Always on. | Messages from your conversations came in here, so changes are asked first. {ai} wants to … / 여기에 대화 메시지(다른 사람이 쓴 글)가 들어와서, 무언가를 바꾸기 전에 먼저 물어봐요… (`roomsSeenWhy`, `roomAiConfirmNew`, `roomsSeenConfirm`) | Allow once / Always allow / Don't allow | `card:room_change`. Allow once keeps a 12 h exact-file approval in this chat. The same card follows a read of a shared file someone else wrote (`sharedFileSeenConfirm*`) | Settings › 트리나에게 허용한 것 | runs under Always or the task's card cover; otherwise refused | Always holds with a guest too (one Always, decision 20261123-one-always-allow) | security | OK |
| `room.read` | `server/src/chat/turn.ts:3410` | The same card for a read from a connected service with an address in its arguments, after a room read. | …so reading from other services is asked first too… / …다른 서비스에서 읽어 오기 전에도 먼저 물어봐요… (`roomsSeenConfirmRead`) | Allow once / Always allow / Don't allow | `card:room_change` (no 12 h approval for a read) | Settings › 트리나에게 허용한 것 | as `room.change` | as `room.change` | security | OK |
| `room.change.widen` | `server/src/chat/turn.ts:4905` | A change after a room read that also saves where more people see; one card for both while `room_change` Always is off. | Save {file} to {area}, where {n} people can see it? / {area}에 {file} 저장할까요? {n}명이 볼 수 있는 곳이에요. (`widenConfirm` + `roomsSeenWhy`) | Save / Always allow / Don't save | keeps `card:room_change` and `card:save_wider` together | Settings › 트리나에게 허용한 것 | Always or cover, else refused | Always holds with a guest too (one Always, decision 20261123-one-always-allow) | security, shows-private-to-others | OK |
| `room.mentionAll` | `web/src/components/rooms/RoomComposer.tsx:669` | Sending a room message with @everyone (@전체) to more than a few people. | This notifies # people. Send it? / {n}명에게 알림이 가요. 보낼까요? (`rooms.mentionAllConfirm`) | Send / Don't ask again / Cancel | per person, every room and device (`prefs.mentionAllAsk`) | Settings › Notifications (turn the question back on) | n/a (the AI's @everyone post is `post.room`) | same | sends-to-others | OK |
| `room.messageLink` | `web/src/components/rooms/MessageLinkChoice.tsx:79` | Sending a link to a message some people in this room cannot see. | Some people here can't see that message. / … (`rooms.link.*`) | Only show link / Show message | none | n/a | n/a | same | shows-private-to-others | OK |

### AI questions (AI의 질문)

| id | where | trigger | text (en / ko) | buttons | always | revoke | scheduled | guests | reason | rule A |
|---|---|---|---|---|---|---|---|---|---|---|
| `ai.ask_user` | `server/src/chat/tools.ts:1615` | The AI calls `ask_user` in a chat someone watches. The card is saved and waits with no time limit; the answer starts the next turn (decision 20261118-questions-wait-and-todo-card). | The AI's own question / AI가 확인하고 싶어 해요 (web `ask.title`) | the AI's options; Skip; free text when allowed | none (a question, not a permission) | n/a | see `ai.ask_user.in_call` | shared chat: only the asker answers; the answer is their message, everyone reads it | other:question | OK |
| `ai.ask_user.in_call` | `server/src/chat/tools.ts:1618` | `ask_user` in a scheduled run, a Slack turn or a turn the server started: the card waits inside the call (Slack shows it in Slack). | as `ai.ask_user` | as `ai.ask_user` | none | n/a | refused at once (`unattended`), the call says skipped | same | other:question | OK |

### When guests are there (게스트가 있을 때)

| id | where | trigger | text (en / ko) | buttons | always | revoke | scheduled | guests | reason | rule A |
|---|---|---|---|---|---|---|---|---|---|---|
| `post.room.guest` | `server/src/chat/post-to-room.ts:692` | A post into a 1:1 chat with a guest always shows the card. | as `post.room`, with the guest line (`postRoomGuest`) | Send / Don't send | none | n/a | refused | the guest case | sends-to-others | OK |
| `ui.guest.invite` | `web/src/components/GuestInvite.tsx:278` | Invite a guest: name and AI choice, then Create link. | Invite a guest / 게스트 초대 (`guest.invite.title`) | Cancel / Create link | n/a (a form) | n/a | n/a | a guest cannot invite | sends-to-others | OK |
| `ui.guest.convert` | `web/src/components/GuestInvite.tsx:555` | Admin turns a guest into a member. | Make {name} a team member? / {name}님을 팀원으로 만들까요? (`guest.admin.convertTitle`) | Cancel / Make team member | n/a | n/a | n/a | the subject is a guest | other:admin, cost | OK |
| `ui.admin.guests.remove` | `web/src/pages/admin/Guests.tsx:150` | Admin › Guests › Remove. | Remove {name}? / {name}님을 내보낼까요? (`guest.admin.removeTitle`) | Remove guest / Cancel | none | n/a | n/a | acts on a guest | other:removes-access | OK |

### Screen confirm dialogs (화면 확인창)

The person's own press in the web app (also inside the desktop and phone apps). None offers Always: each is a one-off
step the person starts; scheduled runs never reach them. "hidden for guests" means a guest cannot open that screen.

| id | where | trigger | text (en / ko) | buttons | always | revoke | scheduled | guests | reason | rule A |
|---|---|---|---|---|---|---|---|---|---|---|
| `card.render` | `web/src/components/chat/AskCard.tsx:154` | Draws every AI card above: server yes/no, three buttons (once / always / no) with the note line, radios for 4+ choices, the AI's own question, the office-address, dev-site and connect cards. The labels and the Always come from the server. | Please check / 확인해 주세요 (`ask.serverTitle`); The AI has a question / AI가 확인하고 싶어 해요 (`ask.title`) | from the server | decided by the server | Settings › 트리나에게 허용한 것 | a scheduled task's card shows again in the schedule's edit dialog | decided by the server | other:render | OK |
| `card.batch` | `web/src/components/chat/AskCard.tsx:347` | Server cards of one answer with the same group key (`AskUserRequest.batch`: a tool's own, else `tool:<name>` stamped by `server/src/chat/turn.ts` waitForPerson) and the same buttons show as ONE card: what happens to how many, each item on a line with a tick, the summary once, one set of buttons. One press answers each (unticked: its card's no, sent first); a late press works the same (waiting cards). "Always allow" on one card of a kind answers every other open card of that kind of the answer (`server/src/chat/open-questions.ts` recordAnswer, TurnExec.answer), so their calls run with no further ask. | Move 3 skills to the team's skills? / 스킬 3개를 팀 스킬로 옮길까요? (`batchMoveMany`); {n} things to confirm / 확인할 일 {n}개 (`ask.batchMany`) | the cards' own | the cards' own kind; one press covers all | Settings › 트리나에게 허용한 것 | as each card | as each card | other:render | OK |
| `ui.chat.secretSend` | `web/src/components/chat/SecretWarning.tsx:42` | Sending text that looks like a key or password. | This looks like a key or password… / 키나 비밀번호 같아요… (`composer.secretWarning`) | Edit / Send anyway | none | n/a | n/a | same | security | OK |
| `ui.chat.delete` | `web/src/components/chat/chatActions.ts` (through `web/src/lib/destructive.ts`) | Delete a chat. | Delete this chat? / 채팅을 삭제할까요? (`chat.deleteTitle`) | Cancel / Delete | none | n/a | n/a | own chats only | irreversible | OK |
| `ui.chat.leave` | `web/src/components/chat/chatActions.ts` (through `web/src/lib/destructive.ts`) | Leave a chat shared with me. | Leave "{title}"? / "{title}"에서 나갈까요? (`chat.leaveTitle`) | Cancel / Leave | none | n/a | n/a | same | irreversible | OK |
| `ui.chat.shareDiscard` | `web/src/components/chat/ChatShareDialog.tsx:221` | Closing the chat Share dialog with unsaved picks. | Discard changes? / 변경 사항을 버릴까요? (`chat.share.discardTitle`) | Keep editing / Discard | none | n/a | n/a | n/a | other:unsaved | OK |
| `ui.chat.threadDelete` | `web/src/components/chat/ChatThreadPanel.tsx:300` | Delete my reply in a chat thread. | Delete this reply? / 이 답글을 삭제할까요? (`chat.thread.deleteTitle`) | Cancel / Delete | none | n/a | n/a | same | irreversible | OK |
| `ui.auto_mode.intro` | `web/src/components/chat/AutoModePill.tsx:13` | The first tap on the composer's auto mode pill that turns it on, once per browser (docs/decisions/20261125-auto-mode.md). Later taps change it at once; turning it off never asks. | Turn on auto mode? / 자동 모드를 켤까요? (`autoMode.intro.title`) | Turn on auto mode / Cancel | none (a one-off notice; the browser keeps that it was shown) | the pill or Settings › 트리나에게 허용한 것 turns auto mode off | n/a | hidden for guests (no auto mode) | other:mode-switch | OK |
| `ui.file.discardEdit` | `web/src/components/FilePanel.tsx:309` | Closing the file panel with unsaved edits. | Discard your changes? / 고친 내용을 버릴까요? (`preview.discardTitle`) | Cancel / Discard | none | n/a | n/a | n/a | other:unsaved | OK |
| `ui.share.file` | `web/src/components/FileShareDialog.tsx:84` | The file Share dialog: pick people, then Share (no second confirm). | Share / 공유 (`fileShare.share`) | Share | none | n/a | n/a | guests are never offered | sends-to-others | OK |
| `ui.share.fileAskOwner` | `web/src/components/FileShareDialog.tsx:222` | Someone who may not share asks the owner. | Ask {owner} / {owner}님에게 요청 (`fileShare.askOwner`) | Ask {owner} | none | n/a | n/a | hidden for guests | sends-to-others | OK |
| `ui.share.chat` | `web/src/components/chat/ChatShareDialog.tsx:395` | Share or Save in the chat Share dialog; the server's preview may show a warning in place (`dialog.chat.people`). | Share / 공유 (`chat.share.share`) | Cancel / Share | none | n/a | n/a | guests listed as unavailable | shows-private-to-others, sends-to-others | OK |
| `ui.share.chatFiles` | `web/src/components/chat/ChatShareDialog.tsx:462` | The chat made files the people in it cannot open: an unticked "Share the files too" box. | Share the files too ({n}) / 파일도 같이 공유 ({n}개) (`chat.shareFiles.include`) | checkbox + Share | none (unticked every time, decision 20261121-share-chat-files) | n/a | n/a | same | shows-private-to-others | OK, kept exception: starts unticked (decision 20261121-share-chat-files; decision 20261123-ask-registry-findings) |
| `ui.share.room` | `web/src/components/chat/ShareToRoom.tsx:79` | "Send to a conversation" on an answer: the server's confirm step (`dialog.answer.room`), shown only when the confirm is not `direct`. | Send to a conversation / 대화에 보내기 (`chat.shareToRoom`) | Cancel / Send (Attach and send) | the server skips it under `card:post_to_room` / `card:post_files` | Settings › 트리나에게 허용한 것 | n/a | hidden in a confidential chat | sends-to-others, shows-private-to-others | OK |
| `ui.share.roomSideChat` | `web/src/components/rooms/SendHere.tsx:54` | The one-click send from a room side chat, when the server says confirm and not `direct` (a direct one sends and its toast offers Undo). | as `ui.share.room` | Cancel / Send | as `ui.share.room` | Settings › 트리나에게 허용한 것 | n/a | same | sends-to-others, shows-private-to-others | OK |
| `ui.access.approve` | `web/src/components/AccessRequestNotice.tsx:34` | The owner approves an access request and the server answers confirm (`dialog.access.chat`). | Share this chat with {by}? / 이 채팅을 {by}님에게 공유할까요? | Cancel / Share | none | n/a | n/a | same | shows-private-to-others | OK |
| `ui.files.bulkMove.narrow` | `web/src/pages/Files.tsx:560` | A bulk move into my personal folder where others lose sight, only when people would lose link shares; otherwise it moves with Undo. | Make it private? / 나만 보게 옮길까요? (`files.narrowTitle`) | Move anyway / Cancel | none | n/a | n/a | hidden for guests | shows-private-to-others | OK |
| `ui.files.bulkMove.widen` | `web/src/pages/Files.tsx:562` | A bulk move that adds viewers. | Show it to more people? / 더 많은 사람이 보게 옮길까요? (`files.widenTitle`) | Move anyway / Cancel | none | n/a | n/a | hidden for guests | shows-private-to-others | OK |
| `ui.files.bulkShare` | `web/src/pages/Files.tsx:601` | A bulk "copy to folder" that adds viewers. | Copy # files? / 파일 {n}개를 복사할까요? (`files.bulk.shareConfirm`) | Copy / Cancel | none | n/a | n/a | hidden for guests | shows-private-to-others | OK |
| `ui.files.uploadClash` | `web/src/pages/Files.tsx:661` | An upload onto an existing name. | A file named {name} is already here / {name} 파일이 이미 있어요 (`files.uploadClash.title`) | Keep both / Replace | none | n/a | n/a | hidden for guests | other:name-clash | OK |
| `ui.files.move.widen` | `web/src/pages/Files.tsx:759` | One move or rename that adds viewers. | Show it to more people? / 더 많은 사람이 보게 옮길까요? (`files.widenTitle`) | Move anyway / Cancel | none | n/a | n/a | hidden for guests | shows-private-to-others | OK |
| `ui.files.move.narrow` | `web/src/pages/Files.tsx:770` | One move into my personal folder where others lose access, only when people would lose link shares (Undo cannot bring those back); otherwise it moves and the toast offers Undo. | Make it private? / 나만 보게 옮길까요? (`files.narrowTitle`) | Move anyway / Cancel | none | n/a | n/a | hidden for guests | shows-private-to-others | OK |
| `ui.files.share` | `web/src/pages/Files.tsx:824` | "Copy to…" a file when the copy adds viewers. | Copy "{name}" to: pick a folder / "{name}" 복사할 폴더 고르기 (`files.shareTitle`) | Copy / Cancel | none | n/a | n/a | hidden for guests | shows-private-to-others | OK |
| `ui.files.trashUndo.widen` | `web/src/pages/Files.tsx:834` | Undo of a trash into a folder that is shared now. | Show it to more people? (`files.restoreWidenBody`) | Restore / Cancel | none | n/a | n/a | hidden for guests | shows-private-to-others | OK |
| `ui.files.restoreVersion` | `web/src/pages/Files.tsx:1744` | Version history › Restore; names people whose later edits drop out. Skipped when nobody else's later edits drop out (the restore can be undone). | Restore v{version}? / v{version}(으)로 되돌릴까요? (`files.restoreTitle`) | Restore / Cancel | none | n/a | n/a | hidden for guests | other:overwrite | OK (decision 11; decision 20261123-ask-registry-findings) |
| `ui.files.restoreVersion.widen` | `web/src/pages/Files.tsx:1747` | A version restore that widens who can see. | Show it to more people? (`files.restoreWidenBody`) | Restore / Cancel | none | n/a | n/a | hidden for guests | shows-private-to-others | OK |
| `ui.files.trash.restore.widen` | `web/src/pages/Files.tsx:1928` | Trash › Restore into a folder that is shared now. | Show it to more people? (`files.restoreWidenBody`) | Restore / Cancel | none | n/a | n/a | hidden for guests | shows-private-to-others | OK |
| `ui.project.members` | `web/src/components/ProjectMembersDialog.tsx:75` | Saving project members when people are added or removed. | Let more people see it? / 볼 수 있는 사람을 늘릴까요? · Change the members? / 멤버를 바꿀까요? (`projects.widenTitle`, `projects.changeTitle`) | Cancel / Let them see it · Save | none | n/a | n/a | the body counts guests that go | shows-private-to-others | OK |
| `ui.project.addMe` | `web/src/components/ProjectMembersDialog.tsx:113` | An owner or admin adds themselves to a project, only when the save also removes someone, adds a rule or restores the creator; adding only themselves goes with a notice. | Add yourself to '{name}'? / '{name}'에 나를 추가할까요? | Cancel / Add me | none | n/a | n/a | admin only | other:admin | OK |
| `ui.project.leave` | `web/src/components/LeaveProject.tsx` (through `web/src/lib/destructive.ts`) | Leave a project. | Leave '{name}'? / '{name}'에서 나갈까요? | Cancel / Leave | none | n/a | n/a | same | irreversible | OK |
| `ui.project.delete` | `web/src/components/projectActions.tsx` (through `web/src/lib/destructive.ts`) | Delete a project (to the trash, for good, or plain). | Move '{name}' to the trash? / '{name}' 프로젝트를 휴지통으로 옮길까요? | Cancel / Move to trash · Delete for good · Delete | none | n/a | n/a | the project's guests are switched off, the body says how many | irreversible | OK |
| `ui.scheduled.delete` | `web/src/pages/Scheduled.tsx` (through `web/src/lib/destructive.ts`) | Delete a scheduled task. | Delete scheduled task / 예약 작업 삭제 (`schedules.deleteTitle`) | Delete / Cancel | none | n/a | n/a | hidden for guests | irreversible | OK |
| `ui.sentFiles.delete` | `web/src/pages/SentFiles.tsx:63` | "Files you sent" › Delete (the message goes for everyone). | Delete {name}? / {name} 파일을 지울까요? (`sentFiles.confirmTitle`) | Delete / Cancel | none | n/a | n/a | same | irreversible | OK |
| `ui.nav.sectionDelete` | `web/src/components/nav/SidebarSections.tsx:142` | Delete a sidebar section. | Delete the section '{name}'? / '{name}' 섹션을 지울까요? | Cancel / Delete section | none | n/a | n/a | same | irreversible | OK |
| `ui.room.leave` | `web/src/components/rooms/RoomMenu.tsx` (through `web/src/lib/destructive.ts`) | Leave a group chat or private channel. | Leave this group chat? / 이 그룹 대화에서 나갈까요? | Cancel / Leave | none | n/a | n/a | a guest gets its own body | irreversible | OK |
| `ui.room.memberRemove` | `web/src/components/rooms/MembersDialog.tsx:51` | Remove someone from a group room. | Remove {name}? / {name}님을 내보낼까요? (`rooms.info.removeTitle`) | Cancel / Remove from chat | none | n/a | n/a | a guest subject gets its own body | other:access | OK |
| `ui.room.messageDelete` | `web/src/components/rooms/RoomMessages.tsx:476` | Delete a room message. | Delete this message? / 메시지를 삭제할까요? (`rooms.deleteTitle`) | Cancel / Delete | none | n/a | n/a | same | irreversible | OK |
| `ui.room.saveWiden` | `web/src/components/rooms/SaveToTeamSheet.tsx:91` | Save room files to a team folder people outside the conversation see. | Show it to more people? / 더 많은 사람이 보게 저장할까요? (`rooms.save.widenTitle`) | Cancel / Save | none | n/a | n/a | n/a | shows-private-to-others | OK |
| `ui.roomApp.newAddress` | `web/src/components/rooms/apps/AppsDialog.tsx:927` | Make a room app's webhook address again, or the Email app's address (#436). | Regenerate the Webhook URL? / Webhook URL을 다시 만들까요? (`roomApps.newAddressTitle`; `roomApps.newEmailTitle` for the Email app) | Cancel / Regenerate | none | n/a | n/a | n/a | irreversible | OK |
| `ui.roomApp.remove` | `web/src/components/rooms/apps/AppsDialog.tsx:936` | Remove an app from a room. | Remove {app} from {room}? / {room}에서 {app} 앱을 뺄까요? | Cancel / Remove | none | n/a | n/a | n/a | irreversible | OK |
| `ui.team.invite` | `web/src/components/TeamMenu.tsx:195` | "Invite people" (admins): a member link or a guest flow. | Invite people / 팀원 초대 (`teamMenu.invite`) | tabs / Close | none | n/a | n/a | admin only | sends-to-others | OK |
| `ui.team.linkRevoke` | `web/src/components/onboarding/TeamLinkPanel.tsx:627` | Turn off the team invite link. | Turn off the invite link? / 초대 링크를 끌까요? (`teamLink.revokeTitle`) | Cancel / Turn link off | none | n/a | n/a | admin only | irreversible | OK |
| `ui.handover.remove` | `web/src/components/handover/HandoverNotice.tsx:81` | The new owner removes the old owner. | Remove {name}? / {name}님을 내보낼까요? | Cancel / Remove | none | n/a | n/a | admin only | other:admin | OK |
| `ui.conn.delete` | `web/src/components/integrations/IntegrationRow.tsx:282` | Delete a connection. | Delete the connection {name}? / {name} 연결을 삭제할까요? | Cancel / Delete | none | n/a | n/a | hidden for guests | irreversible | OK |
| `ui.conn.requestDecline` | `web/src/components/integrations/AnswerDialog.tsx:84` | Admin declines a connection request. | Decline the request for {name}? / {name} 연결 요청을 거절할까요? | Cancel / Decline | none | n/a | n/a | admin only | other:admin | OK |
| `ui.conn.requestWithdraw` | `web/src/components/integrations/RequestDialog.tsx:46` | Withdraw my connection request. | Withdraw the request for {name}? / {name} 연결 요청을 철회할까요? | Cancel / Withdraw | none | n/a | n/a | hidden for guests | other:admin | OK |
| `ui.conn.templateDelete` | `web/src/components/integrations/TemplatesView.tsx:191` | Admin deletes a connection template. | Delete the template {name}? / {name} 템플릿을 지울까요? | Cancel / Delete | none | n/a | n/a | admin only | irreversible | OK |
| `ui.drive.shareStop` | `web/src/components/integrations/DriveShares.tsx:121` | Admin stops a shared Google Drive. | Stop sharing {name}? / {name} 공유를 멈출까요? | Cancel / Stop sharing | none | n/a | n/a | admin only | other:access | OK |
| `ui.drive.disconnect` | `web/src/components/settings/DriveConnection.tsx:194` | Disconnect my Google Drive. | Disconnect / 연결 해제 (`drive.disconnect`) | Cancel / Disconnect | none | n/a | n/a | hidden for guests | irreversible | OK |
| `ui.gapps.disconnect` | `web/src/components/integrations/GoogleAppConnector.tsx:95` | Disconnect my Google app. | Disconnect {name}? / {name} 연결을 해제할까요? | Cancel / Disconnect | none | n/a | n/a | hidden for guests | irreversible | OK |
| `ui.gapps.teamRemove` | `web/src/components/integrations/GoogleAppTeam.tsx:39` | Admin removes the shared Google account. | Remove the shared {name} account? / 함께 쓰는 {name} 계정을 없앨까요? | Cancel / Remove | none | n/a | n/a | admin only | irreversible | OK |
| `ui.gsign.remove` | `web/src/components/integrations/GoogleSignInRow.tsx:109` | Admin removes the company Google sign-in app. | Turn Google off for everyone? / 모두에게 Google을 끌까요? | Cancel / Turn Google off | none | n/a | n/a | admin only | other:admin | OK |
| `ui.slack.unlink` | `web/src/components/settings/SlackAccount.tsx:55` | Unlink my Slack account. | Unlink your Slack account? / Slack 계정 연결을 끊을까요? | Cancel / Unlink | none | n/a | n/a | n/a | irreversible | OK |
| `ui.devEnv.siteRemove` | `web/src/components/settings/DevEnvSites.tsx:34` | Remove an allowed dev-environment site. | Remove {host}? / {host} 사이트를 삭제할까요? | Cancel / Remove | none | n/a | n/a | hidden for guests | other:revoke | OK |
| `ui.devEnv.fullInternet` | `web/src/components/settings/DevEnvSites.tsx:40` | Turn on Full internet for the dev environment. | Turn on Full internet? / 전체 인터넷을 켤까요? | Cancel / Turn on | none | n/a | n/a | hidden for guests | security | OK |
| `ui.push.offEverywhere` | `web/src/components/settings/PushNotifications.tsx:137` | Turn notifications off on all devices. | Turn off notifications on all devices? / 모든 기기에서 알림을 끌까요? | Cancel / Turn off | none | n/a | n/a | same | other:devices | OK |
| `ui.settings.accountDelete` | `web/src/components/settings/AccountDeletion.tsx:171` | Delete my account; password again. | Delete your account? / 계정을 삭제할까요? (`accountDeletion.confirmTitle`) | Delete my account / Cancel | none | n/a | n/a | same | irreversible, security | OK |
| `ui.settings.aiApps.disconnect` | `web/src/pages/AiApps.tsx:64` | Settings › AI apps › Disconnect (phone only). | Disconnect {name}? / {name} 연결을 끊을까요? | Disconnect / Cancel | none | n/a | n/a | hidden for guests | other:mistap | OK |
| `ui.settings.browser.allowAll` | `web/src/pages/BrowserSettings.tsx:173` | Turn on "Allow all websites" (once, unless the desktop window already showed the risk). | Allow all websites? / 모든 웹사이트를 허용할까요? (`settings.browser.confirmTitle`) | Allow all websites / Cancel | sets the person's own switch | the same screen | n/a | hidden for guests | security | OK |
| `ui.settings.browser.clearSites` | `web/src/pages/BrowserSettings.tsx:300` | Clear all always-allowed sites of the desktop app. | Clear all always allowed sites? / 항상 허용한 사이트를 모두 지울까요? | Clear all / Cancel | n/a (removes Always) | n/a | n/a | hidden for guests | other:revoke | OK |
| `ui.settings.google.connect` | `web/src/components/settings/GoogleAccount.tsx:90` | Settings › Security & devices › Connect Google: password again (or a Google check without a password), then Google's own account page. | Connect a Google account / Google 계정 연결 (`settings.google.connectTitle`) | Connect / Cancel | none | n/a | n/a | same | security | OK |
| `ui.settings.google.disconnect` | `web/src/components/settings/GoogleAccount.tsx:79` | Settings › Security & devices › Disconnect Google (only with a password set). | Disconnect Google? / Google 연결을 끊을까요? (`settings.google.disconnectTitle`) | Disconnect / Cancel | none | n/a | n/a | same | security | OK |
| `ui.settings.security.signOutDevice` | `web/src/pages/Settings.tsx:655` | Sign out another device (phone only). | Sign out on {device}? / {device}에서 로그아웃할까요? | Sign out / Cancel | none | n/a | n/a | same | other:mistap | OK |
| `ui.settings.memory.clear` | `web/src/pages/Settings.tsx:827` | Settings › Memory › Forget everything. | Forget everything? / 메모리를 모두 지울까요? | Forget everything / Cancel | none | n/a | n/a | hidden for guests | irreversible | OK |
| `ui.settings.memory.forget` | `web/src/pages/Settings.tsx:872` | Forget one memory (phone only). | Forget this memory? / 이 메모리를 잊게 할까요? | Forget / Cancel | none | n/a | n/a | hidden for guests | irreversible | OK |
| `ui.settings.providers.deleteMine` | `web/src/pages/admin/Credentials.tsx:952` | Settings › AI accounts › remove my own connection. | Remove the connection '{label}'? / '{label}' 연결을 삭제할까요? | Delete / Cancel | none | n/a | n/a | same | irreversible | OK |
| `ui.admin.credentials.delete` | `web/src/pages/admin/Credentials.tsx:95` | Admin › AI connections › remove a team connection. | Remove the connection '{label}'? / '{label}' 연결을 삭제할까요? (`credentials.deleteConfirm`) | Delete / Cancel | none | n/a | n/a | admin only | irreversible | OK |
| `ui.admin.credentials.planAck` | `web/src/pages/admin/Credentials.tsx:733` | Adding a subscription connection: a required checkbox. | I have read the notice above / 위 안내를 확인했어요 (`credentials.planNoticeAck`) | checkbox + Save | none | n/a | n/a | same | other:provider-terms | OK |
| `ui.admin.ai.sharedSubscriptions` | `web/src/pages/admin/TeamAiSettings.tsx:339` | The owner turns subscription sharing on. | Enable subscription sharing? / 구독 공유를 켤까요? (`credentials.sharedRiskTitle`) | Enable sharing / Cancel | none | n/a | n/a | admin only | security | OK |
| `ui.admin.devEnv.accept` | `web/src/pages/admin/DevEnvTeam.tsx:115` | Turning the team dev environment on: a required checkbox. | I understand the risks and turn it on for the team / … (`devEnvTeam.accept`) | checkbox + Save | none | n/a | n/a | admin only | security | OK |
| `ui.admin.folderSharing.discard` | `web/src/pages/admin/FolderSharing.tsx:160` | Leaving the folder-access panel with unsaved edits. | Discard your changes? / 바꾼 내용을 버릴까요? | Discard / Cancel | none | n/a | n/a | admin only | other:unsaved | OK |
| `ui.admin.folderSharing.save` | `web/src/pages/admin/FolderSharing.tsx:300` | A save that widens, narrows or cuts people off. | Let # more people open it? / Take access away? (`folderAccess.confirm*`) | Give access / Cancel | none | n/a | n/a | admin only | shows-private-to-others, security | OK |
| `ui.admin.folderSharing.removeLinks` | `web/src/pages/admin/FolderSharing.tsx:769` | An opt-in box to remove link holders too. | Remove those links too / 그 링크도 없애기 | checkbox | none | n/a | n/a | admin only | other:access | OK |
| `ui.admin.groups.delete` | `web/src/pages/admin/Groups.tsx:50` | Delete a group. | Delete the group "{name}"? / "{name}" 부서를 삭제할까요? | Delete / Cancel | none | n/a | n/a | admin only | irreversible | OK |
| `ui.admin.originKept` | `web/src/pages/admin/originKept.tsx:32` | A group change where people keep folder access by name: the save goes with a notice; its Show opens this list (view, with Remove now). | Some people keep access by name / 이름으로 추가된 사람은 계속 열 수 있습니다 | Save / Cancel | none | n/a | n/a | admin only | other:info | OK |
| `ui.admin.members.revokeTeamLink` | `web/src/pages/admin/Members.tsx:153` | Turn off the team invite link. | Turn off the invite link? / 초대 링크를 끌까요? | Turn link off / Cancel | none | n/a | n/a | admin only | irreversible | OK |
| `ui.admin.members.resetLink` | `web/src/pages/admin/Members.tsx:183` | Create a password reset link for a member. | Create a password reset link for {name}? | Create link / Cancel | none | n/a | n/a | admin only | security | OK |
| `ui.admin.members.googleDisconnect` | `web/src/pages/admin/Members.tsx:192` | An admin disconnects a member's Google sign-in. | Disconnect {name}'s Google account? / {name}님의 Google 연결을 끊을까요? (`members.googleDisconnectTitle`) | Disconnect / Cancel | none | n/a | n/a | admin only | security | OK |
| `ui.admin.members.disable` | `web/src/pages/admin/Members.tsx:191` | Disable an active member. | Disable {name}? / {name}님을 비활성화할까요? | Disable / Cancel | none | n/a | n/a | admin only | security | OK |
| `ui.admin.members.remove` | `web/src/pages/admin/Members.tsx:218` | The owner removes a member. | Remove {name}? / {name}님을 삭제할까요? | Delete / Cancel | none | n/a | n/a | admin only | irreversible | OK |
| `ui.admin.members.removeReauth` | `web/src/pages/admin/Members.tsx:641` | An admin removes a member: password again. | Remove {name}? + password | Delete / Cancel | none | n/a | n/a | admin only | irreversible, security | OK |
| `ui.admin.home.oldProjects.join` | `web/src/pages/admin/OldProjectsCard.tsx:37` | Admin home › add me to old projects. | Add yourself to # projects? / 프로젝트 {count}개에 나를 추가할까요? | Add me / Cancel | none | n/a | n/a | admin only | sends-to-others | OK |
| `ui.admin.plugins.remove` | `web/src/pages/admin/Plugins.tsx:265` | Remove a plugin. | Remove {name}? / {name}을(를) 제거할까요? | Remove / Cancel | none | n/a | n/a | admin only | irreversible | OK |
| `ui.admin.skillManagers.remove` | `web/src/pages/admin/SkillManagers.tsx:221` | Take a skill manager's write access off. | Remove {name}? / {name}: 고칠 수 있는 사람에서 뺄까요? | Remove / Cancel | none | n/a | n/a | admin only | other:access | OK |
| `ui.admin.slack.remove` | `web/src/pages/admin/Slack.tsx:218` | Remove the Slack connection. | Remove the Slack connection? / Slack 연결을 삭제할까요? | Remove Slack / Cancel | none | n/a | n/a | admin only | irreversible | OK |
| `ui.admin.system.askCleanup` | `web/src/pages/admin/System.tsx:439` | Storage › ask the heaviest users to clean up. | Ask people to clean up? / 파일 정리를 요청할까요? | Ask / Cancel | none | n/a | n/a | admin only | sends-to-others | OK |
| `ui.admin.system.changeMode` | `web/src/pages/admin/System.tsx:683` | Change the server connection mode; password again. | Change connection / 연결 방식 바꾸기 | Save / Cancel | none | n/a | n/a | admin only | security | OK |
| `ui.admin.system.connectedRemove` | `web/src/pages/admin/System.tsx:762` | Disconnect a connected folder. | Disconnect folder / 연결 끊기 (`connected.removeTitle`) | Disconnect / Cancel | none | n/a | n/a | admin only | irreversible | OK |
| `ui.admin.system.connectFolder` | `web/src/pages/admin/System.tsx:793` | Connect a folder for the team; password again. | Connect a folder / 폴더 연결 | Connect / Cancel | none | n/a | n/a | admin only | shows-private-to-others | OK |
| `ui.admin.system.restoreBackup` | `web/src/pages/admin/System.tsx:1050` | Restore a server backup; password again. | Restore this backup? / 이 백업으로 복원할까요? | Restore / Cancel | none | n/a | n/a | admin only | irreversible | OK |
| `ui.admin.officeUpdate` | `web/src/pages/admin/OfficeUpdate.tsx:126` | Update the office Mac's app now; password again. | (`officeUpdate.confirmTitle`, `officeUpdate.confirmBody`) | Update now / Cancel | none | n/a | n/a | admin only | other:restart | OK |
| `ui.admin.system.update` | `web/src/pages/admin/jobs.tsx:86` | Install, retry or roll back an update; password again; with tasks running: wait or update now. | (the install title) + password | Continue / Update now anyway / Cancel | none | n/a | waits for running tasks unless "anyway" | admin only | other:restart | OK |
| `ui.admin.team.iconRemove` | `web/src/pages/admin/TeamSettings.tsx:354` | Remove the team logo. | Remove the team logo? / 팀 로고를 지울까요? | Remove / Cancel | none | n/a | n/a | admin only | irreversible | OK |
| `ui.admin.team.removeAllShares` | `web/src/pages/admin/TeamSettings.tsx:512` | Remove every share with outside people. | Remove access for # people to {what}? / {people}명의 {what} 접근 권한을 없앨까요? | Remove all / Cancel | none | n/a | n/a | admin only | irreversible | OK |
| `ui.admin.team.speechKeyRemove` | `web/src/pages/admin/TeamSettings.tsx:725` | Remove the speech key. | Remove the OpenRouter key? / OpenRouter 키를 지울까요? | Remove key / Cancel | none | n/a | n/a | admin only | other:feature-stops | OK |
| `ui.handover.transfer` | `web/src/components/handover/HandoverDialog.tsx:152` | The owner hands the team to another member; password again. | Make {name} the owner? / {name}님을 팀장으로 정할까요? (`handover.title`) | Transfer / Cancel | none | n/a | n/a | admin only | irreversible, security | OK |
| `ui.share.chatProject` | `web/src/components/chat/ShareChat.tsx:85` | The web side of `dialog.chat.project`: share a chat with its project's members. | Share this chat so {n} people can see it? / 이 채팅을 공유해서 {n}명이 볼 수 있게 할까요? (`chat.shareChat.title`) | Cancel / Share | none | n/a | n/a | same | irreversible, shows-private-to-others | OK |
| `ui.room.makeProject` | `web/src/components/rooms/MakeProjectDialog.tsx:190` | Make a project from a room or a 1:1 chat (its people become members). | Make project / 프로젝트 만들기 (`rooms.makeProject.confirm`) | Cancel / Make project | none | n/a | n/a | same | sends-to-others | OK |
| `ui.drive.confirmAccount` | `web/src/components/integrations/DriveConnector.tsx:106` | After the Google sign-in for Drive: is this the right account? | (`drive.confirmAccount`) | Connect / Cancel | none | n/a | n/a | hidden for guests | other:sign-in | OK |
| `ui.leave.unsaved` | `web/src/components/FilePanel.tsx:321` | Closing the browser tab with an unsaved file edit (the browser's own "Leave site?"). | (browser) | Leave / Stay | none | n/a | n/a | same | other:unsaved | OK |
| `ui.leave.uploads` | `web/src/components/FolderUploads.tsx:33` and `web/src/store/roomUploads.ts:254` | Closing the tab while files or room files are still uploading. | (browser) | Leave / Stay | none | n/a | n/a | same | other:unsaved | OK |
| `ui.leave.recording` | `web/src/lib/useVoiceInput.ts:603` | Closing the tab while a voice recording runs. | (browser) | Leave / Stay | none | n/a | n/a | same | other:unsaved | OK |
| `ui.leave.aiDefaults` | `web/src/pages/admin/TeamAiSettings.tsx:105` | Reloading or closing the tab with a change to Admin › Team settings › AI defaults or Who picks the engine not saved. | (browser) | Leave / Stay | none | n/a | n/a | admin only | other:unsaved | OK |

### Sign-in, setup and updates (로그인·설정·업데이트)

| id | where | trigger | text (en / ko) | buttons | always | revoke | scheduled | guests | reason | rule A |
|---|---|---|---|---|---|---|---|---|---|---|
| `desktop.team.outside` | `desktop/src/ui/welcome.ts:222` | Adding a team address that is not hosted and not known yet. | This address is not run by Trina. Make sure it is a server your company installed itself. / 트리나가 운영하는 주소가 아니에요… (`outside.body`) | Cancel / Connect | per address once added | Welcome › Remove from list | n/a | n/a | security | OK |
| `desktop.team.renamed` | `desktop/src/ui/welcome.ts:222` | The team moved to a new address at its relay. | This team moved to {host}. Connect to the new address? / 팀 주소가 {host}(으)로 바뀌었어요… (`err.renamed`) | Cancel / Connect | per address | Welcome › Remove from list | n/a | n/a | security | OK |
| `desktop.team.link` | `desktop/src/ui/welcome.ts:257` | A team or invite link for a team not open yet; yes armed after a short delay. | Connect to {host}? / {host}에 연결할까요? (`link.title`) | Cancel / Connect | none (each outside link) | n/a | n/a | n/a | security | OK |
| `desktop.team.remove` | `desktop/src/ui/welcome.ts:491` | Team list › Remove from list. | Remove {team} from the list? Sign-in and browser data saved in this app are deleted too. / {team}을(를) 목록에서 지울까요?… (`welcome.removeConfirm`) | Cancel / Remove | none | n/a | n/a | n/a | irreversible | OK |
| `desktop.update.refused` | `desktop/src/main/updater.ts:292` | A downloaded update fails its signature or hash check (once per version). | This update didn't pass its safety check, so it wasn't installed. / 이 업데이트는 안전 확인을 통과하지 못해서 설치하지 않았어요. (`update.refused.*`) | OK | none (a notice) | n/a | n/a | n/a | security | OK |
| `desktop.update.move` | `desktop/src/main/updater.ts:339` | The Mac app runs from the disk image and cannot update itself (once per version per run). | {app} can't update itself from where it is now. Move it to Applications… / …응용 프로그램 폴더로 옮기면… (`update.move.message`) | Move to Applications / Not now | once per version per run | n/a | n/a | n/a | other:update | OK |
| `desktop.update.failed` | `desktop/src/main/updater.ts:355` | An update could not install (once per version). | {app} couldn't update to version {version}… / …업데이트하지 못했어요… (`update.failed.message`) | Download / Not now | none | n/a | n/a | n/a | other:update | OK |
| `desktop.update.linux` | `desktop/src/main/updater.ts:417` | The .deb build: a newer signed version exists (once per version). | Version {version} is out. You have {current}. / 새 버전({version})이 나왔어요… (`update.linux.*`) | Open the download page / Later | per version | n/a | n/a | n/a | other:update | OK |
| `desktop.update.mac` | `desktop/src/main/updater.ts:444` | A Mac build that cannot update itself: a newer version exists (once per version). | Version {version} is out. You have {current}. (`update.mac.*`) | Download / Later | per version | n/a | n/a | n/a | other:update | OK |
| `desktop.linux.sandbox` | `desktop/src/main/main.ts:213` | The Linux AppImage on a system with no usable sandbox, at start. | {app} can't run safely on this system from the AppImage. / …AppImage로 안전하게 실행할 수 없어요. (`sandbox.*`) | Open the download page / Quit | none | n/a | n/a | n/a | security | OK |
| `desktop.folder.refused` | `desktop/src/main/app-window.ts:1061` | The folder window picked the home folder or a blocked system folder (a hard block). | The whole home folder can't be picked / This folder can't be picked (`folderPick.*`) | Pick another folder / Cancel | none | n/a | n/a | n/a | security | OK |
| `phone.team.outside` | `mobile/App.tsx:359` | Phone setup: an address that is not hosted. | This address is not run by Trina… (`outsideBody`) | Cancel / Connect | per address once saved | Change team address | n/a | n/a | security | OK |
| `phone.team.renamed` | `mobile/App.tsx:359` | Phone setup: the team moved. | This team moved to {host}. Connect to the new address? (`renamed`) | Cancel / Connect | per address | Change team address | n/a | n/a | security | OK |
| `phone.team.switch` | `mobile/App.tsx:359` | Phone setup: switching from the current team. | Leave {old} and connect to {new}? / {old}에서 나가고 {new}에 연결할까요? (`switchTitle`) | Cancel / Switch | none | n/a | n/a | n/a | irreversible (signs out) | OK |
| `phone.team.link` | `mobile/App.tsx:450` | A team or invite link opened on the phone; yes armed after 650 ms. | Connect to {host}? / {host}에 연결할까요? (`linkTitle`) | Cancel / Connect | none | n/a | n/a | n/a | security | OK |

### System permissions (시스템 권한)

| id | where | trigger | text (en / ko) | buttons | always | revoke | scheduled | guests | reason | rule A |
|---|---|---|---|---|---|---|---|---|---|---|
| `desktop.workfiles.consent` | `desktop/src/main/work-files.ts:188` and `desktop/src/common/work-consent.ts:54` | The team page asks "Find work files". Skipped when a yes of the last 90 days covers every place. | Bring your work files into {app} / 업무 파일을 {app}에 가져오기 (`workFiles.consentTitle`) | Not now / Find work files | per team, person and places, 90 days, on this computer | none in the app (90 days; new places ask again) | n/a | n/a | shows-private-to-others | OK |
| `desktop.workfiles.add` | `desktop/src/main/work-files.ts:486` | Assistive-tech users only: adding the files the look found. | Add # files from this computer? / 이 컴퓨터의 파일 {n}개를 넣을까요? (`workFiles.addTitle`) | Cancel / Add # files | none | n/a | n/a | n/a | shows-private-to-others | OK |
| `desktop.workfiles.pickroot` | `desktop/src/main/work-files.ts:365` | "Choose it yourself" after macOS kept the app out of Documents, Desktop or Downloads; the system folder window is the grant. | Choose your {folder} folder… (`workFiles.pickMessage`) | Open / Cancel | macOS keeps it while the app runs | n/a | n/a | n/a | shows-private-to-others | OK |
| `desktop.workfiles.pickfolder` | `desktop/src/main/work-files.ts:407` | "Choose a folder…" after a look. | Choose a folder to look through… (`workFiles.pickAnyMessage`) | Open / Cancel | while the app runs | n/a | n/a | n/a | shows-private-to-others | OK |
| `desktop.files.choose` | `desktop/src/main/app-window.ts:1000` | The team page's file input, also the Claude skills folder pick. | system open panel; Only the skills and CLAUDE.md in the folder you pick are read… (`files.claudeMessage`) | Open / Cancel | none | n/a | n/a | n/a | shows-private-to-others | OK |
| `desktop.folder.pick` | `desktop/src/main/security.ts:95` | The team page asks for a folder (showDirectoryPicker); the pick is a read-only grant. | system folder window | Select / Cancel | per folder while the app runs | sign out | n/a | n/a | shows-private-to-others | OK |
| `os.mac.folder` | `desktop/electron-builder.config.ts:60` | The first read of Desktop, Documents or Downloads after the consent window; macOS asks once per folder. | Looks for work files here. File contents stay on this Mac until you choose to add them. / 여기서 업무 파일을 찾아요… | Allow / Don't Allow | the system remembers per app | System Settings › Privacy & Security › Files and Folders | n/a | n/a | shows-private-to-others | OK |
| `os.mac.mic` | `desktop/electron-builder.config.ts:53` | The first voice input on the Mac app. | Voice input in chats uses the microphone. / 채팅 음성 입력에 마이크를 사용합니다. | Allow / Don't Allow | the system remembers per app | System Settings › Privacy & Security › Microphone | n/a | n/a | other:privacy | OK |
| `os.mac.localnetwork` | `desktop/electron-builder.config.ts:55` | macOS 15+: the first direct office connection to the team server. | Connects straight to your team server inside the office. / 사무실 안에서 팀 서버에 직접 연결합니다. | Allow / Don't Allow | the system remembers per app | System Settings › Privacy & Security › Local Network | n/a | n/a | other:privacy | OK |
| `os.mac.notify` | `desktop/src/main/app-window.ts:175` | The first desktop notification (system text). | (system) | Allow / Don't Allow | the system remembers per app | System Settings › Notifications | n/a | n/a | other:privacy | OK |
| `os.mac.menubar.notify` | `menubar/Sources/App.swift:91` | The menu bar app's first notice (system text). | (system) | Allow / Don't Allow | the system remembers per app | System Settings › Notifications | n/a | n/a | other:privacy | OK |
| `os.phone.push` | `mobile/src/push.ts:74` | The page's "turn on" button, only while not granted. | (system) | Allow / Don't Allow | the system remembers per app | phone Settings › Notifications; the app's "open settings" goes there | n/a | n/a | other:privacy | OK |
| `os.phone.mic` | `mobile/App.tsx:68` and `mobile/src/strings.ts` | The first voice input on the phone (Android asks before each recording until allowed). | Use your voice to type in chat. / 채팅에서 음성으로 입력할 때 사용해요. | Allow / Don't Allow | the system remembers per app | phone Settings › app › Microphone | n/a | n/a | other:privacy | OK |
| `os.phone.speech` | `mobile/modules/dictation/ios/DictationEngine.swift:304` | iPhones before iOS 26, the on-device recogniser. | Turn your voice into text on this iPhone, without sending the recording anywhere. / 녹음을 밖으로 보내지 않고 이 iPhone에서 바로 글자로 바꿀 때 사용해요. | Allow / Don't Allow | the system remembers per app | iOS Settings › Privacy › Speech Recognition | n/a | n/a | other:privacy | OK |
| `os.phone.photos` | `mobile/src/photo-io.ts:20` | A photo pick (the older Android picker asks for storage). | Choose a photo to attach in chat. / 채팅에 첨부할 사진을 고를 때 사용해요. | system | the system remembers per app | phone Settings › app › Photos | n/a | n/a | other:privacy | OK |
| `os.phone.camera` | `mobile/app.config.ts:84` | Taking a photo for chat from the page's file input. | Take a photo to attach in chat. / 채팅에 첨부할 사진을 찍을 때 사용해요. | system | the system remembers per app | phone Settings › app › Camera | n/a | n/a | other:privacy | OK |
| `os.web.pushAsk` | `web/src/components/WebPushAsk.tsx:32` | The app's own line offering notifications (web and phone), before the browser or phone asks. | Turn on notifications / 알림 켜기 (`push.askOn`, `push.askWeb`) | Turn on / Later | the app remembers Later | Settings › Notifications | n/a | same | other:privacy | OK |
| `desktop.downloads.save` | `desktop/src/main/downloads.ts:82` | A download in the desktop app: the system save window stays for runnable files, many saves, or a folder it cannot use. | (system save window) | Save / Cancel | none | n/a | n/a | same | security | OK |
| `os.web.push` | `web/src/lib/push.ts:87` | Settings › Notifications › Receive alerts on this device, in a browser. | (browser) after Receive alerts on this device / 이 기기에서 알림 받기 (`push.enable`) | Allow / Block | the browser remembers per site | the browser's site settings | n/a | same | other:privacy | OK |
| `os.web.mic` | `web/src/lib/recorder.ts:130` | The first voice input in a browser. | (browser) | Allow / Block | the browser remembers per site | the browser's site settings | n/a | same | other:privacy | OK |
| `os.web.install` | `web/src/lib/pwa.ts:18` | The browser offers to install the web app; the app holds the prompt until the person presses Install. | (browser) | Install / Cancel | the browser remembers | n/a | n/a | same | other:setup | OK |

## Kinds

Every card kind the code knows, and the entries that use it. The test compares this table with
`CARD_ALWAYS_KINDS` (`always:`), `TurnRequest` (`request:`), `AiAllowance` (`allowance:`) and `CARD_LATER_TOOLS`
(`waits:`).

The `auto` column says what auto mode does with the kind ([decisions/20261125-auto-mode.md](decisions/20261125-auto-mode.md)):
`auto` (no card; the call is free of the floor by its kind), `auto-if` (no card only when the call's own floor check
passes and the chat read nothing of other people and nothing from outside), `ask` (the card always shows), `n/a` (not a
permission: the AI's own questions, a pick between people, the web part that draws cards, a tool whose card waits). The
test compares the `always:` rows with `AUTO_KINDS` (`shared/src/api/ai-allowances.ts`); every other row is `ask` or
`n/a`, as no code path lets auto mode approve it. A kind with an entry whose reason is `irreversible` or `cost` is `ask`,
and one with `sends-to-others` is never `auto`.

| kind | ids | auto |
|---|---|---|
| `always:room_change` | `room.change`, `room.read`, `room.change.widen`, `browser.shared.change` | ask |
| `always:remember` | `memory.remember` | ask |
| `always:save_wider` | `save.wider`, `room.change.widen` | auto-if |
| `always:post_to_room` | `post.room`, `dialog.answer.room`, `ui.share.room` | ask |
| `always:shared_read` | `share.read`, `share.skill`, `share.copy`, `share.chat_file` | ask |
| `always:shared_save` | `share.save` | ask |
| `always:move_files` | `files.move`, `files.copy`, `files.copy.places`, `files.bulk.move`, `files.bulk.rename` | auto-if |
| `always:skill_files` | `skill.move`, `skill.copy`, `skill.files` | auto-if |
| `always:skill_save` | `skill.save`, `skill.own_change`, `skill.own_delete` | ask |
| `always:delete_files` | `files.delete` | ask |
| `always:project_members` | `project.members` | ask |
| `always:video` | `video.make` | ask |
| `always:big_download` | `download.big` | auto |
| `always:share_files` | `share.files` | ask |
| `always:post_files` | `post.room.files`, `dialog.answer.room` | ask |
| `always:share_folder` | `share.folder` | ask |
| `always:folder_access` | `folder.access`, `folder.access.many` | ask |
| `always:bulk_files` | `dev.bulk` | auto |
| `always:dev_login` | `dev.login` | ask |
| `request:ask_user` | `ai.ask_user`, `card.render` | n/a |
| `request:browser_site` | `site.office` | ask |
| `request:connect_service` | `conn.connect.service`, `conn.connect.reconnect`, `conn.connect.template`, `conn.connect.drive`, `conn.connect.google_app` | ask |
| `request:dev_env_site` | `dev.site` | ask |
| `allowance:room_files` | `room.change` | ask |
| `allowance:card` | `card.render` | n/a |
| `allowance:connector_tool` | `conn.shared`, `conn.shared.browser`, `conn.read.unsure`, `conn.write.own` | ask |
| `allowance:site` | `site.web`, `site.office` | ask |
| `allowance:person_alias` | `post.room.pick`, `share.files.pick` | n/a |
| `allowance:connector_send` | `conn.write` | ask |
| `allowance:picture` | `files.picture.notown` | ask |
| `waits:delete_files` | `files.delete`, `skill.own_delete` | n/a |
| `waits:share_with_person` | `share.files` | n/a |
| `waits:share_folder` | `share.folder`, `share.folder.stop` | n/a |
| `waits:stop_sharing` | `unshare.files` | n/a |
| `waits:web_fetch` | `site.web` | n/a |
| `waits:save_url` | `site.web`, `download.big` | n/a |
| `waits:preview_start` | `site.office`, `site.web` | n/a |
| `waits:read_page` | `site.office`, `site.web` | n/a |
| `waits:computer` | `site.office`, `site.web` | n/a |
| `waits:form_input` | `site.office`, `site.web` | n/a |
| `waits:navigate` | `site.office`, `site.web` | n/a |
| `waits:find` | `site.office`, `site.web` | n/a |
| `waits:get_page_text` | `site.office`, `site.web` | n/a |
| `waits:javascript_tool` | `site.office`, `site.web` | n/a |
| `waits:read_console_messages` | `site.office`, `site.web` | n/a |
| `waits:read_network_requests` | `site.office`, `site.web` | n/a |
| `waits:resize_window` | `site.office`, `site.web` | n/a |
| `waits:tabs_context` | `site.office`, `site.web` | n/a |
| `waits:tabs_create` | `site.office`, `site.web` | n/a |
| `waits:tabs_select` | `site.office`, `site.web` | n/a |
| `waits:tabs_close` | `site.office`, `site.web` | n/a |
| `waits:browser_batch` | `site.office`, `site.web` | n/a |
| `waits:file_upload` | `share.read` | n/a |
| `waits:post_to_room` | `post.room`, `post.room.files` | n/a |
| `waits:change_project_members` | `project.members` | n/a |
| `waits:change_folder_access` | `folder.access`, `folder.access.many` | n/a |
| `waits:skill_files` | `skill.files` | n/a |
| `waits:move_skill` | `skill.move`, `skill.copy` | n/a |
| `waits:schedule_create` | `schedule.create` | n/a |
| `waits:remember` | `memory.remember` | n/a |
| `waits:write` | `share.read`, `share.save`, `room.change`, `room.change.widen`, `save.wider`, `skill.save`, `skill.own_change` | n/a |
| `waits:edit` | `share.read`, `share.save`, `room.change`, `room.change.widen`, `save.wider`, `skill.save`, `skill.own_change` | n/a |
| `waits:make_file` | `share.read`, `share.save`, `room.change`, `room.change.widen`, `save.wider`, `skill.save` | n/a |

## Code index

Every file with lines that match the test's ask patterns, the number of such lines (comment lines do not count), and
the entries they raise. `definition`, `helper` and `not-an-ask` mark a matching line that raises nothing itself. More
lines than the row fails the test; fewer passes.

| file | sites | ids |
|---|---|---|
| `desktop/electron-builder.config.ts` | 5 | `os.mac.mic`, `os.mac.localnetwork`, `os.mac.folder` |
| `desktop/src/common/keyboard-focus.ts` | 1 | `not-an-ask` |
| `desktop/src/common/local-apps.ts` | 1 | `desktop.localapp.connect` |
| `desktop/src/main/app-window.ts` | 5 | `os.mac.notify`, `desktop.files.choose`, `desktop.folder.refused`, `desktop.browser.allowall`, `not-an-ask` |
| `desktop/src/main/downloads.ts` | 1 | `desktop.downloads.save` |
| `desktop/src/main/local-apps.ts` | 2 | `desktop.localapp.connect`, `helper` |
| `desktop/src/main/main.ts` | 1 | `desktop.linux.sandbox` |
| `desktop/src/main/pane/net-guard.ts` | 3 | `desktop.site.web`, `desktop.site.private` |
| `desktop/src/main/updater.ts` | 5 | `desktop.update.refused`, `desktop.update.move`, `desktop.update.failed`, `desktop.update.linux`, `desktop.update.mac` |
| `desktop/src/main/work-files.ts` | 2 | `desktop.workfiles.pickroot`, `desktop.workfiles.pickfolder` |
| `desktop/src/ui/pane.ts` | 1 | `desktop.site.web`, `desktop.site.private` |
| `desktop/src/ui/welcome.ts` | 3 | `desktop.team.outside`, `desktop.team.renamed`, `desktop.team.link`, `desktop.team.remove` |
| `menubar/Sources/App.swift` | 1 | `os.mac.menubar.notify` |
| `mobile/App.tsx` | 2 | `os.phone.mic`, `not-an-ask` |
| `mobile/app.config.ts` | 3 | `os.phone.camera`, `os.phone.mic`, `os.phone.photos`, `not-an-ask` |
| `mobile/modules/dictation/ios/DictationEngine.swift` | 1 | `os.phone.speech` |
| `mobile/src/photo-io.ts` | 1 | `os.phone.photos` |
| `mobile/src/push.ts` | 2 | `os.phone.push` |
| `mobile/src/strings.ts` | 12 | `os.phone.camera`, `os.phone.mic`, `os.phone.photos`, `os.phone.speech` |
| `server/src/chat/access-requests.ts` | 1 | `dialog.access.chat` |
| `server/src/chat/always-allow.ts` | 1 | `definition` |
| `server/src/chat/answer-share.ts` | 3 | `dialog.answer.room`, `helper` |
| `server/src/chat/connect-service.ts` | 10 | `conn.connect.service`, `conn.connect.reconnect`, `conn.connect.template`, `conn.connect.drive`, `conn.connect.google_app`, `helper` |
| `server/src/chat/delete-files.ts` | 3 | `files.delete` |
| `server/src/chat/folder-access-tool.ts` | 6 | `folder.access`, `folder.access.many` |
| `server/src/chat/open-questions.ts` | 2 | `helper` |
| `server/src/chat/personal-skills.ts` | 2 | `skill.own_change`, `skill.own_delete` |
| `server/src/chat/people-share.ts` | 5 | `dialog.chat.people`, `dialog.chat.people.files` |
| `server/src/chat/places-copy.ts` | 5 | `files.copy.places` |
| `server/src/chat/post-to-room.ts` | 3 | `post.room`, `post.room.files`, `post.room.guest` |
| `server/src/chat/project-members.ts` | 3 | `project.members` |
| `server/src/chat/room-tools.ts` | 2 | `save.wider`, `helper` |
| `server/src/chat/runtime.ts` | 1 | `helper` |
| `server/src/chat/schedule-edit.ts` | 1 | `schedule.edit` |
| `server/src/chat/schedule-review.ts` | 1 | `schedule.review`, `schedule.recheck` |
| `server/src/chat/share-chat.ts` | 1 | `dialog.chat.project` |
| `server/src/chat/share-folder.ts` | 4 | `share.folder`, `share.folder.stop` |
| `server/src/chat/share-with-person.ts` | 3 | `share.files` |
| `server/src/chat/shared-actions.ts` | 3 | `share.files.pick`, `share.folder.pick`, `unshare.files.pick`, `post.room.pick` |
| `server/src/chat/skill-files.ts` | 2 | `skill.files` |
| `server/src/chat/stop-sharing.ts` | 3 | `unshare.files` |
| `server/src/chat/tools.ts` | 33 | `dev.bulk`, `dev.login`, `dev.site`, `skill.move`, `skill.copy`, `memory.remember`, `ai.ask_user`, `ai.ask_user.in_call`, `site.office`, `helper` |
| `server/src/chat/turn.ts` | 33 | `room.change`, `room.read`, `room.change.widen`, `save.wider`, `share.read`, `share.skill`, `share.copy`, `share.save`, `share.chat_file`, `conn.shared`, `conn.shared.browser`, `browser.shared.change`, `skill.save`, `skill.save.name_taken`, `ai.ask_user`, `definition`, `helper` |
| `server/src/devenv/tool.ts` | 1 | `dev.login` |
| `server/src/integrations/connections/tools.ts` | 5 | `conn.shared`, `conn.write.noalways`, `conn.read.unsure`, `conn.write.own` |
| `server/src/integrations/slack/service.ts` | 4 | `slack.post`, `slack.post.anyway`, `slack.link` |
| `server/src/routes/slack.ts` | 1 | `slack.link` |
| `server/src/skills/lean-card.ts` | 1 | `helper` |
| `server/src/tools/connection-urls.ts` | 1 | `site.redirect` |
| `server/src/tools/file-moves.ts` | 2 | `files.bulk.move`, `files.bulk.rename`, `files.move`, `files.copy` |
| `server/src/tools/higgsfield.ts` | 2 | `video.make` |
| `server/src/tools/make-file.ts` | 1 | `save.wider` |
| `server/src/tools/own-picture.ts` | 1 | `files.picture.notown` |
| `server/src/tools/save-connector-file.ts` | 1 | `save.wider` |
| `server/src/tools/save-url.ts` | 1 | `download.big` |
| `server/src/tools/schedules.ts` | 2 | `schedule.create` |
| `server/src/tools/url-gate.ts` | 5 | `site.web`, `site.web.marked`, `site.web.echo`, `definition` |
| `web/src/components/AccessRequestNotice.tsx` | 1 | `ui.access.approve` |
| `web/src/components/FilePanel.tsx` | 2 | `ui.file.discardEdit`, `ui.leave.unsaved` |
| `web/src/components/FolderUploads.tsx` | 1 | `ui.leave.uploads` |
| `web/src/components/GuestInvite.tsx` | 1 | `ui.guest.convert` |
| `web/src/components/ProjectMembersDialog.tsx` | 4 | `ui.project.members`, `ui.project.addMe` |
| `web/src/components/chat/ChatShareDialog.tsx` | 1 | `ui.chat.shareDiscard` |
| `web/src/components/chat/AutoModePill.tsx` | 1 | `ui.auto_mode.intro` |
| `web/src/components/chat/ChatThreadPanel.tsx` | 1 | `ui.chat.threadDelete` |
| `web/src/components/chat/ShareChat.tsx` | 1 | `ui.share.chatProject` |
| `web/src/components/chat/ShareToRoom.tsx` | 3 | `ui.share.room`, `definition` |
| `web/src/components/handover/HandoverNotice.tsx` | 1 | `ui.handover.remove` |
| `web/src/components/integrations/AnswerDialog.tsx` | 1 | `ui.conn.requestDecline` |
| `web/src/components/integrations/DriveConnector.tsx` | 2 | `ui.drive.confirmAccount` |
| `web/src/components/integrations/DriveShares.tsx` | 2 | `ui.drive.shareStop` |
| `web/src/components/integrations/GoogleAppConnector.tsx` | 1 | `ui.gapps.disconnect` |
| `web/src/components/integrations/GoogleAppTeam.tsx` | 1 | `ui.gapps.teamRemove` |
| `web/src/components/integrations/GoogleSignInRow.tsx` | 1 | `ui.gsign.remove` |
| `web/src/components/integrations/IntegrationRow.tsx` | 1 | `ui.conn.delete` |
| `web/src/components/integrations/RequestDialog.tsx` | 1 | `ui.conn.requestWithdraw` |
| `web/src/components/integrations/TemplatesView.tsx` | 1 | `ui.conn.templateDelete` |
| `web/src/components/nav/SidebarSections.tsx` | 1 | `ui.nav.sectionDelete` |
| `web/src/components/onboarding/TeamLinkPanel.tsx` | 1 | `ui.team.linkRevoke` |
| `web/src/components/rooms/MakeProjectDialog.tsx` | 2 | `ui.room.makeProject` |
| `web/src/components/rooms/MembersDialog.tsx` | 1 | `ui.room.memberRemove` |
| `web/src/components/rooms/RoomComposer.tsx` | 1 | `room.mentionAll` |
| `web/src/components/rooms/RoomMessages.tsx` | 1 | `ui.room.messageDelete` |
| `web/src/components/rooms/SaveToTeamSheet.tsx` | 2 | `ui.room.saveWiden` |
| `web/src/components/rooms/SendHere.tsx` | 1 | `ui.share.roomSideChat` |
| `web/src/components/rooms/apps/AppsDialog.tsx` | 3 | `ui.roomApp.newAddress`, `ui.roomApp.remove`, `not-an-ask` |
| `web/src/components/settings/AccountDeletion.tsx` | 2 | `ui.settings.accountDelete` |
| `web/src/components/settings/DevEnvSites.tsx` | 2 | `ui.devEnv.siteRemove`, `ui.devEnv.fullInternet` |
| `web/src/components/settings/DriveConnection.tsx` | 2 | `ui.drive.disconnect` |
| `web/src/components/settings/GoogleAccount.tsx` | 2 | `ui.settings.google.connect`, `ui.settings.google.disconnect` |
| `web/src/components/settings/PushNotifications.tsx` | 1 | `ui.push.offEverywhere` |
| `web/src/components/settings/SlackAccount.tsx` | 1 | `ui.slack.unlink` |
| `web/src/components/ui.tsx` | 3 | `definition` |
| `web/src/lib/destructive.ts` | 1 | `ui.chat.delete`, `ui.chat.leave`, `ui.project.leave`, `ui.project.delete`, `ui.scheduled.delete`, `ui.room.leave` |
| `web/src/lib/push.ts` | 1 | `os.web.push` |
| `web/src/lib/pwa.ts` | 1 | `os.web.install` |
| `web/src/lib/recorder.ts` | 1 | `os.web.mic` |
| `web/src/lib/useVoiceInput.ts` | 1 | `ui.leave.recording` |
| `web/src/pages/AiApps.tsx` | 1 | `ui.settings.aiApps.disconnect` |
| `web/src/pages/BrowserSettings.tsx` | 3 | `ui.settings.browser.allowAll`, `ui.settings.browser.clearSites` |
| `web/src/pages/Files.tsx` | 14 | `ui.files.bulkMove.narrow`, `ui.files.bulkMove.widen`, `ui.files.bulkShare`, `ui.files.uploadClash`, `ui.files.move.widen`, `ui.files.move.narrow`, `ui.files.share`, `ui.files.trashUndo.widen`, `ui.files.restoreVersion`, `ui.files.restoreVersion.widen`, `ui.files.trash.restore.widen` |
| `web/src/pages/Projects.tsx` | 1 | `not-an-ask` |
| `web/src/pages/SentFiles.tsx` | 2 | `ui.sentFiles.delete` |
| `web/src/pages/Settings.tsx` | 3 | `ui.settings.security.signOutDevice`, `ui.settings.memory.clear`, `ui.settings.memory.forget` |
| `web/src/pages/SlackLink.tsx` | 1 | `slack.link` |
| `web/src/pages/admin/Credentials.tsx` | 2 | `ui.admin.credentials.delete`, `ui.settings.providers.deleteMine` |
| `web/src/pages/admin/FolderSharing.tsx` | 4 | `ui.admin.folderSharing.discard`, `ui.admin.folderSharing.save` |
| `web/src/pages/admin/Groups.tsx` | 1 | `ui.admin.groups.delete` |
| `web/src/pages/admin/Guests.tsx` | 1 | `ui.admin.guests.remove` |
| `web/src/pages/admin/Members.tsx` | 6 | `ui.admin.members.revokeTeamLink`, `ui.admin.members.resetLink`, `ui.admin.members.googleDisconnect`, `ui.admin.members.disable`, `ui.admin.members.remove`, `ui.admin.members.removeReauth` |
| `web/src/pages/admin/OfficeUpdate.tsx` | 2 | `ui.admin.officeUpdate` |
| `web/src/pages/admin/OldProjectsCard.tsx` | 1 | `ui.admin.home.oldProjects.join` |
| `web/src/pages/admin/Plugins.tsx` | 1 | `ui.admin.plugins.remove` |
| `web/src/pages/admin/SkillManagers.tsx` | 1 | `ui.admin.skillManagers.remove` |
| `web/src/pages/admin/Slack.tsx` | 1 | `ui.admin.slack.remove` |
| `web/src/pages/admin/System.tsx` | 5 | `ui.admin.system.askCleanup`, `ui.admin.system.changeMode`, `ui.admin.system.connectedRemove`, `ui.admin.system.connectFolder`, `ui.admin.system.restoreBackup` |
| `web/src/pages/admin/TeamAiSettings.tsx` | 2 | `ui.admin.ai.sharedSubscriptions`, `ui.leave.aiDefaults` |
| `web/src/pages/admin/TeamSettings.tsx` | 3 | `ui.admin.team.iconRemove`, `ui.admin.team.removeAllShares`, `ui.admin.team.speechKeyRemove` |
| `web/src/pages/admin/common.tsx` | 1 | `definition` |
| `web/src/pages/admin/jobs.tsx` | 1 | `ui.admin.system.update` |
| `web/src/pages/admin/originKept.tsx` | 1 | `ui.admin.originKept` |
| `web/src/store/roomUploads.ts` | 1 | `ui.leave.uploads` |

## Findings

Found by the first inventory (2026-11-22). Fixed or decided in
[decisions/20261123-ask-registry-findings.md](decisions/20261123-ask-registry-findings.md): every VIOLATION and OPEN
item above is now OK. Remove an item here when its entry's Rule A changes to OK.

### Kept exceptions to Rule A (decided; do not re-raise)

- `schedule.create`: no Always. Each task runs when nobody is watching and may send, so a task that sends to others keeps
  the card; one the person asked for in their own words that sends nowhere is made without it, with Pause and Delete on
  its step (decision 20261123-do-then-undo).
- `share.folder.stop`, `unshare.files`: no Always. Stopping a share only narrows access and has Undo; no card when the
  message names it.
- `conn.write.noalways`: in a shared chat a connector send to other people asks every time (decision
  20261122-connector-always-allow).
- `ui.share.chatFiles`: "Share the files too" starts unticked (decision 20261121-share-chat-files).

### Other findings (not Rule A)

- `dev.login`: the card text is English only (hard-coded in `server/src/devenv/tool.ts`), no Korean.

