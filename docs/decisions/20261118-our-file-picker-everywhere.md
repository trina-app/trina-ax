# Adding a file always starts from our sheet

- Date: 2026-11-18
- Status: accepted
- Supersedes: none
- Branch: fix/our-file-picker-everywhere (the owner, iPhone app)

Plan: docs/AGENTS/plan/20261118-1236-our-file-picker-everywhere.md.

- **Ask:** on the iPhone app (Korean), Files › 내 파일 › ⊕ › 올리기 opened iOS's raw "Photo Library / Take Photo or
  Video / Choose Files" menu, in English, not the sheet the message boxes have. "여기는 왜 우리 파일 선택 UI 안 써? 이런
  거 또 있는지 꼼꼼히 보고 바꿔."
- **Rule:** on a phone (below 768px), adding a file or a picture always starts from our localized sheet
  (rooms/MenuButton.tsx), and each row of it opens one picker of the phone. The device rows are one shared hook,
  `useDevicePick` in `web/src/components/DevicePick.tsx` (사진 보관함, 사진 찍기, 파일), with the place's own rows around
  them (Files: 새 폴더; a profile photo: 삭제; a room app's icon: 이모지). A page never clicks a file input straight
  from a button on a phone: WebKit shows its raw menu for an input that names no type or takes pictures.
- **Rows:** 사진 보관함 uses the phone app's own photo picker (photo-pick-v1) where the app has it, else the input; 파일
  asks iOS for any data file (`application/octet-stream`), which opens the Files browser at once. A place for one
  picture (a profile photo, the team logo, an app's icon) takes one file from each row, its picture types where the
  phone lets a page say so, and checks what came (squarePhoto, the logo check). A logo or an app's icon has no 사진
  찍기 row.
- **Where:** the message boxes' attach sheet (unchanged, now on the hook), Files ⊕ and an empty folder's 올리기,
  Settings › Profile photo, the member welcome's photo, the admin welcome's files ("소개 자료"), the team-files step's
  "파일 직접 올리기", Admin › Team logo, a room app's icon.
- **Not changed:** computers (a labelled button opens the computer's file window; there is no menu before it). An
  input that names only types that are no picture (the Drive key's .json, a .trinaplugin) opens the Files browser at
  once on iOS. Folder pickers are a computer's. An iPad at 768px or wider has the computer's layout and keeps its
  buttons (WebKit's menu can still show there).
- **Known limits:** in Safari or an app older than 1.0.5 (no photo-pick-v1), 사진 보관함 opens the input, and iOS still
  shows its own short menu (the photo library first) after our sheet, as the message boxes' sheet does. The app's photo
  picker takes no type, so a video can be picked for a face, a logo or an icon; the place then says the file is no
  picture it can use.
- **Guard:** `web/test/unit/device-pick.test.ts` lists every file input of the web app with why it may be there; a new
  one fails the test until it is added there (on a phone: through `useDevicePick`).
- Tests: the unit test above; `web/test/e2e/our-file-picker.spec.ts` (390: our sheet and no file chooser on the tap,
  then a row opens it; 1440: the buttons open the file window at once); the phone Files, profile, team logo and room
  app icon specs follow the new rows.
- Version impact: patch.
