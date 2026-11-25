# Trina keeps a correction in the asker's own memory, also in a shared or project chat, from the asker's own words only

- Date: 2026-11-25
- Status: accepted
- Supersedes: for members, "No auto-save in shared chats" in [20261122-auto-memory.md](20261122-auto-memory.md), and
  "Shared chats lose personal tools (memories, …)" for memories in docs/DECISIONS.md "Shared project chats". Guests,
  rooms, side chats, scheduled runs, Slack, templates and confidential chats are unchanged.
- Branch: fix/auto-memory-corrections-shared (the owner, 2026-11-25; plan review APPROVE WITH CHANGES)
- Plan: [docs/AGENTS/plan/20261125-0105-auto-memory-corrections-shared.md](../AGENTS/plan/20261125-0105-auto-memory-corrections-shared.md)

- **Ask:** in a project chat five people share, Trina opened the wrong browser profile, the owner corrected it, Trina
  said "next time I will check the profile list first" and kept nothing; then it said it could not save here because
  five people see the chat, and told the owner to continue in a private chat and paste a sentence. The owner: "1.
  Shouldn't this be automatic when it made a mistake or learned something? 2. Why can't it save?"
- **Rule:**
  - In a shared or project chat, auto memory works for a member as in their own chat (same switch, caps, secret
    refusal, copy and address checks, visible step, no card): what the asker said there, or the lesson from the
    asker's own correction, is kept in the **asker's own memory** (Settings › Memory, their private chats).
  - **Whose words count:** only messages the asker wrote (author = asker; quote lines left out). Every other person's
    message in the chat, every answer to another person's turn and the asker's quoted lines are read as tool output
    is: a copy of them (6-word runs) or an address, number, path or channel only they showed is skipped; a contact
    must be in the asker's own words. Read from the database on every save (a restart or a new session never empties
    it).
  - **What the chat sees:** a memory is marked with the shared chat it was written in (`memories.shared_chat_id`,
    migration 452). That chat's turns of the same person get only those memories (their words are in its transcript
    already), never the person's private ones; a guest's turn gets none. One guard in the prompt builder
    (prompt.ts promptMemories) drops any other memory a caller passes. `replaces`, the near-duplicate merge, the
    "already kept" answer and `forget` see only that chat's memories, so no step shows private words; an exact copy of
    a private memory answers "already kept" without its id. A change in Settings or in a private chat sets the mark
    back to none.
  - **Undo** on a memory step and the first-memory line show only on the asker's own answers (the web; another
    person's undo of a forgotten memory would have added it to their own memories).
  - The shared chat's instructions no longer list memories as not available, and say: never tell the asker to go to a
    chat only they see to keep something.
  - **Corrections:** the rule and the per-turn reminder of a resumed session name corrections of what the AI did or
    chose (account, profile, file, folder, place, format, wording, person) and lessons after a wrong try. Before, only
    the first turn's rule named them, and corrections usually come later in a chat.
  - **No promise without a memory:** every turn's rules say: never say you will remember or do it differently next
    time unless remember answered kept: true in this answer; where remember is not offered, that this chat cannot
    keep it.
- **Why:** Claude Code keeps feedback on its own wherever the person works (the owner: Claude Code is the floor). The
  old block protected two things: private memories reaching a chat others read, and other people's words planting a
  memory. The mark and the prompt guard keep the first; author-only own words and others' words as outside content
  keep the second, without refusing the asker.
- **Known gaps:** another member's claim the model paraphrases passes the copy check (as for tool output); the address
  and contact checks, caps, the visible step with undo and the block's facts-not-instructions framing are the rest of
  the defence (measured in the memory eval, I2). A quote on the branch or a room read still turns auto memory off for
  that chat (a save then asks on a card, as in a private chat). When the turn that kept a chat memory is deleted, the
  memory keeps its mark.
- **Left out:** a project-wide memory shared by all its people (none exists; project instructions stay with the
  project's editors); guests' memories in shared chats.
- **Tests:** tests/unit/auto-memory-shared.test.ts, b-shared-chats.test.ts; the memory eval's held-out correction
  cases H1-H8 in a private and the shared project chat, I1/I2 (another member), P1 (a private memory in the shared chat).
- **Version impact:** minor (auto memory in shared and project chats is new behaviour people see).
