# The thread panel has no "Send to Trina" row

- Date: 2026-11-18
- Status: accepted
- Supersedes: the "Send to Trina fills the box, it never sends" line of [Chat answer threads](20261116-chat-answer-threads.md)
- Branch: chore/thread-no-send-to-trina (the owner, QA TC-4866)

- **Ask:** under the reply box of a thread under an AI answer, remove the row "Send to Trina - You can edit it before
  sending". Keep the box and the one-line note that only the people who see the chat read replies.
- **Rule:** the thread panel has the reply box, the wait line and the note only. The AI reads a thread's comments through
  its `answer_comments` tool when someone in the chat asks about them (see
  [20261117-ai-reads-answer-comments.md](20261117-ai-reads-answer-comments.md)); a turn without that tool tells the asker
  to quote the comment. Anyone can still paste a "> " quote into the chat's box: the turn's gates keep reading quote
  lines as other people's words (`isQuoteLine`, `ownWords`).
- **Removed:** the button and its draft (`chatThreadDraft`, `CHAT_THREAD_DRAFT_MAX`), the chat page's `onSendToTrina`
  wiring, the i18n keys `chat.thread.sendToAi`, `editBefore`, `draftHead`, `draftCut` (all six languages), the AI's app
  map and prompt mentions of the button, and their tests. The phone app has no such row.
- **Kept:** `Composer.prepareDraft` (other callers), the quote gates, the `answer_comments` tool.
