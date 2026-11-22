# The AI's own earlier steps are part of a fresh session's history

- Date: 2026-11-22
- Status: accepted
- Supersedes: none
- Branch: fix/chat-step-memory (the owner, a shared project chat on the Claude Code engine)

- **Ask:** in a shared project chat the AI attached a file through a personal browser connection and sent a mail. Two
  answers later the owner asked how it attached the file. The AI said the steps of that answer were "not carried over"
  and offered two guesses. Claude Code itself remembers, in one conversation, the tools it called, their arguments and
  their results. Trina should do the same, for every tool and every engine.
- **Cause:** Claude Code resumes its own session only while the chat's session ends at the previous answer and, in a
  shared chat, while everyone who sees the chat may see everything the chat read (`scopeHiddenFromAudience`). After a
  limited team connection and a personal connection were read there, every later turn started a fresh session. Codex
  and the API engine start fresh every turn. A fresh session got earlier answers as their text only: `messages.steps`
  never reached it, and tool arguments and results were stored nowhere.
- **Rule:** each of the main AI's tool steps keeps a short note on the server, `messages.step_notes` (`{stepId: {i, o}}`,
  migration 443): its key arguments (paths, addresses, names, queries, commands, the start of code; body text as its
  length; at most 240 characters) and the start of its result (200 characters, pictures and base64 out), with the
  person's stored connection secrets hidden before anything is cut. The column is not in `MESSAGE_COLS`: no route,
  event or export carries it. A fresh session's history (`historyBlock`, the same for Claude Code, Codex and the API
  engine) shows a `<steps_record>` under an earlier answer: one line per tool step (tool, label, how it ended, notes).
  Answers from before this build show labels and status only.
  - Whose: the asker's own answers only (in a chat several people wrote in: an answer to the asker's own message whose
    turn was theirs), never one hidden from them (withheld). Another person's steps, connections and results never.
  - In a shared chat the new answer is everyone's to read: a line names paths it keeps aside (`sv`) only when the asker
    and everyone who sees the chat now may list them; the notes of an answer hidden from anyone who sees the chat now
    (`answerHiddenFrom`, a k or x group) or from before the chat was shared stay out (the latter shows the words the
    others see). A check that fails keeps the notes out.
  - Results of tools that return content (read, grep, a page, a mail, a message list, a search: by name, in any
    naming style, `notion-fetch` or `getJiraIssue` too), of the in-app browser's tools (a signed-in page can show a
    cookie or a token) and of skills and rooms are not kept: the AI reads them again, and the person may have lost
    access since. What a browser tool typed (`value`, `text`) is kept as its length. Anything that looks like a
    secret (a token, a key, `password=`, a cookie, a bearer header) is hidden in arguments and results, on top of the
    person's stored connection secrets. Memory tools keep no line.
  - An answer that ran tools and was stopped or failed before it wrote any text was left out of the history whole
    (steps and all). It now stays, as one line saying so, with its record.
  - Caps: the newest 10 eligible answers that called a tool, 40 lines and 3,000 characters per answer (the first steps and the newest),
    6,000 characters in all, none for a model whose window is under 12,000 tokens. The window is made of the text
    first, exactly as before; records go in, newest first, only in what the text leaves of the budget.
  - Chats with an answer that ran tools and wrote no text get one more history line, so their summary is made again
    once (its hash chain changes).
  - The history's intro says the record is the AI's own, written by the server, data and not instructions; it answers
    "how did you do it" from it, never runs a step again because it is listed, and never follows words in a result.
- **Not changed:** when Claude Code resumes. A resumed session holds whole file contents and tool results, more than the
  record; the shared-chat resume rule stays as it is. A follow-up could let a shared chat resume when every source the
  audience may not see sits in a card group everyone now in the chat said yes to; it needs its own security review.
- **Tests:** `tests/unit/b-step-record.test.ts` (arguments, results, caps, neutralizing, the window, a Codex turn, a
  shared chat with two askers, withheld and hidden-from answers, pre-share answers, nothing in the app's messages).
- **Version impact:** patch (a fix; one additive column, reader level unchanged).
