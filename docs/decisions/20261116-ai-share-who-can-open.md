# The AI says who can open a thing, and a refusal gets one button

- Date: 2026-11-16
- Status: accepted
- Supersedes: on one point each, the archive's "post_to_room: the AI posts to a room behind one card" and "A member
  shares their own files" (see **What changed in older rules**). Everything else there stands.
- Branch: feat/ai-share-who-can-open (the owner's plan "AI sharing" of 2026-11-16, package 3; QA tab "Manual AI tests"
  MAN-003, MAN-013)

- **Ask:** hands-on tests ended in dead ends. After the AI posted to a room the person read "3 people can't see some of
  the sources" and had nothing to press. "Share my colleague's file with Jun" ended in "only its owner can". A chat
  moved into a project stayed private without a word, and "why can't Jun see this chat?" got a guess.
- **Rule:**
  - **`who_can_open`** (a read-only AI tool, `server/src/chat/who-can-open.ts`): who can open a file, a folder or this
    chat and by which route (their own folder, the team's owner and admins, a folder's access by everyone / a group / a
    name, a file shared by name / with a group / with everyone, a project's members, a chat shared with people), or
    whether one teammate can and why not. It explains what `RuleSet.explain` and `FileShares.open` decide
    (`server/src/files/access-routes.ts accessRouteFor`); it decides nothing.
  - **What the asker learns is what the screens show them.** A file: its owner, or whoever may share it, gets the Share
    dialog's rows and how many people the folder lets in; the names of those people only for the owner and admins. A
    folder: the owner and admins get the names, a member the count the Files screen shows. This chat: whoever sees it
    gets who else does. Anyone else gets their own access and who to ask. A file or folder the asker cannot open reads
    exactly like one that does not exist. A folder is said in the Files screen's words, never as a path.
  - **Where it runs:** a person's own chat; a shared chat only for the chat itself and a file the asker named or
    attached in their own message (everyone there reads the answer). Never for a guest, a sub-agent, a scheduled run, a
    question from Slack, a confidential chat, a template's or a restricted run. After a room read it needs no room card
    (it reads nothing of a file and changes nothing).
  - **A next step is the server's record** (`Step.fixes`, `share_fix_offers`, migration 363,
    `server/src/files/share-fixes.ts`): the files by their link ids, the people by their ids, the room. The step carries
    names the server read and counts; nothing on the line or the button comes from the AI's text or a file. Only the
    person whose turn it was gets the offer (other viewers of a shared chat never do) and only they can run it, once
    (`POST /api/share-fixes/:id/run`). The tap is the confirmation: the line named the people before it.
  - **Let them view** (the person may share the file): the Share dialog's own call as that person
    (`FileShares.change`, via `ai`, audited `file.share`, each person told as for any share), for the people listed
    who are still in the room, still active members, no guests, and still unable to open the file. Nobody is added:
    someone who joined the room since is counted in what the line says afterwards, not granted. A person who may no
    longer share the file is refused at the tap and the offer stays.
  - **Ask <owner>** (someone else's file): the existing access request, asked for other people
    (`FileShares.requestFor`, `file_access_requests.asked_by`). The owner's Activity row reads "Alice asked you to share
    X with Bob" with the same Share / Decline; an approval is the same view-only grant; a decline is told to who asked.
    One ask counts once toward the asker's limits (20 an hour, 5 a day to one owner), and is not counted against the
    people it was asked for. Someone who may share the file cannot ask, and nobody can ask about a file they cannot
    open.
  - **Ask an admin** (a team folder, asked by a member): the person's own 1:1 message to the team's owner and admins
    (at most 3, the owner first), written by the server: the folder by name with a link to it, and the people. It
    changes nobody's access.
  - **Share with project** (a private chat in a team project): the app's own share flow with its check and its
    confirm. The server runs nothing for it. The same button is in the toast when a chat is moved into a team project:
    "Moved to Launch. Only you can see it." The rule that a moved chat arrives private is unchanged.
  - **After a post to a room** `post_to_room` offers Let them view / Ask <owner> for a linked file that did not go as a
    copy and for a file the text came from, when some member cannot open it. The AI is told the count and that a button
    shows, never the names.
  - **"Jun can already open it through Sales":** `share_with_person` says so and shares nothing again when every person
    named can already open every file (`server/src/chat/share-next-steps.ts alreadyOpen`); a group is still shared with
    as asked (its later members).
  - **A path link opens through a share.** A room message links a file by its team path. Someone the file was shared
    with (not let in by the folder) gets the file's own `/f/<id>` link in place of the lock
    (`GET /api/files/granted-link`: null for a file they can read anyway, one they may not open and a missing one alike).
- **What changed in older rules:**
  - The post check told the sender only how many people could not open something, never who. Now the sender who may
    share the file sees their names on the Let them view line, because the share that follows names them in the Share
    dialog anyway and a grant to unnamed people would be a blind one. A sender who may not share the file still gets
    the count alone.
  - A request for access could only be asked by the person who wanted it. Now someone who can open the file may ask its
    owner for other people.
- **What stays:** content that used earlier room answers hidden from a member is never sent, confirmed or not
  (`answer_share_hidden`). A source that is not a file (a room, a connected service, an earlier conversation, an unknown
  one) keeps its line and gets no button. Widening access keeps a confirmation: here it is the tap on a line that named
  the people. No folder is shared by a member. Approvals of a request stay view only. Guests get nothing through a
  share.
- **Left out:** a Connect button for a Google app under the AI's sentence (a service with an address already gets the
  connect card in the chat, and the answer goes on once it is connected); a new Activity notice type for folder
  requests (the 1:1 message stands in for it); the names of people who cannot open a file for a sender who does not own
  it.
- **Tests:** `tests/unit/c-who-can-open.test.ts` (every route, what each asker learns, each tap's checks: a non-owner,
  a guest, a member who left, one who joined since, a second tap, a refusal that leaves the offer open),
  `web/test/unit/step-fix.test.tsx`, `web/test/e2e/step-fix.spec.ts`.
- **Version impact:** minor (a new tool, two endpoints, an additive migration).
