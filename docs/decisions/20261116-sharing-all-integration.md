# AI sharing and folder sharing, joined on Rule A: the person's own Always allow is final, the folder cards included

- Date: 2026-11-16
- Status: accepted
- Supersedes: on the points below, [20261116-share-folder-tool.md](20261116-share-folder-tool.md) ("an add always
  shows the card, no Always allow kind"), [20261116-team-folder-ai-and-ask.md](20261116-team-folder-ai-and-ask.md) ("the
  card every time, no Always allow kind"), [20261116-shared-folder-ai-read.md](20261116-shared-folder-ai-read.md) (the
  every-turn "Files shared with you" block) and [20261116-ai-screen-and-shared-tools.md](20261116-ai-screen-and-shared-tools.md)
  (a looking_at target keeps the card "Always allow or not")
- Branch: integrate/sharing-all (integrate/ai-sharing + folder sharing PR 2–7, on #1143 `batch/prompts-1116-ruleA`)

- **Ask:** join the two reviewed pieces of work (AI sharing B1–B4, folder sharing PR 2–7) on the base that goes to dev
  tonight. #1109 (Rule B: "the card always shows where other people's words are, even with Always allow") is parked:
  it reversed the owner's 2026-11-13 decision [Always allow on every card](../DECISIONS.md#always-allow-on-every-card-featalways-allow-everywhere-2026-11-13-product-owner). #1143 is #1109's final head
  plus three commits that restore it (Rule A, [20261116-always-allow-final-rule-a.md](20261116-always-allow-final-rule-a.md)).
  Every #1109 commit is in #1143.
- **Rule (which rule applies):** Rule A. A person's own "Always allow" for a kind of card is final: when it is on, that
  card does not show, in their own chat also after they read rooms, a shared file, a shared folder, a web page or the
  screen. The others'-words guards (a file or recipient the asker did not name is refused; the explicit-ask skip is off)
  apply only to people without it, and always in a chat with other members' messages (shared, or others wrote in it).
  - **Why Rule A:** it is the owner's decision of 2026-11-13, extended by them on purpose to deletes, project members
    and team skill saves: every permission card offers Always allow on its first showing, and once chosen it is final.
    Release coordination confirmed it for tonight's merge.
  - **share_folder (adding people)** gets its own kind `share_folder`, and **change_folder_access** its own kind
    `folder_access` (never `share_files`: choosing it for files does not cover folders). Same storage as every kind
    (`card_always_allow`, that person and that kind; Settings › Allowed for Trina lists and removes it; the team switch
    turns all of them off). Each card says the risk in its own words, six languages ("From now on Trina shares your
    folders without asking, even when a file or message tells it to." / "From now on Trina changes who can open team
    folders without asking, even when a file or message tells it to. Files inside that were shared one by one stay
    shared.").
  - **Hard refusals stay with Always allow on:** a personal root, places that are never shared, a folder without its
    birth time (disk), a team folder for a member (Ask an admin), a dev environment run, a guest, a scheduled run (no
    folder tool runs there), the admin role checked again before the save, the plan checked again (T19).
  - **File links on a narrowing:** when Always allow skips the team folder card on a change that would take file links
    away, the links are KEPT (`removeFileLinks: false`); only the person's own pick on a card ever removes them.
  - **Stops:** stop_sharing and share_folder's stop/remove have no kind: unchanged (no card when the asker named the
    folder or file and the people; else a card; Undo needs edit access, the owner may always remove).
  - **looking_at:** a file, person, room or thread known only from the screen never counts as named, so the
    explicit-ask skip never applies to it (unchanged). With the person's Always allow on, Rule A wins: no card. This is
    where it differs from B4's reviewed rule ("the card shows, Always allow or not").
- **Residual risk (accepted by the owner's rule):** with Always allow on, a line someone else wrote (a shared file, a
  shared folder, a room message, a web page) can make the AI share the person's files or folders, post, or change team
  folder access, without a card. It is bounded by the hard refusals above, by "view only" for everyone added, by the
  audit (via `ai`, `always: true` on the folder access audit), by Undo for removals and by Settings › Allowed for Trina,
  which takes the choice back. It supersedes the security reviews' "always a card" recommendation for these two cards
  (share_folder M6/M7, change_folder_access M8) and their (R) tests, which now test both sides: without Always allow
  the guard, with it the person's choice.
- **Seams joined:**
  - No every-turn "Files shared with you" block (B4 removed it); `shared_with_me` lists the folders shared with the
    person too: link, who shared it, the day, the name as the sharer wrote it (one line, at most 120 characters, tags
    neutralized; the call marks the chat). Folders come from PR 4's `sharedFoldersWith` (FolderShares.listable only: a
    look never pauses or ends a share; at most max + 5 rows looked at), at most 10 an answer.
  - One `namesFolder` (shared-actions.ts, PR 6's); change_folder_access uses it, and a group is named as a group
    (namesGroup) since #1109 made `namedInFull` a recipient check ("Change the finance group…" did not count).
  - `FileShares.cards()` serves folder rows (PR 6's), so a folder share card can show its people again.
  - Words from PR 6's real-AI run: to find a folder the person names, list folders (the user's own, the team folders),
    not only glob/grep; asked to share a team folder, call share_folder or change_folder_access instead of answering in
    words, so the "Ask an admin" offer shows (gate closed: only change_folder_access is named). share_folder's refusal
    for an admin now points to change_folder_access.
  - who_can_open on a file inside the person's own shared folder names the folder's people and says a recipient "can
    already open it through the shared folder" (it only knew file shares and folder rules).
  - With the gate closed (`FOLDER_SHARES_OPEN = false`), B1's interim path stays: "I can't share the whole folder yet,
    but I can share the N files in it".
    - Update: gate removed, always on (owner 2026-11-17). The gate, its closed path and the interim words are gone.
- **Tests:** b-share-folder (kind offered, picked, final; file kind does not cover folders; a stop still asks; admin
  team folder → change_folder_access; the words; who_can_open through a shared folder; the gate closed path),
  c-folder-access-tool (kind offered with its note, picked, final with audit `always`, M8 skipped when on, links kept),
  c-shared-folder-ai (shared_with_me lists folders; (R) both sides), b-looking-at-tool, b-shared-with-me-tool,
  b-ai-share-words (Rule A sides), c-reader-counters (new call sites reviewed), i-wiring (change_folder_access offered).
- **Version impact:** minor, with the two pieces of work.
- **Follow-ups from the final real-AI run (2026-11-17):**
  - The team folder card's note stays within the app's 300 characters in every language: with "Always allow" offered,
    the file shares line goes last in the card's lines; a four-choice server card shows its note.
  - When the person's own "Always allow" let share_with_person, share_folder, post_to_room or change_folder_access go
    without a card, the tool result says so (`RAN_UNDER_ALWAYS`), so the AI never says the person approved it this time.
  - Who can or cannot open something is said only from who_can_open's result in that answer (the AI had said "only you
    can open it" about a file that was shared).
  - shared_with_me gives the day in the team's time zone, as Shared with me shows it.
  - The post card shows the text without bold marks (`**`, `__`); the message that goes keeps them (the room shows
    bold). Links and addresses on the card stay as written.
  - Spanish: "a"/"de" before a filled-in value that starts with "el" read "al"/"del" (shared/src/es-contract.ts).
