# A room's private AI answer asks whether to post it, also when it used a hidden earlier answer

- Date (UTC): 2026-11-08 09:17
- Branch: `feat/room-answer-post-ask`
- Status: in progress
- Where: trina-ax core, `server/src/rooms/` (a new `earlier-sources.ts`, small edits in `ai.ts`), `shared/src/api/rooms.ts`,
  `web/src/components/rooms/RoomMessages.tsx`. Why: rooms, the room AI's share rule and permissions are core (see
  docs/REPOSITORY-RULES.md)
- Version impact: minor. A visible change in rooms and a wider share rule; no migration, no new route.

## Goal

In a team room someone asks @트리나 and the answer stays private: "🔒 나만 볼 수 있어요 · 방 사람 중 일부에게 가려진 예전
답을 참고해서 대화방에 올릴 수 없어요." There is no way to post it. The owner: "그냥 포스팅을 못한다고 하면 어케해? 포스팅을
할지 물어봐야지". The asker should be asked, with what is at stake in sight, instead of being refused.

Today (docs/DECISIONS.md "대화방의 트리나", "지난 대화"): a private preview whose reasons are folders, the asker's own
folder, the web or members who joined later has a one-click 올리기 (`RoomAi.share`). A preview built on an earlier answer
hidden from some member (`Decision.hidden`) has none, and `share()` answers 409 `room_ai_hidden`, because the asker
cannot see what is at stake for those members.

## Scope

In:
- **The hidden case becomes askable when its sources can be named.** For the earlier answers hidden from some member
  that the question used (the same ones `decide()` finds now), the new `rooms/earlier-sources.ts` follows what each was
  built on: its kept scope (`room_ai_turns.scope`, or a person's message's `source_scope`). This same room as a source
  is followed through the answers in it hidden from those members, recursively (a depth limit and a visited set); a
  hidden thread reply also through its thread's first message. When every source reached is a team folder (or the top
  of the team folder) the asker may read now, a name they may list, or their own folder, those sources join the
  answer's own in `decide()`: the case is then like `folders` (named, counted, postable) and `hidden` is cleared. Shared
  project chats are kept as their project folder in a scope (chat/room-project-chats.ts), so they resolve as that
  folder. Anything else stays refused as today (no button, 409 `room_ai_hidden`): another room (a DM, a group chat,
  another team room), a connection, a shared Drive, the web or another outside tool, no kept scope, a source type this
  build does not know, someone else's own folder, a folder or name the asker cannot open now, too deep or too many, and
  a member whose history is not worked out yet. Including more than the answer used (an answer of the room the hidden
  one did not see) only adds folders the asker can open, or refuses.
- **Counts.** The decision keeps, for each folder it names, how many members (not the asker) cannot see it
  (`preview.unable`), the same count the share-to-room dialog gives; never who.
- **One line, one button.** The notice says in one plain line why only I see it ("방 사람 중 일부가 볼 수 없는 자료를
  참고한 답이라 지금은 나만 보고 있어요."; the web or a connection alone: its own line; a refused one: "가려진 예전 답을
  참고해서 방에 올릴 수 없어요."). The button "방에 올리기…" shows exactly when `!preview.hidden`, which is the server's
  own rule in `share()`.
- **The confirm step.** The button opens the app's generic `confirmDialog`: one row per reason ("재무 · 방 사람 중 2명은
  못 봐요", "내 폴더 · 다른 사람은 못 봐요", who joined later, the web), a line when it went through a hidden earlier
  answer, then [방에 올리기] / [취소]. Confirmed, `share()` posts it as today (the AI's message, "○○ 님이 물어봄",
  audited `room.ai_share`, now with `earlier: true` in the detail). Cancel changes nothing. Every postable preview gets
  the same step: posting something some members cannot see always shows what is at stake first.
- **Reasons that changed.** `share()` decides again; a changed decision (now also a changed count) is saved, sent as
  `room.message.updated`, and answered 409 `room_ai_reasons_changed`. The app shows the server's one-line reason as a
  toast; the notice and its button follow the update. A preview decided before this build (no counts) is compared
  without them, so it is not asked again for that alone.
- **Existing refused previews.** At start, the private previews kept as `hidden` are decided again once (the newest 500),
  so a preview made before this build gets the button when it now qualifies.
- Threads: the same notice, button and confirm (the share rule over the members who see the root, as today). Phones:
  the same line wraps at 390 px; the dialog is the bottom sheet `Modal` already is.
- Five languages (ko, en, id, ja, es), plain 해요체 in ko. Server strings for the refusals updated to the same words.
- Docs: a DECISIONS.md entry amending "대화방의 트리나" / "지난 대화" (the transitive rule and why it is safe: the asker
  can open every source and the confirm names them with counts, as the share dialog does); a CHANGELOG line.

Out:
- The share-to-room dialog (`web/src/components/chat/ShareToRoom.tsx`, another teammate's) and the answer share from a
  personal chat (`chat/answer-share.ts`, its `answer_share_hidden` rule) are not changed. The room preview keeps its own
  existing path (`RoomAi.share`): reusing ShareToRoom would need a new room endpoint, a fixed-room mode in that dialog and
  posting as the person instead of the AI (decided with the coordinator, 2026-11-08). So no attach switches here:
  sources some members cannot read leave the posted answer's list and their links show a lock, as today.
- No migration, no new route (only `RoomMessage.preview` gains two optional fields).

## Steps

1. Plan (this commit).
2. `server/src/rooms/earlier-sources.ts`: the resolver, the decision comparison, the start-up pass.
3. `rooms/ai.ts`: `decide()` collects the members with hidden answers per room source and calls the resolver; per-folder
   counts; `earlier` in the decision and the audit; `share()` compares with the new helper. `shared/src/api/rooms.ts`:
   `preview.earlier`, `preview.unable`. `rooms/store.ts` passes them on.
4. Web: `PreviewLine` (one line, "방에 올리기…", the confirm), `previewLine` / `previewReasons`, five languages.
5. Tests: server (`tests/unit/b-rooms-history.test.ts`, `b-rooms-ai.test.ts`, threads), web unit, an e2e spec.
6. DECISIONS.md, CHANGELOG.md, screenshots, PR to dev.

## Risks

- PR #198 (feat/room-ai-allowances) also changes `rooms/ai.ts` and `chat/turn.ts`, and adds migration 266. This keeps the
  `ai.ts` diff to `decide()`'s room branch, a few fields and `share()`'s comparison, and does not touch `turn.ts`. No
  migration here; the highest on dev is 337 (plus 600/701).
- Permissions: the wider rule names only sources the asker can open now, counts members without naming them, and posts
  only after the asker confirms what they see. The refused cases keep the 409 on the server, whatever the app shows.
- Cost: the resolver runs only when a question used an answer hidden from a member (rare), bounded by depth and count.
- Five languages; phone 390 px and desktop 1440 px, light and dark.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `docs:api` (no route change expected), the room server
suites (b-rooms-ai*, b-rooms-history, b-answer-share), web unit tests in Docker, `bun run --cwd web build` and the full
web e2e (after `bun run prepare:hwp`), with a new spec: private answer → 방에 올리기… → confirm → posted; cancel leaves it
private; a changed reason is said and the notice follows.

## Result

Filled in at the end.
