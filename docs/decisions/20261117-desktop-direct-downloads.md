# Desktop app: a download goes straight into Downloads, with no save window

- Date: 2026-11-17
- Status: accepted
- Supersedes: none
- Branch: feat/desktop-direct-downloads (the owner, QA TC-4638)

- **Ask:** in the desktop app, Download on a file in a room opened the system's "Save As" window (name, tags, place).
  The owner wants no window: the file is in Downloads, as in Slack or a browser.
- **Why the window opened:** nothing in the app handled downloads. Every download of the team page (`startDownload`
  and `saveBlob` in `web/src/lib/api.ts`, which click an `<a download>`; 이미지 저장 in the right-click menu, which
  calls `downloadURL`) reaches the team's app session as `will-download`, and with no save path set Electron asks.
- **Rule:** the team's app session sets the save path itself (`desktop/src/main/downloads.ts`): the computer's
  Downloads folder (`app.getPath('downloads')`) + the file's name. One handler covers every download of the team page:
  a room's file, a chat's attachment, Files (a file, an older version), the preview panel and the "cannot preview"
  cards, the image viewer, a shared file's link page, a saved artifact or copied table (a blob) and 이미지 저장.
- **The name is not trusted** (`desktop/src/common/downloads.ts` `safeDownloadName`): it comes from the team server's
  header or the page's `download` attribute. Only its last part is kept (either slash), control characters and text
  direction marks go, the characters Windows refuses become `_`, leading dots and spaces go (no `..`, no hidden file),
  trailing dots and spaces go, a Windows device name (`CON`, `NUL.txt`) gets `_` in front, and it is cut to 200 bytes
  with its extension kept. `pickDownloadPath` then checks that the result is directly inside the folder; if it ever
  were not, no path is set and the save window opens.
- **Never replace a file:** when the name is in use (a file there, or another download on its way to it) the next free
  of `name (1).ext` … `name (999).ext` is taken, as browsers do.
- **The notice is the page's own toast,** not a new component and not a system notification: "Saved to Downloads" with
  the saved name on the quiet second line and one action, **Show in folder**. A failed or interrupted download says
  "Couldn't download {name}. Try again." and the part that arrived is removed. A cancel says nothing.
- **The page names no path.** The app tells the page `{ id, name, ok }` (`DesktopBridge.downloads.onDone`); Show in
  folder sends the number back (`downloads.show(id)`) and the app opens the folder with the file it saved under that
  number selected (the last 50; the Downloads folder itself when the file was moved since). A page cannot make the app
  reveal any other path.
- **Only when the page listens.** The app saves this way once the page registered `onDone` (until its next page load).
  A team server from before this change has no notice to show, so with it the save window stays: a file never lands
  without a word. An older desktop app has no `downloads` on its bridge and keeps the window too.
- **Left as it was:**
  - A browser (no desktop app): the browser's own behaviour.
  - The Mac App Store build: its sandbox may write to Downloads only through the save window (it has no Downloads
    entitlement, and adding one is a store review matter), so `downloadsDir` is null there and the window stays.
  - The in-app browser pane (other websites, the AI drives it): its session is another one and is not touched. A
    website saving files with no question, while the AI clicks, is a different decision.
  - No setting for another folder, no list of downloads, no progress: the lean version first.
- **Risk taken:** a page of the team (or an artifact frame allowed to download) can now put a file into Downloads
  without the person confirming a window, as any website can in a browser. The name cannot leave the folder or replace
  a file, and the notice names every file saved.
- **Tests:** `tests/unit/e-desktop-downloads.test.ts` (names, numbering, the path stays inside, Windows paths, two at
  once), `web/test/unit/desktop-downloads.test.ts` (the notice, the action by number, nothing without the bridge). By
  hand in the desktop app in dev: the same file twice, both names in the folder, the notice in light and dark.
  `MYCEL_DESKTOP_TEST_DOWNLOADS` names a stand-in folder in an unpacked app.
- **Version impact:** patch.
