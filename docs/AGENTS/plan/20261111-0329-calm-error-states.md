# Calm connection errors: one quiet notice that tries again by itself

- Date (UTC): 2026-11-11 03:29
- Branch: `fix/calm-error-states`
- Status: in progress
- Where: Team AX core (`web/src`). Why: the screens, their shared blocks and the app frame are core (see docs/REPOSITORY-RULES.md)
- Version impact: patch: how existing load and connection errors look and behave, a few words; no API or data change

## Goal

The owner, on Home during a short network hiccup: a bare red sentence under the message box ("Couldn't reach the team
server. Check your connection and try again.") and an underlined "Load again" link centred under it. Red and jargon for
what is usually a blip, and it looks like nothing else in the app. Lists and sections that fail to load elsewhere use a
red error box with the same words.

People at work should see one calm notice that says what is going on in plain words and fixes itself when it can.

## Scope

In:
- One shared block, `LoadError` (`web/src/components/LoadError.tsx`), for a list or section that could not be read:
  - **The connection** (no answer at all, or the relay's 502–504 `unavailable` without a reason of the server's own): a
    quiet notice on the neutral surface (small icon, "Can't connect right now." / "지금 연결이 안 돼요.", "Reconnecting…" /
    "다시 연결하는 중…" with a small spinner, a secondary "Try again" / "다시 시도"). It reads again by itself with backoff
    (2, 4, 8, 15, then every 30 s) while the page is visible, at once when the page shows again, the browser is back
    online or the live connection is back; nothing while the page is hidden. Recovered: the notice goes, the data shows.
  - **While the app-wide connection banner shows** (the live connection is reconnecting or offline): no second message,
    a quiet spinner only; it reads again when the connection is back.
  - **Anything else** (the server answered with an error): the red `ErrorNote` as today. Red stays for real problems and
    destructive confirmations.
- The retry logic in `web/src/lib/autoRetry.ts` (a small scheduler, unit-tested with fake timers).
- `isConnectionError` in `web/src/lib/api.ts`.
- Applied to: Home's 「팀에 준비된 것」 (the "Load again" link), the message box's first send on Home (a calm "not sent,
  your message is still here" with Try again; never sent by itself), the sidebar's 트리나 기록
  (spun forever on a failed read), the rooms list, a room's messages, the file list, a chat's messages, the side chat,
  the admin screens' shared loader (`Loadable`), Settings › Devices and Settings › Memory.
- The connection banner: the neutral surface instead of amber and red, and plain words for "offline".
- Five languages for every new or changed string.

Out:
- The chat error texts (`chat.error.*`, answer error cards): `fix/plain-words-errors-cards` rewrites those.
- Action failures (saving, deleting) and their toasts: they stay as they are.
- The sign-in gate's full-page "can't reach" screen, the desktop and mobile shells' own texts.
- Other places that use `ErrorNote` for a load: they keep it; they can move to `LoadError` one by one.

## Steps

1. `isConnectionError`, the `AutoRetry` scheduler and its hook.
2. `LoadError` and the composer's calm "not sent" line; the connection banner.
3. Apply to the places above; keep the error on screen while a place reads again (no flicker, no reset of the backoff).
4. Strings in ko, en, id, ja, es.
5. Unit tests (scheduler: backoff, recovery, hidden page, banner; the block; the composer keeps the draft) and e2e
   (route-abort the load, the calm notice, recovery without a click, manual Try again).
6. DECISIONS ("How we show errors"), DESIGN-SYSTEM, `changes/calm-error-states.md`.

## Risks

- A place that clears its error while it reads again would remount the notice and restart the backoff at 2 s: the
  places changed here keep the error until the answer.
- Tests that look for `role="alert"` on a network failure of the changed places.
- Five languages; phone and computer widths; light and dark.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run test:web`, `bun run build:web`, the e2e specs
of the touched screens and a new `calm-errors.spec.ts`.

## Result

(filled in at the end)
