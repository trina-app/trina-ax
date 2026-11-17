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
  "Couldn't download {name}. Try again." A cancel says nothing.
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
- **Risk taken:** a page of the team (or an artifact frame allowed to download) can put a file into Downloads without
  the person confirming a window. A browser that does this guards it three ways: it marks the file as downloaded from
  the internet (the Mac's quarantine, Windows' Mark of the Web), it warns before keeping a dangerous type, and it asks
  before a page starts many downloads. Electron does none of these on its own (`setSavePath` writes no
  `com.apple.quarantine`, checked with Electron 44), so the app does them:
  - **Types that run code keep the save window** (`runsCode`): on the Mac `app command tool terminal sh zsh bash pkg
    mpkg dmg jar webloc inetloc fileloc scpt applescript workflow action`, on Windows `exe msi msix msixbundle appx
    appxbundle bat cmd com scr ps1 psm1 vbs vbe js jse wsf wsh hta lnk url scf reg cpl inf pif application`. The last
    extension of the cleaned name decides, in any case (`a.pdf.exe` asks, `a.exe.pdf` does not).
  - **Every saved file gets the mark** (`markDownloaded`): `com.apple.quarantine` (`0083;<time>;Trina AX;`, through
    `xattr` with no shell) on the Mac, a `Zone.Identifier` stream with `ZoneId=3` and the http(s) addresses (never a
    blob or data address, no user name or password) on Windows. Gatekeeper, SmartScreen and Office's Protected View
    then treat it as they treat a browser's download. A failure to mark is logged, not shown.
  - **Three direct saves in ten seconds from one page,** then the save window again until the ten seconds pass
    (`SaveBurst`).

  The name cannot leave the folder or replace a file, and the notice names every file saved. The notice says the saved
  name, `report (1).pdf` included, because that is how the person finds the file; a page can tell from it that a file
  of that name was already in Downloads. That is accepted: it learns a name it chose, not what the file holds.
- **A failed download:** Chromium removes the part that arrived itself, so the app deletes nothing (it could otherwise
  remove a file that is not its own). An interrupted download that cannot resume frees its name at once.
- **Tests:** `tests/unit/e-desktop-downloads.test.ts` (names, numbering, the path stays inside, Windows paths, two at
  once, types that run code, the save limit, the quarantine and zone text), `web/test/unit/desktop-downloads.test.ts` (the notice, the action by number, nothing without the bridge). By
  hand in the desktop app in dev: the same file twice, both names in the folder, the notice in light and dark.
  `MYCEL_DESKTOP_TEST_DOWNLOADS` names a stand-in folder in an unpacked app.
- **Version impact:** patch.
