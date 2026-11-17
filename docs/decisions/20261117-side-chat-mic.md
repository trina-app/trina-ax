# The ✦ side chat's box has the mic, as every message box

- Date: 2026-11-17
- Status: accepted
- Supersedes: none
- Branch: fix/side-chat-mic (the owner, 2026-11-17)

- **Ask:** in a room, the ✦ side chat on the right had no microphone: its box showed the clip and send only, while the
  room's box beside it had the mic. The owner asked why.
- **Why it was missing:** no decision left it out. Voice input came to rooms and threads on 2026-11-07
  ("Voice input in rooms, and hold Space to talk": `RoomComposer`); the side chat was built two days later with a box of
  its own (`web/src/components/rooms/SideChatPanel.tsx`, not `Composer` nor `RoomComposer`), and nobody wired
  `useVoiceInput` into it. The files work of the same week reused the full chat box's parts; voice was not on its list.
- **Rule:** the side chat's box takes voice input like every message box, with the shared pieces only
  (`lib/useVoiceInput.ts`, `components/VoiceBar.tsx`): the mic right before send under the team's switch (`micState`),
  a click that records until ✓, Space held in the box on a computer, a finger held on the mic, Esc or ✕ to throw the
  recording away, live words on teams whose voice input goes to OpenRouter (`POST /api/transcribe/piece`). The words go
  to the end of the box and are never sent by themselves. While recording, the bar stands in the row's place and the
  text stays on top, so the box keeps its size.
- **Which chat:** a side chat is an ordinary chat of mine (`chats.side_room_id`), so the recording names it
  (`chatId`), as in the full chat; before the first question there is no chat and it names none (the server answers as
  for a new chat). A confidential side chat, or every chat while Safe operations 1A is on, with voice input going to an
  outside service: the note under the box instead of a recording (`voiceBlockedHere`, the chat's wording, not the
  room's), and the server refuses it either way.
- **Server:** no change. `assertVoiceChat` already takes the caller's own chat, which a side chat is; nobody else's
  side chat passes it. Guests as before: speech to text is off their endpoint list (see "Guests have no mic").
- **One recording at a time:** the room's box, a thread's box and the side chat's box share the one microphone
  (`useVoiceInput`'s owner): while one records, the others' mics wait.
- **Another chat:** "New chat" or a chat opened from 🕘 while recording throws the recording away (it was for the chat
  shown), without putting words back into the other chat's box. The first question or file making the side chat does
  not.
- **Left out:** in the file viewer's column Esc is the viewer's (it is a dialog), as for a thread's box there: ✕ on the
  bar cancels a recording. The phone's side chat keeps its two-row box (not the room's one-line box).
- **Guests have no mic** (QA TC-4575, the owner's side, 2026-11-17): the server takes no recording from a guest (an
  upload session for one, `POST /api/transcribe` and `/api/transcribe/piece` are 403: `tests/unit/a-guests-speech.test.ts`),
  but every box showed a guest the mic, which then failed. `micState` (`web/src/lib/voice.ts`) now answers `hidden` for
  `me.user.role === 'guest'`, so the room's box, a thread's, the side chat's and Ask Trina's show none and Space stays a
  Space. No server change.
- **Tests:** `web/test/unit/side-chat.test.tsx` (the mic before send; none with voice input off),
  `web/test/e2e/voice.spec.ts` "rooms" (a click, Space held, Esc, "New chat" while recording, the chat named, the box's size while recording, the
  room's mic waiting, live words, the confidential note, no mic without the server's tools);
  `web/test/unit/voice.test.ts` and `web/test/e2e/guest-view.spec.ts` (a guest has no mic in any box, a member has).
- **Version impact:** patch.
