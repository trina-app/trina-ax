# A note line at the top of a Korean answer is dropped too; the write-access rule leaves nothing to narrate

- Date: 2026-11-18
- Status: accepted
- Supersedes: none (extends 20261116-answer-no-english-narration.md and 20261117-answer-work-notes.md)
- Branch: fix/narration-read-only-line (QA TC-4865, step 2)

A real Korean answer after a read-only refusal opened with "That folder is listed as read-only, but I should call the
tool and let the server decide." The narration hold let it through for two reasons:

- **The words.** The line matched no note shape, and "should" put it in the report list (content). The AI thinking
  aloud about its own tools is now a note (`META` in chat/narration.ts): a plan of its own ("I should / I need to /
  I'll / let me") to call, try or use the tool, or the exact access phrases "let the server decide" and "listed /
  marked as read-only". It is checked before the report list. "The server checks the token." or "I need to call the
  vendor." are not META (review of #1272). The position rules are unchanged: a line is dropped only before a call,
  never as the last piece, never when copied into the call or taken from the person's message.
- **The shape.** The line and the Korean answer came in one piece with no call between them, and a piece that shows the
  answer's script was let out whole. Once the answer's script follows a whole first line in Latin letters, that line
  alone is now dropped when it is a status opening ("Let me check …") or META. The wider work-note rules do not apply
  there, so a report above the answer ("No files found.", "Two rows were added.", "Read me first") stays, and so do
  titles, lines said to people, "Let me know …" and content.

The cause on the prompt side: `WRITE_ACCESS_RULE` said "call write or edit and let the server decide", and the model
paraphrased it as its plan. The rule now says "just call write, edit or the tool that saves it", and not to mention
the rule, the folder list or its thoughts about access before the call (explaining a refusal afterwards stays allowed).
