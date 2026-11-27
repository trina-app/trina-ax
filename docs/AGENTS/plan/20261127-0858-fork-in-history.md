# How a continued chat shows in the Trina history

- Date (UTC): 2026-11-27 08:58
- Branch: `ui/fork-tree-visible`
- Status: done (the owner picked "클로드랑 동일하게 해", 2026-11-27: option A with the tree at the original's place;
  see "Owner's decision" below)
- Where: web history lists (lib/forkTree.ts, nav/HistoryList.tsx DateGroups, nav/HistorySections.tsx, nav/ChatItem.tsx,
  pages/Projects.tsx, index.css). Why: how the web app lists chats (docs/REPOSITORY-RULES.md)
- Version impact: minor (a new optional query field, `ids` on GET /api/chats, for decision 3; no migration)

## Goal

The owner looked at the history after #641 / chat-fork-tree and could not see where a chat was continued from: "어디서
fork가 된건지 안보이네..? 들여쓰기가 안되어서? 이거 클로드랑 같이 UX를 안가져갔구나?"

Why: today a continuation sits under its original only when both are in the same list and the **same date group**
(docs/decisions/20261126-chat-fork-tree.md, "nothing moves an older chat up"). The usual case is an original from
yesterday or earlier, continued today: the continuation stands alone in "Today", the original in "Yesterday", and there
is no indent at all. Where an indent does show, it is 20 px with nothing else, which is easy to miss.

This plan decides what people see on every surface, before any more code.

Owner decisions that stand (not reopened): one level only, no folding, the label "새 채팅에서 이어 하기" (never "포크"),
the title "<제목> (이어서)", "목록에서 따로 두기" makes a chat stand on its own.

## Owner's decision (2026-11-27)

"클로드랑 동일하게 해": as the Claude app. Option A, with one change against the recommendation below: **decision 4 is
reversed to Claude's behaviour.** The original is not lifted into 오늘. Every continuation sits right under its original
at the original's own place in the list, in the original's date group, whatever group it would be in on its own (the
11-26 "nothing moves an older chat up" stays; the "same date group only" rule goes). Claude does this: its changelog
says nested sessions "appear under the original session in the sidebar", and #100216 is a user complaining that a fork
in use stays under an old parent. Decisions 1-3 as recommended (1: same section, outside when full, the fork never
fails; 2: Group by Project flat; 3: one batched `ids` read through `historyWhere` and `visible()`, all of a row's
forkParents). The look: one small "└", 28 px, nothing else. Where this plan says "the tree sits at its newest chat's
place" below, read "at its original's place".

So the mockup of A becomes:

```
오늘
  회의록 정리
어제
  견적 비교
이번 주
  보고서 초안                    (3일 전, 제자리)
  └ 보고서 초안 (이어서)         (오늘 썼어도 원래 채팅 밑)
```

## 1. Reference: how others show it

