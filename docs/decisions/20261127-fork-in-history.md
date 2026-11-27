# A continued chat sits right under its original in my history, wherever the original is, as in the Claude app

- Date: 2026-11-27
- Status: accepted
- Supersedes: the "same date group" rule, the project page's place in "Left out", and the section rule of
  [Chat fork tree](20261126-chat-fork-tree.md) (its order rule, "nothing moves an older chat up", stays)
- Branch: ui/fork-tree-visible (the owner, 2026-11-27; plan
  [20261127-0858-fork-in-history](../AGENTS/plan/20261127-0858-fork-in-history.md))

- **Ask:** the owner looked at the history: "어디서 fork가 된건지 안보이네..? 들여쓰기가 안되어서? 이거 클로드랑 같이 UX를
  안가져갔구나?", then, after the plan's options, "클로드랑 동일하게 해". A continuation sat under its original only in
  the same date group, so the usual case (an original from yesterday or earlier, continued today) showed no indent at
  all, and the 20 px indent had nothing else to show it.
- **Reference (checked 2026-11-27, sources in the plan):** the Claude desktop app's Code tab lists a session started
  from another "under the original session in the sidebar" (Anthropic's changelog and Desktop docs); user reports show
  forks nested under their parent too ("<title> (fork)", "Detach to top level"), and one complains that a fork in use
  stays under an old parent (anthropics/claude-code#100216): the tree keeps the parent's place. ChatGPT's "Branch in
  new chat" lists branches flat.
- **Rule:**
  - **Under its original, at the original's place.** A continuation sits right under the nearest chat it came from that
    is a row of the same list, whatever date group it would be in on its own; the tree sits where the original sits by
    the list's sort, in the original's date group. Nothing moves an older chat up (as before). Its continuations follow
    in the list's own order (newest first by default). One level; nothing folds.
  - **The look:** 28 px in, and one small "└" (1 px, the strong line colour, light and dark) in front of each
    continuation. No badge, count, arrow or extra line. A list with dividers (a project's page) has none between a chat
    and its continuations.
  - **Where:** the history by date and in one list (the Trina panel, the filtered list, the phone's 트리나 tab and ☰
    drawer), inside one of my sections, and a project's chat list (pinned rows first and flat). Flat on purpose: Pinned (a
    pin is one chat: a pinned original's continuations stand alone in the history), Group by: Project (its caps count
    rows), search (ranked by match), the trash. The title's "(이어서)" says what such a row is.
  - **An original older than the pages read:** the client reads the originals of continuations on screen that no page
    has brought, in one call, `GET /api/chats?ids=` (at most 50, alone): the history's own rule (`historyWhere` and the
    per-row `visible()`), so never a chat in the trash, one I hid, another person's private chat or one no longer shared
    with me; such a continuation stands alone. One the server left out is not asked again until the list is read from
    its start.
  - **Sections:** a continuation of a chat in one of my sections starts in that section, while it has room; a full
    section leaves it outside, and the continuation is still made.
  - Unchanged: deleted, hidden, filtered-out or not-mine originals hand their continuations up; "목록에서 따로 두기"; the
    words ("새 채팅에서 이어 하기", never "포크"; "<제목> (이어서)").
- **Why:** the owner asked for the Claude app's look; a continuation is findable under the chat it came from, and old
  chats never jump to the top.
- **Left out:** trees under Group by: Project; a "이어 한 채팅" line inside the original; moving a chat under another.
- **Tests:** web/test/unit/fork-tree.test.ts, web/test/unit/fork-originals-store.test.ts,
  tests/unit/b-fork-in-history.test.ts, web/test/e2e/chat-fork-tree.spec.ts (a continuation used today under its
  original of 3 days ago; a project's page; 1440 and 390, light and dark, axe).
- **Version impact:** minor (a new optional query field, `ids` on GET /api/chats; an older server refuses it and the
  rows stand alone as before).
