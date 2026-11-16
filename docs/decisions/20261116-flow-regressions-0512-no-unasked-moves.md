# The AI moves only the files it was asked about; a file made from another stays next to it

- Date: 2026-11-16
- Status: accepted
- Supersedes: none (narrows the server's loose-file note of "The in-app AI keeps the team's folders tidy",
  [DECISIONS.md](../DECISIONS.md))
- Branch: fix/flow-regressions-0512 (AI flow run on dev 30a54f4e2, FL-15)

- **Ask:** "그 PPT PDF로도 저장해줘": the AI saved the PDF next to the deck in groups/마케팅/, got the server's note that the
  PDF lay loose at the top of a group's folder, made a new folder "소개자료" nobody asked for, and moved both the PDF and
  the deck into it. People who had the deck's link or knew where it was lost it.
- **Rule:**
  - no loose-file note for a new file saved in the same folder as a file it was made from (make_file's `source`, or any
    team file whose bytes are in it: the file event's `from`/`files`);
  - the note says to move only the new file it names, never the file it was made from or other files there, unless the
    user asked;
  - the rule on where files go says a file made from another one goes next to it unless the user names another place,
    and that the AI never moves, renames or regroups files the user did not ask about.
- **Tests:** tests/unit/b-chat-file-placement.test.ts ("a file made from a file in the same folder gets none", "the rule").
- **Version impact:** patch.
