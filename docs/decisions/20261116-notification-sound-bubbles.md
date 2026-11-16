# The notification sound is "Bubbles"

- Date: 2026-11-16
- Status: accepted
- Supersedes: [대화방 알림 소리](../DECISIONS.md#대화방-알림-소리-featroom-sound-2026-11-06) (the chime's notes only; what rings is unchanged)
- Branch: feat/notification-sound-choice (the owner, QA TC-3844)

- **Ask:** the owner: the room chime (G5 → C6, two soft notes up a fourth) sounds like a "recording ended" sound. They
  listened to a board of candidates, kept five, then picked one: "11번으로 가자" (Bubbles).
- **Rule:** the room sound is Bubbles for everyone: two quick sine bubbles, 700 Hz and 900 Hz 0.1 s later, each gliding
  up ×1.7 (exponential) within its first 0.12 s, peaks 1 and 0.9, 3 ms attack, gone by 0.12 s; master gain 0.36, as
  the old chime's (`web/src/lib/roomSound.ts` `CHIME_NOTES`, `playChime`). About 0.22 s long. The on/off switch in
  Settings › Notifications stays as it is (per device, on by default); no picker.
- **Why one sound, no picker:** the owner chose one. A picker was started for the five and dropped the same day: one
  more setting nobody asked to change (lean settings).
- **Loudness:** rendered sample by sample, the peak at the output is about 0.36 (the old chime: 0.43); with both notes
  at their top at once it would be 0.68, under the clip limit (0.9), so no compressor. The context still rests 1.5 s
  after a sound (`REST_AFTER_MS`), far past its end.
- **Not changed:** the phone app's push notification sound in the background and the desktop app's system
  notifications are the operating system's own sounds; only the page's sound changed (browser tab, desktop app window,
  phone app on screen).
- **Tests:** `web/test/unit/room-sound.test.ts` (notes, glides, envelopes, rendered peak); the room-sound e2e specs
  count two notes a chime.
- **Version impact:** patch.
