# A conversation box's files stay over a page reload

- Date: 2026-11-17
- Status: accepted
- Supersedes: none
- Branch: fix/room-upload-survives-update-reload (QA TC-4327)

- **Seen:** on qa.trina.app a 2 GB file was going up in a conversation while the server updated. The upload went on
  after the restart and finished. Within a minute the page reloaded by itself for the new version, and the file's chip
  was gone from the message box: the person had to choose the file again, and nothing said so.
- **Why:** the page holds its own reload while a file is on its way (`lib/busy.ts` "upload"), but not once it is up and
  waiting for Send; and the box's files were only in the page's memory (`store/roomUploads.ts`).
- **Rule 1, the page waits:** a file in a conversation box that is up and not sent (or that a reload stopped) holds
  every reload the page makes by itself (`lib/reload-guard.ts`: after an update, for a page part of the old build, the
  desktop app's restart to install), as a typed reply already does. "A new version is ready." stays with its Reload
  button. A file that failed for its own reason holds nothing, and neither does one older than 23 hours (the server
  removes a file not sent within 24: `rooms/files.ts` `UNSENT_FILE_MS`), so a forgotten file does not hold updates for
  good.
- **Rule 2, the person's own reload keeps them:** the files of each box are remembered in the tab (`sessionStorage`,
  `mycel.roomUploads`) and are the boxes' files again after the page loads for the same person.
  - Up and not sent: back as it was, ready to send (the server still has it). A team file keeps its line about who it
    reaches.
  - Still on its way: a browser cannot keep a file over a reload, so it cannot go on by itself. Its chip comes back
    failed with "Upload stopped when the page reloaded. Choose the file again to continue." Choosing the same file
    (name and size) takes the chip's place and a large one continues from the pieces the server has; ✕ drops those
    pieces.
  - Not kept: a file that had already failed, and a team file still being copied (picking it again gets the server's
    copy).
- **Why the tab and not the device** (where typed drafts are): another tab of the same person would show the same
  unsent file, and the second send of one file is refused. The cost: closing the tab, or the desktop app restarting
  when the person asks it to, still drops the box's files (the browser asks first while one is on its way; the server
  removes them after a day). The desktop app does not restart by itself while a box holds one.
- **A file that is gone anyway** (a tab left for a day, a tab duplicated by the browser and sent from both): the send is
  refused (`body.fileIds`), and the message now comes back to the box without those files with "The attached files are
  no longer available, so the message was not sent. Attach them again." It used to come back with the same files and
  fail every time.
- **Nothing of one person for the next:** signing out, a sign-in that ends, another person signing in and "clear this
  browser's data" forget the tab's copy; one left by another person is removed, never shown. A page load that cannot
  reach the server (it is restarting) leaves the copy alone until the person is known again.
- **No server change.** A list of "my unsent files in this conversation" on the server was not needed: it could not
  say which box (the conversation's or a thread's) a file was in.
- **Tests:** `web/test/unit/room-uploads-kept.test.tsx`, `web/test/e2e/room-upload-reload.spec.ts` (1440 and 390 px).
