# AI sharing: one card, one next-step mechanism

- Date: 2026-11-16
- Status: accepted
- Supersedes: on the points below, 20261116-ai-share-card-and-stop.md (the refusal's `next` as data the app fills),
  20261116-ai-share-who-can-open.md (offers only under the answer) and 20261116-ai-share-words.md (the same-name rule).
- Branch: integrate/ai-sharing (the owner's plan "AI sharing" of 2026-11-16, packages 1, 2, 3 and 5 built in parallel)

- **Ask:** four packages were built side by side: the words (B1), one card and stop sharing (B2), who can open and
  one-tap offers (B3), the screen and shared-with-me tools (B4). Joined as they were, a refusal could show its next step
  twice (on the card and under the answer), "Ask an admin" meant two different things, the AI's words could point at a
  button that did not exist, and the card's "why it asks" line was lost.
- **Rule:**
  - **One next-step mechanism.** A refusal's next step is the server's stored offer (`Step.fixes`, `share_fix_offers`).
    The share card's record names it (`ShareCardNext.fixId`); the app shows that offer as the card's one button
    (`registerShareNext` with `StepFixButton`) and leaves it out of the offers under the answer. No offer, no button: the
    AI's words then offer to write the request.
  - **One "Ask an admin".** One kind, `ask_admin`, with the reason on the offer (`StepFix.reason`): `folder` (a member
    asks about a team folder; the admins get the person's 1:1 message naming the folder and the people) or `switch`
    (the team turned off members' file sharing; the admins get the person's 1:1 message naming the file by its name and
    asking to turn "Members can share files they own" back on). The server writes both messages, in six languages. The
    tap changes nobody's access. A switch offer whose switch is back on, or whose file is no longer the person's, sends
    nothing.
  - **Words follow the buttons.** Each refusal sentence (`SHARE_NO`) is told whether the card has the button; with it,
    "Next step" points at the button and tells the AI not to send a message itself; without it, the earlier offer stays.
  - **One "why it asks" line.** The rooms or shared-file line (`seenWhy`) and the "someone else's words" line
    (`othersWordsWhy`) never both show: `othersWordsCard` is false once rooms were seen. The share card's rows now carry
    the line (`ShareCardAsk.why`), since the app shows the rows in place of the question.
  - **"Already open" is on the record.** Who could already open the files is found before the card (B3) and written on
    the result (`StepShared.already`): "Jun can already open Quote.pdf" with no card, or a line under the rows when some
    of the people were new.
  - **`fromLook` covers stop_sharing too.** A file or person the AI learned from `looking_at` in this turn is not the
    asker's word: stop_sharing then asks first, as share_with_person and post_to_room do. who_can_open needs nothing more
    (it reads only, and in a shared chat only what the asker named; looking_at is off there).
  - **A file shared with the person (B3 with B4).** Asked to share on a file they have only through a share (its path
    or its `/f/` link), share_with_person refuses as for someone else's file, with the card's "Ask <owner>" button,
    and never says the owner's folder. A post whose text links such a file as `/f/<id>` gets "Ask <owner>" for the
    people in the room who cannot open it (the room's own check reads only team-path links). Found in the real-AI run.
  - **Nobody new got access.** When a share added nobody (also in a shared chat, where the check before the card is
    skipped), the result card says who could already open it instead of "Shared … with".
  - **Same-name files (TC-4091).** To read or summarise, the AI may answer for each file, each part labelled by its place
    and, for a shared file, who shared it and when. To act on one (share, post, edit, delete, move, rename) it asks which.
- **Why:** the plan's principle, "a refusal always offers a next step", only holds if that step is one button the person
  can see once, and the AI says what that button does.
- **Not changed:** every check of the four packages; who may share, stop, or be asked; the confirmation card for any
  widening.
