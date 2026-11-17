# The AI's facts after the 2026-11-17 evening catalog run

- Date: 2026-11-17
- Status: accepted
- Supersedes: the "Suggest as skill" next step of a read-only team skill (`policy/refusal.ts` teamSkillNext,
  readOnlySkillLine, added in b4eeacdd0); the app map's "Guest AI: not on this team's app" line
  ([20261116-ai-app-map.md](20261116-ai-app-map.md)); the answer-language line "Answer in <app language> unless the
  user writes in another language or asks otherwise"
- Branch: fix/catalog-1117g

- **Ask:** cases that failed twice in the full catalog run on dev bad5009a3 (SKL-01.member, SKL-02.approval, CHT-14,
  CHT-15, ADM-03, SKL-03.project, ORG-01.no-write, PDF-09, CON-01.calendar). Fix at the source: the facts the AI is
  given, or the case when it expected the wrong thing.
- **A team skill a member cannot change (SKL-01.member, SKL-02.approval; regression of b4eeacdd0, #1197):** the AI
  was told to offer the "Suggest as skill" button for the change. That button turns an answer or a file into a new
  skill suggestion; registering one never changes an existing skill (`skills/suggestions.ts approveSuggestion` refuses
  a file of that name), so the claim was false. The next step now: tell the people who manage team skills what to
  change (the AI offers to write the message), or a personal copy; the text names the button only to rule it out.
- **Threads under an answer (CHT-14, CHT-15; regression of #1217 ai-reads-answer-comments, cases not updated):** the
  shared chat's map line said "Reply in thread, then Send to Trina", read as the only way. It now says the AI reads
  the thread when asked and that Send to only fills the person's message box, unsent (the own-chat form too).
  answer_comments with nothing to read says nobody has replied and that none are waiting (the AI had said they "may
  show up later"). CHT-14 and CHT-15 expected the rule #1217 replaced; both now follow it.
- **Guest AI (ADM-03):** "Guest AI: not on this team's app" (d293dfd2b) made the AI say Admin has no such setting;
  it passed until the judge stopped taking the AI's named places as given (905bf88e4, test/ai-scenarios 4c397c45c). The choice is on screen on every install (web `GuestAiChoices`, at invite and on the guest's row
  under Guests); where the AI runs on the computer's own sign-in only No AI can be picked. The map says that, and the
  size test now measures both install kinds (longest form about 1,248 tokens, cap 1,250 unchanged).
- **Answer language (SKL-03.project):** Daniel's app is in English; his Korean request in a shared project chat got an
  English answer. The line now puts the message's language first and the app language only for a message with none
  (`prompt.ts answerLanguageLine`).
- **Built-in Google apps (CON-01.calendar):** the AI searched the web for Google's preview MCP address, filled in an
  unknown service at calendarmcp.googleapis.com (it cannot sign in without the team's own Google app) and cited
  "Calendar MCP server" pages. connect_service now answers for Gmail, Google Calendar, Docs and Sheets by name (English
  or Korean) or by a Google API address, with the app's real state from `GoogleApps.view` (its page in Settings ›
  Connectors, set up first by an admin, not available on this install, Reconnect, already connected), no card, and
  "ask nothing about the task until it is connected" (`chat/connect-google-app.ts`). The tool text, its `url` field and
  the connect rule say to give these only by name. The connected-services lines no longer say "MCP server".
- **The cases were wrong (test/ai-scenarios):** ORG-01.no-write and PDF-09 ran as people who cannot open the marketing
  folder (group folders are open only to their group since folder access adds up), so a hidden folder looks like no
  folder, by design. ORG-01.no-write now expects "can't find among the files she can open; who can help", PDF-09 runs
  as 최하나 (마케팅, in the project) with an `outsider` variant for Daniel.
- **Tests:** `tests/unit/connect-google-app.test.ts`, `connect-service.test.ts` (the Google app calls),
  `ai-wording-jargon.test.ts`, `ai-app-map.test.ts`, `a-answer-comments-access.test.ts`, the language line in
  `b-chat`, `b-subagents`, `b-review`.
- **Version impact:** patch (the AI's answers; no screen, API or migration).
