# A chat's Share dialog: one warning line, one unticked files box, one Share button

- Date: 2026-11-22
- Status: accepted
- Supersedes: none (changes the buttons of Rule 1 in [20261121-share-chat-files.md](20261121-share-chat-files.md))
- Branch: fix/share-dialog-lean (the owner: "too much text?"; plan
  [20261122-0300-share-dialog-lean.md](../AGENTS/plan/20261122-0300-share-dialog-lean.md))

- **Ask:** the owner looked at the chat Share dialog with a warning, a file and an unchecked answer and asked whether
  it had too much text.
- **Rule 1, one warning line:** the yellow box says what is at stake in one line, then the places after " · " ("Some
  answers used places Bob can't open · your personal memories, groups/x/, My files"), and "Show answers ›". Answers
  nobody could check are its short second line when there is a box, and the grey line as before when there is not.
  The project members' share and the access-request notice keep their sentences.
- **Rule 2, one files box, unticked:** the files the chat made in my own folder are one checkbox row "Share the files
  too (n)" with each file and its place under it, and one hint "The chat gets copies. Your originals stay put." (the
  copies going with the chat in its tooltip). It starts unticked: a file leaves My files only by a press that names
  files, as with the old [Share with files] button. The footer is Copy link, Cancel and Share (Save on a chat already
  shared); with the box ticked the save carries the files, on a chat already shared Save then saves the files alone.
- **Rule 3, one short note:** "People you add see the whole chat, from the start, and can ask the AI in it." under the
  people list replaces the long note and the footer line "People you add can open the link after you press Share" (a
  project's Share dialogs keep that line). The ✕ on each row says people can be taken out.
- **Unchanged:** the server, the API calls, the confirm keys, the earlier attached files line (always its own line),
  hidden answers and their files, who may open a copy.
- **Tests:** web/test/unit/chat-share-dialog.test.tsx; web/test/e2e/share-chat-files.spec.ts,
  share-chat-people.spec.ts, share-copy-link.spec.ts.
- **Version impact:** patch (wording and layout of one dialog).
