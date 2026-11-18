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
  Such a piece is now also dropped when it is a **work note**, and only before a real call of the main AI whose
  arguments were checked (not on a thinking block, a stop or an error: there only #1066's status openings drop):
  - it gives itself an order: "Need to" with a working verb at a sentence start ("Need to find the CSV."; not "Need to
    sign the contract"), a verb rarely said to people ("Find the CSV first.", "Search files.", "Load it.", not "Find
    attached …", "Search is case sensitive", "Load the paper tray"), or read / use / save / check / try / open in a note's
    shape (after an earlier sentence: "Only one thread; read it."; ending on first / instead / both / it / again:
    "Use edit_pdf instead."); or it states a plan of its own with a working verb ("I'll read them in parallel.", "Let me
    also check …", "I'll stamp it on the PDF."; not "I'll send the invoice tomorrow."); or talks about "the user" with
    what they want ("the user asked …", "for this user"); or, in at most 100 characters and in a note's shape (a ";"
    joining fragments, or a telegraphic opening: Only / No / Now / Matches / Following / Existing / Leaving / Checking /
    Trying / a count), names the work with an app word (file, folder, subfolder, thread, room, message, mail, page,
    skill, copy, scan, CSV/PDF/DOCX…, path, link, row, column, seal, chart, `tool_name`, `users/…` paths; not common
    office words such as project, server, version, draft, photo);
  - and it does **not** speak to people (you, your, my, we, our, hi, hello, dear, please, thanks, kindly, folks, FYI,
    heads up, Mr./Ms./Dr., a name as an address: "Sora, …", "…, Sora."; "team," as an address), open with an order said
    to people with no note shape ("Read the attached file before the meeting.", "Sign both copies."), report to the
    person or warn ("I can't …", "I didn't …", "I used …", "I've …", "… says / shows …", "Also, …", "According to …",
    "Error: …", do not / never / must / should, not found / expired / skipped / kept / ready / due / attached …, or a
    line that ends with ":"), and is not a title ("Q3 Sales Report");
  - and it is **not copied**: a piece found in that call's arguments (a message it posts, a file it writes) or in the
    person's message is content shown before it is used, and is kept. The comparison uses letters and digits only, so
    Markdown, HTML tags and entities, emoji and punctuation added in the call do not hide the copy, and a piece whose
    words (3 letters or more) are 80% in the arguments counts as copied (a small edit before posting).
  - A piece still goes out at its third sentence mark while streaming, as in #1066 (2 sentences at most): a note of
    three sentences is kept.
- **Also:** "page 2 first", "2 is", "row 4" no longer count as a number with a unit (that kept "Let me check page 2
  first.").
- **Pinned:** `tests/unit/narration-hold.test.ts` keeps the 55 content probe lines of #1066's two reviews (the first
  broad rule had dropped 36 of 52 of them) and the two independent reviews' probes of 63 more content lines (orders,
  plans, warnings and notices said to people, names as an address, short file reports, office words, sentence-case
  titles, small changes in a posted copy), adds the 11-17 leaked lines (dropped before a call, kept when the same line
  is the last piece), content that names work things but speaks to people or is a title (kept), the copied-into-the-
  call and taken-from-the-message cases (kept), and a real turn through the fake engine (stream equals saved answer).
- **Measured offline:** of 264 English paragraphs found in earlier scenario answers that contain Korean (most are whole
  English answers to English chats, where the hold is off), the #1066 rule drops 15 when placed before a call, this rule
  91; the extra ones are notes, plus a handful of short reports about a file ("Page 2 of the scan is blank, and page 4
  was scanned sideways."). In a Korean answer such a report is written in Korean, so the risk is small.
- **Kept on purpose (gaps):** notes of three sentences, descriptions with no note shape ("The Saturday delivery
  discussion is in this thread.", "Row 4 (header row 1), column 3."), "Try team-root path.", "Good layout. Now
  overwrite the original PDF." (pinned in the test's known gaps).
- **Not done:** a draft shown before a round of several calls is compared only with the first call's arguments (a
  draft rarely has a note's shape, so it is kept by the rules above); notes with measurements ("191mm + 15mm margin …"), notes in another Latin language ("Ich lese die 9
  Dateien …"), notes in the answer's own language, and showing dropped notes in the steps area. The log still gives only
  the number of dropped pieces, never their text.
- **Measured with the real AI** (82 Korean cases × 3 runs, plus FL-19/FL-25): answers with an English work note went
  from 9 / 9 / 9 (dev) to 0 / 0 / 1; FL-19 from 1 / 1 / 1 to 0 / 0; 34 pieces dropped, all notes, 0 real content lost.
- 0 prompt tokens: the stream and the saved answer stay the same (a held piece is never sent until decided).
- Version impact: patch (no API, no migration).
- **2026-11-18 (EDIT-17.project, [20261117-ai-answer-slips.md](20261117-ai-answer-slips.md)):** a quoted phrase (at
  most 40 characters) taken from the person's message counts as a name, so '"공용 회의록" — likely in shared. Find it.'
  is ASCII once it is out; and an order to itself where to put something ("Add under section 1.", "Append it at the end
  of the notes.": add / append / insert / put / place, optionally it / this / the line / one line …, then under /
  below / beneath / after / before / above / into / at the end, top, bottom or start of; at most 100 characters) is a
  work note. An apostrophe after a letter ("I'll", "Sora's") opens no quote. Taking the person's quoted words out also
  takes out the quote marks that would mark content: 'Add "Done" under section 1.' before a call is now dropped (only
  before a call, never the last piece, never when copied into the call). The same day's runs leaked "Seal lands on (인)
  correctly. Now post to the room." (CHT-02.room): a bracket of at most 12 characters holding another script and no
  Latin letter or sentence mark (a form's own label such as "(인)") now counts as a name, and "Now post / send / save /
  stamp / write / …" after a sentence is a note's shape next to a work word (so "Good layout. Now overwrite the original
  PDF." is no longer a known gap). Korean outside the bracket, and a bracket with a digit or a currency sign ("(339,400원)", "(₩5)"), keep the piece; a
  bracket of several words is found while streaming too. "Please add …", a name as an address and a quote that is not the
  person's words keep the line.