| Product | What the list shows | Source | Verified? |
|---|---|---|---|
| Claude desktop, Code tab | Forks are **nested under the session they came from** in the sidebar; a fork's title is "<title> (fork)"; the row menu has "Detach to top level" (cannot be undone); a nested session started by Claude also "appears under the original session in the sidebar". | Changelog: "nested sessions … appear under the original session in the sidebar" ([claude.com/docs/cowork/changelog](https://claude.com/docs/cowork/changelog)); Desktop docs: "the sidebar lists the started session under the current session" ([code.claude.com/docs/en/desktop](https://code.claude.com/docs/en/desktop)); user reports [#108542](https://github.com/anthropics/claude-code/issues/108542) ("nested under their parent in the sidebar ("<title> (fork)")", "Detach to top level"), [#109616](https://github.com/anthropics/claude-code/issues/109616) | Nesting of started sessions: **official docs, confirmed 11-27** (changelog v2.42304.0 and v3.1623.0: "appears under the original session in the sidebar and reports back to it"; Desktop docs: "the sidebar lists the started session under the current session"). Nesting of forks, the "(fork)" title, "Detach to top level": **user reports, confirmed 11-27** (#108542 open, #109616 closed) plus the team's own look at the app on 2026-11-26; not in Anthropic's docs. Neither source says how children are ordered. |
| Claude desktop, what users dislike about it | (1) "a fork I'm actively using stays buried under an old parent session instead of appearing at the top of the list", "Sort by recency no longer reflects what I worked on last" ([#100216](https://github.com/anthropics/claude-code/issues/100216)); (2) pinning a chat also shows its forks in Pinned ([#106380](https://github.com/anthropics/claude-code/issues/106380)); (3) a session whose parent was archived floats at the top level, so related sessions sit in two places; nesting came with no notice ([#102129](https://github.com/anthropics/claude-code/issues/102129)). | GitHub issues | **User reports, confirmed 11-27** (all three open). #100216 also says "nested forks are ordered inside their parent", so the tree sits at the parent's place, not at the newest fork's; read from the report, not seen by us. |
| claude.ai (chat) | Editing a message makes another version **inside the same chat** (arrows under the message); no new chat, nothing in the list. | Third-party descriptions only (e.g. [claudetopdf.vercel.app](https://claudetopdf.vercel.app/branch-conversations-in-claude)); no support.claude.com page found | **Assumed** (widely known, no official page found). Not the same feature as ours. |
| ChatGPT, "Branch in new chat" | Under a reply, ⋯ → "Branch in new chat". The branch is a **separate, flat chat** in the history, **not nested**; its title starts with "Branch"; inside, a line marks where it branched. | OpenAI support replies pointing at the [release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes) ([community thread](https://community.openai.com/t/branching-conversations-for-long-term-learning-and-projects/1385388)); press: [BGR](https://bgr.com/1959993/chatgpt-branch-conversations-new-feature-now-available), [Tom's Guide](https://www.tomsguide.com/ai/chatgpt-just-quietly-rolled-out-a-game-changing-upgrade-heres-why-im-already-obsessed-with-it) | Feature name, "separate chat in the history, not nested", the "Branch" title and the line where it branched: **press, confirmed 11-27** (BGR); the release-note text itself was not read (page too long to fetch). |
| Cursor | "Fork Chat" (was "Duplicate Chat", renamed in 2.5) "copies the parent conversation into a new chat"; side chats are "durable child conversations attached to a parent agent". | [cursor.com/help/ai-features/side-chats](https://cursor.com/help/ai-features/side-chats), [forum](https://forum.cursor.com/t/docs-contradict-each-other-on-what-fork-chat-copies-3-17-19/169458) | What a fork is: **official help page**. How a fork shows in the list or tabs: **not documented**, not checked. |

What we take from it: the owner wants the Claude look (a continuation visibly under its original). ChatGPT shows that a
flat list plus a title word ("Branch", our "(이어서)") is the other common way. The Claude complaints tell us what to
avoid: a continuation in use must not be buried under an old original, and a pin must not drag other chats with it.

## 2. Options

The examples use: "보고서 초안" (last used 3 days ago, so in 이번 주), its continuation "보고서 초안 (이어서)" used
today, and an unrelated "회의록 정리" used today, newer.

### A. Tree under the original; the whole tree moves to its newest activity (recommended)

```
오늘
  회의록 정리
  보고서 초안
  └ 보고서 초안 (이어서)
어제
  견적 비교
이번 주
  고객 메일 답장
```

- The original comes up to 오늘 with the continuation, which sits right under it, indented, with a faint "└" in front. A tree sits where its most recently used chat would sit.
- Findability: best. The chat I just used is near the top, and its origin is right above it.
- Clutter: one connector per row, no badge, no text.
- Order surprise: the original appears in 오늘 though I did not touch it today. The connector explains why. This is the
  reverse of the 11-26 "nothing moves an older chat up" rule, and it is what fixes Claude's complaint #100216. The
  11-26 decision chose against exactly this ("the group at its newest row", because old chats jumped up), so it needs
  the owner's explicit OK (open decision 4), not a silent change. What jumps is small: only a chat that has a
  continuation, and only when that continuation is used; using any other chat moves nothing else.
- Non-developers: reads like a file tree or an email thread; the title's "(이어서)" says it in words too.

### B. Flat list; each continuation has a small "← 원래 제목" line

```
오늘
  회의록 정리
  보고서 초안 (이어서)
    ← 보고서 초안
어제
  견적 비교
이번 주
  고객 메일 답장
  보고서 초안
```

- Every chat keeps its own date; the continuation says where it came from in a second grey line.
- Findability: the origin is named but is somewhere else in the list (here two groups down).
- Clutter: a second line on every continuation (rows get taller; the history rows have one line today).
- Order surprise: none.
- Non-developers: clear words, but it is ChatGPT's way, not the Claude look the owner asked for, and the title already
  says "(이어서)", so the line mostly repeats it.

### C. Flat history; the original says "이어 한 채팅 n개" inside the chat

```
history:                         inside "보고서 초안":
오늘                              ┌──────────────────────────────┐
  회의록 정리                     │ 이어 한 채팅 1개 › 보고서 초안 (이어서) │
  보고서 초안 (이어서)            └──────────────────────────────┘
이번 주
  보고서 초안
```

- The list stays as it is now (flat), and the link both ways lives in the chats ("‘제목’에서 이어 왔어요" already exists
  in the continuation).
- Findability: weakest in the list; nothing shows the relation until a chat is opened.
- Clutter: none in the list, one line in the chat.
- Order surprise: none.
- Non-developers: fine, but it does not answer the owner's question ("어디서 fork가 된건지 안보이네").

## 3. Recommendation: A, on these surfaces

One rule everywhere a list shows my history: **a continuation sits right under the nearest chat it came from that is a
row of the same list; the whole tree sits at the place of its newest chat by the list's sort; one level; nothing
folds.** Rows inside a tree: the original first, then its continuations in the list's own sort (newest first by
default, as every other row of the list; by title with Sort by: Title). Claude's order inside a parent is not
documented, so there is nothing to copy there; the list's own sort keeps the continuation just used right under its
original. A continuation of a continuation sits at the same level, under the first chat.

The look: indent 28 px (the continuation's title starts under the original's title plus one step) and one small elbow
("└", 1 px, `--color-line`, light and dark) in front of each continuation, drawn by a pseudo-element of `.tree-row`
(`inset-inline-start`, not `left`). The same elbow on every continuation: no "├" / "└" split, no rail between rows, no
last-row mark. The row's hover and selected background start at the indent (as `.tree-row` does today). Nothing else:
no badge, no count, no arrow. On a phone (390) the same 28 px. A screen reader hears the title with "(이어서)", which
says it in words; no tree roles.

The whole panel with A (the original "보고서 초안" was last used 3 days ago; "견적 비교" has two continuations, one renamed;
"월간 리포트" is pinned, so its continuation stands alone):

```
트리나 기록
고정됨
  📌 월간 리포트
오늘
  회의록 정리
  보고서 초안                    ← 3일 전 채팅, 이어 한 채팅과 함께 올라옴
  └ 보고서 초안 (이어서)
  월간 리포트 (이어서)           ← 원래 채팅이 고정돼 있어 혼자 섬
어제
  견적 비교
  └ 견적 비교 (이어서)
  └ 견적 B안 정리               ← 이름을 바꾼 이어 한 채팅 (이어서의 이어서도 같은 줄)
이번 주
  고객 메일 답장
```

(The "←" notes are for this plan only; the screen shows no text beside the rows.)

| Surface | What the person sees |
|---|---|
| History by date (default; the Trina panel at rest, the filtered list, the phone's 트리나 tab and ☰ drawer) | The tree in the date group of its newest chat (Sort by: Last activity; with Sort by: Date created, of its newest-created chat). A folded date's count and mark include the tree's rows. |
| One list (Group by: None) | The same tree at its newest chat's place. With Sort by: Title, at the original's title (the continuations' "(이어서)" titles sort next to it anyway). |
| Group by: Project | Flat, as now (its caps count rows). The "(이어서)" title says what the row is. See open decision 2. |
| My sections (per person) | A tree only inside one section. A continuation outside the original's section stands alone where it is. See open decision 1. |
| Pinned | Flat: a pin is one chat. A pinned original is only in Pinned; its continuations stand alone in the history. A pinned continuation is only in Pinned; the original stays in the history alone. (Avoids Claude's #106380.) |
| Chats panel (대화) | Not affected: it lists rooms, 1:1 and group chats, not AI chats. A room's side chat (✦) cannot be continued. |
| Search (⌘K) | Flat, on purpose: results are ranked by match, a tree would reorder them. The "(이어서)" title is enough. "최근" (no text typed) stays flat too (8 rows by last activity). |
| A project's chat list (project page) | The same tree for my chats, pinned rows first and flat, then the rows with trees at their newest chat's place. Today it is flat. Only my own continuations carry `forkParents`, but one may sit under a team chat someone else made (the "나만 보는 새 채팅에서 이어 하기" case): that nesting is drawn for me alone; the others see the shared chat as before and never my continuation. The rows here are `ProjectChatRow` in a `divide-y` list, not `ChatItem`: the tree needs its own indent there, and no divider between an original and its continuations (the divider of a continuation starts at the indent). |
| 삭제한 기록 (trash) | Flat (a list of deleted chats, each restored on its own). |
| A room's side panel (✦) list | Not affected: a side chat cannot be continued (server `fork_not_here`), so no row there has `forkParents`. |
| Inside the chat (the top line and the line under the box) | Unchanged: the continuation already says "‘제목’에서 이어 왔어요" with a link (ChatEvents `ForkedFromLine`, WhoSees `ForkWho`). The original gets no "이어 한 채팅" line (option C is not built). |
| Notices, unread marks, links, hover peek | Not affected: a continuation is mine alone, nobody is told (fork.ts), `/c/<id>` links and the peek do not read the tree. A session marker shows on the row it belongs to, inside the tree as anywhere. |

The decision file `docs/decisions/20261126-chat-fork-tree.md` gets a successor (a new file, as docs/decisions/README.md
says) that replaces its "Order: every chat keeps its own place" and "same date group" parts and the project-page part of
"Left out"; everything else in it stays.

## 4. Edge cases

- **Original deleted:** it is in 삭제한 기록, not in the list, so its continuations stand alone (or under the
  original's own original, if that is in the list). Restored, it takes them back. Emptied from the trash, its
  continuations point at its own original (already built: `purgeChat`).
- **Original hidden** (Hide from my list) **or no longer shared with me** (left the project, removed from the chat): not
  in my list, the same as deleted. The continuation's "‘제목’에서 이어 왔어요" line stays, as a link only while I may open
  the original.
- **Continuation of a continuation:** one level; it sits under the first chat of the chain that is in the list, with
  its siblings, newest first. If the middle one is deleted, nothing changes visibly; if the first is deleted, the middle
  one becomes the top of the tree.
- **Pinned original / pinned continuation:** see Pinned above; a pin never pulls others into Pinned.
- **Different sections:** a tree only within one section; moving a chat into a section moves that chat only.
- **Very old original** (beyond the pages loaded so far): see open decision 3. Without it, the continuation stands
  alone until "더 보기" brings the original, and then the tree jumps together.
- **Two continuations with one title:** a continuation of a continuation keeps the one "(이어서)" (fork.ts), so two rows
  under one original can read the same, "보고서 초안 (이어서)". The newer one is on top and a rename tells them apart;
  no new mark for it (lean).
- **"목록에서 따로 두기":** the continuation leaves the tree for good and sits by its own activity; its in-chat line stays.
- **Filters** (Waiting, Last activity, Status): only rows the filter shows count; a filtered-out original hands its
  continuations up.

## Open decisions (one recommendation each)

1. **A new continuation of a chat in one of my sections: where does it start?** Today `fork.ts` does not add it to a
   section, so it lands outside and cannot nest. **Recommend: in the same section** (it then shows under its original,
   and the person can move it out as any chat). How: a section is a row of `nav_folder_items` (user, folder, chat),
   not a column of `chats`; in the fork's transaction, when the original is in one of *my* sections, add the
   continuation's row there (the same insert as nav-folders.ts adding a chat). A full section (`NAV_FOLDER_ITEMS_MAX`):
   the continuation starts outside; the fork never fails for it. Moving the original into a section later moves it
   alone (the rule of sections), so this applies only at creation.
2. **Trees under Group by: Project?** **Recommend: not now** (flat, the "(이어서)" title). Group by Project is chosen by
   hand and is capped at three rows per project; a tree there needs its own cap rules. Revisit if people use it.
3. **An original older than the loaded pages** (the history reads 50 chats a page, newest first: store/chats.ts
   `PAGE`). **Recommend: one batched read of the missing originals**, so the rule "under its original while the
   original is in my list" has no exception. How, and why it is safe:
   - an optional `ids` on `GET /api/chats` (at most 50, the history list only: not with q, projectId, folderId, trash,
     other, unread), added as `id IN (…)` to the history list's own rule (routes/chats.ts: `historyWhere` plus the
     per-row `visible()`). It answers only chats that a later page of the same list would bring anyway: never a deleted,
     hidden ("Hide from my list"), no-longer-mine chat, nor a shared chat I never wrote in. **Never `GET /api/chats/:id`
     per id**: that one answers a hidden chat and a shared chat that is not in my list, which would put them in the
     history.
   - The client sends, after each page, the `forkParents` of the rows on screen that are not loaded (all of them, up to
     8 per row, nearest first: when the nearest is hidden or deleted the next one is the tree's top), deduplicated, one
     call. `forkParents` already holds only my own chats plus the one shared chat a continuation came from, ids only, so
     nothing about a chat I cannot open is shown.
   - Cost: one indexed read per page, usually with no ids at all (no call then). The rows come into the store as
     a page's rows do; the at-rest list's "more" check (TrinaList `loadMoreShown`) must count only rows the paging brought,
     or it would take these for a new page.
   - Version impact becomes minor (a new optional query field; an older server refuses or ignores it, and the client goes on without it).
   Alternative: accept that such a continuation stands alone until "더 보기" brings its original (no server change).
4. **The original lifted into 오늘 although not used today.** This reverses the 11-26 choice (see option A).
   **Recommend: accept it** (the elbow explains it; it is the Claude look the owner asked for, minus #100216's burying).
   No "last used" time on the original's row.

## Steps (after the owner picks)

1. Decision file `docs/decisions/<date>-fork-in-history.md` superseding the date and order parts of 20261126-chat-fork-tree.md.
2. `lib/forkTree.ts`: nest across date groups; the tree's place and group = its first row in the list's order (its
   newest by the sort); continuations in the list's order. Today a tree sits at its original's index: that changes.
3. DateGroups: group a tree by its place's group. Project page: `forkRows` for the unpinned rows and the indent on
   `ProjectChatRow` (no divider between an original and its continuations).
4. index.css `.tree-row`: 28 px indent (`margin-inline-start`) and one "└" elbow (a pseudo-element, `--color-line`).
5. Open decision 1 (server `fork.ts` adds the `nav_folder_items` row) and 3 if chosen (`ids` on listChats, the
   client's one read after a page).
6. `changes/fork-in-history.md`.

## Risks

- Order change: people used to the 11-26 order see an old chat in 오늘. Small, and asked for.
- Task runs (scheduled) cannot be continued, so foldRuns is unaffected; checked in a test anyway.
- Six languages: no new strings unless open decision 3 adds a loading line (it should not).

## Tests

- `web/test/unit/fork-tree.test.ts`: cross-date nesting, the tree's place and group at its newest row, pins flat,
  sections, a missing original, title sort.
- Server (if decisions 1 and 3): a continuation lands in my section of the original, a full section leaves it outside;
  `ids` never answers a deleted, hidden, another person's or not-in-my-list chat (one test each).
- e2e `web/test/e2e/chat-fork-tree.spec.ts`: an original from yesterday continued today shows in 오늘 with the
  continuation indented under it; screenshots 1440 and 390, light and dark; the project page tree.
- `bun run typecheck`, `check:prepush`, `check:i18n`, `check:docs`, web unit, history e2e under Bun 1.3.12.

## Result

Built on `ui/fork-tree-visible` as the owner's decision says:

- `lib/forkTree.ts`: nesting across date groups; each row knows its tree's top row; DateGroups files a tree under its
  top row's date. HistorySections unchanged (a section is its own list).
- `index.css` `.tree-row`: 28 px (`margin-inline-start`), one "└" (`::before`, `--color-line-strong`), no divider before a
  continuation in a list with dividers.
- Project page: `forkRows` for the unpinned rows, `ProjectChatRow` takes `tree`.
- `GET /api/chats?ids=` (shared ListChatsQuery, routes/chats.ts: inside the history branch, `historyWhere` + `visible()`,
  pins not first, alone); store/chats.ts `readOriginals` after each page (`missingOriginals`: every parent of a row
  none of whose parents is loaded, at most 50; one left out is not asked again until a read from the start).
- fork.ts: a `nav_folder_items` row in my section of the original while it has room; `navFolders.changed` to my windows.
- Mock: `ids`, the section on fork, `POST /__test/chat-at`.
- Decision [20261127-fork-in-history](../../decisions/20261127-fork-in-history.md); `changes/fork-tree-visible.md`.
- Screenshots before and after, 1440 and 390, light and dark (history and a project's page): the e2e with `SHOT_DIR`.
