# English work notes before a tool call stay out of Korean, Japanese and Chinese answers

- Date: 2026-11-17
- Status: accepted
- Supersedes: none (extends 20261116-answer-no-english-narration)
- Branch: fix/ai-wording-narration

Plan: docs/AGENTS/plan/20261117-0549-ai-wording-narration.md.

- **Ask:** after #1066, Korean answers still started with short English notes the model writes to itself before a
  tool call: "Find the price list first.", "Need to find the CSV/scan.", "Only one thread; read it." (QA TC-3702,
  TC-3711, TC-4291, TC-3821). #1066 drops a piece only when it opens like a status line ("Let me check …"); these open
  in no fixed way. A prompt change measured on 11-17 did not help (13–14 of 207 answers still leaked).
- **Rule:** position first, as in #1066. Only a piece the main AI writes right before one of its own tool calls can be
  dropped; the last piece (the answer after the last call) is never touched; only in a ko/ja/zh answer with no request
  for another language; only short ASCII pieces with no Markdown, link, quote mark, "?" or "!", or number with a unit.
  Such a piece is now also dropped when it is a **work note**:
  - it gives itself an order at the start of a sentence ("Need to find …", "Search files.", "Use edit_pdf instead."),
    states a plan of its own ("I'll read them in parallel.", "Let me also check …"), talks about "the user", or, in
    at most 100 characters, names the work (a file, folder, thread, room, message, page, skill, copy, scan, CSV/PDF,
    path, row, seal, version …, a `tool_name`, a `folder/path`);
  - and it does **not** speak to people (you, your, we, our, hi, hello, dear, please, thanks …, "team," as an address),
    report to the person ("I can't …", "I didn't …", "I used …", "I've …", "… says / shows …", "Also, …", "According
    to …", "One note: …", or a line that ends with ":"), and is not a title ("Q3 Sales Report");
  - and it is **not copied**: a piece found in that call's arguments (a message it posts, a file it writes) or in the
    person's message is content shown before it is used, and is kept.
- **Also:** "page 2 first", "2 is", "row 4" no longer count as a number with a unit (that kept "Let me check page 2
  first.").
- **Pinned:** `tests/unit/narration-hold.test.ts` keeps the 55 content probe lines of #1066's two reviews (the first
  broad rule had dropped 36 of 52 of them), adds the 11-17 leaked lines (dropped before a call, kept when the same line
  is the last piece), content that names work things but speaks to people or is a title (kept), the copied-into-the-
  call and taken-from-the-message cases (kept), and a real turn through the fake engine (stream equals saved answer).
- **Measured offline:** of 264 English paragraphs found in earlier scenario answers that contain Korean (most are whole
  English answers to English chats, where the hold is off), the #1066 rule drops 15 when placed before a call, this rule
  105; the extra ones are notes, plus a handful of short reports about a file ("Page 2 of the scan is blank, and page 4
  was scanned sideways."). In a Korean answer such a report is written in Korean, so the risk is small.
- **Not done:** notes with measurements ("191mm + 15mm margin …"), notes in another Latin language ("Ich lese die 9
  Dateien …"), notes in the answer's own language, and showing dropped notes in the steps area. The log still gives only
  the number of dropped pieces, never their text.
- 0 prompt tokens: the stream and the saved answer stay the same (a held piece is never sent until decided).
- Version impact: patch (no API, no migration).
