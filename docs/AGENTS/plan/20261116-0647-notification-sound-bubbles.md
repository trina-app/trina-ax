# Notification sound: Bubbles replaces the chime

- Date (UTC): 2026-11-16 06:47
- Branch: `feat/notification-sound-choice`
- Status: done
- Where: trina-ax core (`web/src/lib/roomSound.ts`, its unit and e2e tests). Why: the room sound is the web app's own
  (the desktop app and the phone app run the same page); no server change.
- Version impact: patch. No API, data or setting change.

## Goal

The owner: today's chime (G5 → C6) sounds like a "recording ended" sound. From the sound board they first kept five
candidates, then picked one: "11번으로 가자" = Bubbles. Everyone hears Bubbles; nothing to pick.

## Scope

In: `playChime` plays Bubbles: two sine notes, 700 Hz then 900 Hz 0.1 s later, each gliding up ×1.7 within 0.12 s,
peaks 1 and 0.9, attack 3 ms, 0.12 s long; master gain 0.36 as before. The on/off switch stays as it is.
Out: a picker (the five-sound picker was dropped when the owner chose one), new strings, the phone's push notification
sound and the desktop app's system notification sound (both the OS's, unchanged), a volume slider.

## Steps

1. Replace the chime's notes and envelope in `lib/roomSound.ts`; `REST_AFTER_MS` (1.5 s) still covers it (0.24 s).
2. Unit tests: the notes, glides and envelopes; the rendered peak (glide-aware) stays audible and under clip.
3. e2e: the stubbed Web Audio counts 2 notes per chime (was 4).
4. Decision file, changes fragment.

## Checks

`bun run typecheck`, `bun run check:i18n`, `web/test/unit/room-sound.test.ts`, the room-sound e2e specs.

## Result

Bubbles plays wherever the chime played (browser tab, desktop app, open phone app). Rendered peak 0.355 at the output
(old chime 0.43), worst case 0.68, under the clip limit. QA TC-3844.
