# A note line at the top of a Korean answer is dropped too; the write-access rule leaves nothing to narrate

- Date: 2026-11-18
- Status: accepted
- Supersedes: none (extends 20261116-answer-no-english-narration.md and 20261117-answer-work-notes.md)
- Branch: fix/narration-read-only-line (QA TC-4865, step 2)

A real Korean answer after a read-only refusal opened with "That folder is listed as read-only, but I should call the
tool and let the server decide." The narration hold let it through for two reasons:

- **The words.** The line matched no note shape, and "should" put it in the report list (content). The AI's thoughts
  about its own tools and access are now a note (`META` in chat/narration.ts): calling the tool, the server deciding or
  checking, what the folder list marks as read-only, "I should / must / need to call / try / attempt". This is checked
  before the report list. The same position rules apply as before: dropped only before a call, never the last piece,
  never a piece copied into the call or taken from the person's message.
- **The shape.** The line and the Korean answer came in one piece with no call between them, and a piece that shows the
  answer's script was let out whole. Once the answer's script follows a whole first line in Latin letters, that line
  alone is now judged like a line before a call, and dropped when it is a status line or a work note. Titles, lines said
  to people, "Let me know …" and content (numbers with units, quotes, links) stay.

The cause on the prompt side: `WRITE_ACCESS_RULE` said "call write or edit and let the server decide", and the model
paraphrased it as its plan. The rule now says "just call write, edit or the tool that saves it", and not to mention
the rule, the folder list or its thoughts about access in the answer.
