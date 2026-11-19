# Remove meeting notes

- Date: 2026-11-19
- Status: accepted
- Supersedes: [Meeting notes: the desktop app captures, the team server turns pieces of sound into text](20261116-live-meeting-notes.md)
- Branch: chore/remove-meeting-notes (the owner, 2026-11-19: "회의 기록하기 필요없어 코드 싹다 지워줘")

- **Ask:** the owner does not want "Take meeting notes" and asked for all of its code to go. What was wanted on 11-16 was
  fast, Yogurt-style speech-to-text in the chat composer's microphone, not a meeting recorder.
- **Removed:** the Mac sound helper (`desktop/native/meeting-audio`, its `swiftc` step in the `dist:mac*` scripts,
  `mac.extraFiles` / `x64ArchFiles`, the dmg check for it, the store build's `extraFiles: []`), the desktop meeting
  session and control (start dialog, menu bar item, `meeting-unsaved.json` handling, team switch guard), the
  `DesktopBridge.meeting` bridge and its IPC, `NSAudioCaptureUsageDescription` (the microphone text is back to "Voice
  input in chats uses the microphone." in six languages), `GET /api/meetings/status` and `POST /api/meetings/piece`, the
  meeting speed meter and the meeting-only refusals, the My files button and the card (web `MeetingNotes.tsx`,
  `lib/meetingNotes.ts`, the `meeting.*` texts), the AI app map's line about it, its feature id `chat.meeting-notes` and
  AI scenario cases MTG-01..03.
- **Kept, because voice input uses it:** `shared/src/speech-pieces.ts` (the Yogurt cutter and the piece session; the
  NOTICE entry stays, as ported Yogurt code remains), `POST /api/transcribe/piece` and its runner
  (`server/src/jobs/meeting-piece.ts`), `MEETING_PIECE_MAX_SEC`, `MeetingPieceResult` and `MEETING_RETRY_REASONS`. Their
  names still say "meeting"; a rename is left until the voice input latency work on the same files settles, so the two do
  not conflict. A piece that waits for the first-use speech model now says "Voice input is still getting ready" instead of
  naming meeting notes.
- **Kept, not part of this feature:** the 📅 "In a meeting" status preset (`status.s.meeting`, custom status), the
  `meeting-summary` / `meeting-tasks` / `meeting-action-items` skill examples, demo meeting files and the onboarding
  meeting notes folder texts.
- **Data:** the feature made no table or column; nothing to migrate. Notes already saved in a person's My files ›
  Meetings are their files and stay; the folder keeps its name in the person's language (`MEETINGS_DIR`,
  `MEETINGS_LABEL` in `shared/src/folder-labels.ts`). A `meeting-unsaved.json` left in an installed app's data folder
  is not read or deleted any more.
- **Older apps:** a desktop app built before this still offers `DesktopBridge.meeting`; the page no longer looks at it,
  and the server answers 404 to its calls.
- **Version impact:** minor (two calls removed, one desktop permission text removed).
