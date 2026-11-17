# The AI's app map names five more places, and its size cap moves from 900 to 1,150

- Date: 2026-11-17
- Status: accepted
- Supersedes: the 900-token cap in [The AI gets a short map of the app's screens](20261116-ai-app-map.md) ("Extended
  2026-11-17")
- Branch: fix/ai-wording-app-map (real-AI scenario catalog rerun, 2026-11-17)

Plan: [docs/AGENTS/plan/20261117-0702-ai-wording-app-map.md](../AGENTS/plan/20261117-0702-ai-wording-app-map.md).

- **Ask:** in 12 catalog cases (ACC-04/05/06, CHT-13/14/16, SHR-03, FSH-03, MTG-01/02) the AI answered "I'm not sure,
  the guide doesn't mention it": the map had no line for five shipped features.
- **Rule:** the map (server/src/chat/app-map.ts) names them with the app's labels in the person's language (generated
  from web/src/i18n into app-map-labels.ts), for every form (owner or admin, member, shared chat):
  - **Files › Shared with me:** the files and folders shared with the person, newest first
    ([files-shared-with-me](20261116-files-shared-with-me.md)).
  - **Folder sharing:** in My files, a folder's ⋯ › Share: view only, later files too; take people off or Stop sharing
    at any time, Undo right after; team folders are shared by owners and admins
    ([folder-share-server](20261116-folder-share-server.md); the gate FOLDER_SHARES_OPEN is open, and the test fails
    if it closes). "Undo right after", not "for 10 minutes": the server keeps an undo 10 minutes, but in Files it is
    a toast of at most 15 seconds; only the AI's own card keeps the button longer.
  - **Threads under an answer:** a finished answer of a shared chat (a project's or one shared with people) has Reply in
    thread; the AI does not read it; Send to <AI> there puts it in the message box to edit and send; the asker and the
    repliers are told; not in a private chat ([chat-answer-threads](20261116-chat-answer-threads.md)). `{name}` in a
    label is now filled with the AI's name.
  - **Open the app:** in a Mac or Windows browser, My files' Open the app opens the desktop app signed in, no password;
    if it does not open, Download the app and press again; not from a phone (lib/open-app.ts).
  - **Meeting notes:** shipped on this base (Meeting notes 1/4–4/4 merged, no flag): My files › Take meeting notes in
    the Mac desktop app when the team has voice input; no bot joins, it asks first, Stop on its card, the sound is not
    kept, the notes go to My files › Meetings; the AI cannot listen or start it
    ([live-meeting-notes](20261116-live-meeting-notes.md)).
- **Size:** measured the size test's way (Hangul 1.45 tokens a syllable, other text 3.6 characters a token), managed
  install, no dev environment:

  | form | before | after |
  |---|---|---|
  | shared chat, Korean (the longest) | 893 | 1,148 |
  | owner or admin, Korean | 886 | 1,141 |
  | member, Korean | 639 | 894 |
  | shared chat, English | 668 | 872 |

  The five places alone measured about 300 tokens in Korean. The rest of the map was cut first (a shorter opening line,
  "Google Forms or" and "their own … accounts" dropped, the photo menu, projects and skills merged into the lines
  beside them, the find-work-files line merged into the My files line), about 45 tokens, and lines stay at most 20 (19
  for an owner or admin). A third of the map could not be cut further without dropping places people asked about in
  earlier catalog runs. So the cap moves to **1,150**: about 255 more tokens in every fresh session's instructions for a
  Korean owner or admin, about 205 in English.
- **Not split out:** the map is part of a fresh session's instructions, built once per session (turn.ts), so a line
  "only when relevant" would hang on the session's first message, and the catalog's questions came from personal and
  project chats alike. A help tool (`where_is`) stays rejected for the reasons in the first decision.
- **Version impact:** patch (the AI's answers change; no screen, API or data change).
