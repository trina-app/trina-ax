# The Move dialog says a chat stays "Only me" and offers "Move and share"; thread replies stay outside the AI

- Date: 2026-11-17
- Status: accepted
- Supersedes: none (keeps TC-1075 "Moving into a project never shares" in docs/DECISIONS.md)
- Branch: fix/qa-man-003 (QA hands-on AI row MAN-003)

- **What happened (a):** pras moved a private chat into the shared project QA-Quotes (3 people). The chat stayed "Only
  me", so qa-b could not see it until pras found Share and confirmed. The only cue was an 8-second toast after the
  move, and QA missed it.
- **Rule (a):** a move still never shares (TC-1075, the owner). When the picked project is a team project the chat
  would arrive in privately (`mayShareChat`), the dialog says so under the list: "The chat stays “Only me” after the
  move. The project's people see it only after you share it." Its footer gets **Move and share** (main button) next to
  Save. Move and share moves the chat and then opens the share flow with `ask` (`openShareChat`): the confirm that
  sharing can't be undone, its focus on Cancel (TC-1073), and the specific warnings. Nothing is shared without that
  confirm. A personal project, "No project", a chat already shared, a side chat and safe mode show neither.
- **What happened (b):** "Change the laptop price to what qa-b said in the thread": the AI could not read qa-b's reply
  under its answer. It said so and pointed to "Send to Trina".
- **Rule (b), unchanged:** docs/decisions/20261116-chat-answer-threads.md (accepted, the owner) says the AI must never
  see what people say among themselves in a thread unless one of them sends it, as their own visible message. The
  current answer already explains the limit and the way to send it. No read path is added. The sheet's expected result
  for MAN-003 (b) should be "the AI says it cannot read the thread and points to Send to Trina".
- **Tests:** `web/test/unit/move-to-project-share.test.tsx` (the line and the button for a team project, none for a
  personal project or a shared chat, Move and share moves first and then the confirm asks).
- **Version impact:** patch (words and one button; no API or data change).
