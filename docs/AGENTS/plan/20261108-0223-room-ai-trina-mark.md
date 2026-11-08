# @트리나 in rooms shows Trina's star instead of the sparkles

- Date (UTC): 2026-11-08 02:23
- Branch: `feat/room-ai-trina-mark`
- Status: in progress
- Where: trina-ax core web app (`web/src/components/`). Why: rooms are core; the star is Trina's mark and shows only
  where the product is named after its AI (`PRODUCT_NAMED_AFTER_AI`), as the name 트리나 does, so another edition keeps
  the sparkle (see docs/REPOSITORY-RULES.md)
- Version impact: minor. A visible change in the room UI; no API, data or setting change.

## Goal

The owner circled the avatar next to "트리나" on an AI answer in a room (a small orange lucide `Sparkles` in a light
circle): "이 표시가 좀 짜치인거 같아.. 그냥 우리 트리나 아이콘으로 하면 어때?". The icon they mean is the star of the
trina.app site: a straight-edged four-point star with a longer bottom spike in an orange gradient. @트리나 should wear it
wherever a room shows it as a participant.

## Scope

In:
- `TrinaStar`: the site's SVG as it is (same path and gradient), one gradient id per drawing (`useId`), a square viewBox
  centred on the crossing of the arms (y 236 of 512) so it sits centred in a round avatar. The same gradient in both
  looks.
- `AiFace`: the AI as a participant. Where `PRODUCT_NAMED_AFTER_AI`, the star on the neutral avatar circle (`bg-hover`,
  like a person without a photo); elsewhere the sparkle on the accent circle as today.
- Used for: a room's AI answer avatar (RoomMessages), the "@" menu's AI row (useMentionMenu), the AI status line
  (RoomAiStatus), the "트리나 답변" head of an answer shared into a room, and the Inbox row of an AI answer
  (RoomNoticeRow). Decorative (`aria-hidden`) next to the name; labels unchanged.

Out (left as they are): "트리나에게 묻기" and the phone's AI tab (actions), generic AI sparkles elsewhere (skills,
files' "AI에게 묻기", onboarding), the app icon in the rooms list's pinned AI row and the sidebar.

## Steps

1. `web/src/components/TrinaStar.tsx` and `web/src/components/rooms/AiFace.tsx`.
2. Replace the five sparkle call sites.
3. Unit test (`web/test/unit/ai-face.test.tsx`); update any test that looked for the sparkle.
4. Screenshots at 1440 and 390, light and dark: a room with an answer, the "@" menu, the status line, a shared answer,
   the Inbox; both avatar backgrounds (neutral circle, none), zoomed.
5. CHANGELOG line; docs/DESIGN-SYSTEM.md avatar row.

## Risks

- Gradient ids: several stars on one page must not share an id (a hidden first one would blank the others).
- Light look: the gradient's light end (#FFB060) is pale on a light page; decorative, the name stands next to it.
- Editions: a build where the AI is not named after the product keeps the sparkle.
- No migration, no API, no i18n strings.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run test:web` (known failure:
download-only-actions), `bun run build:web`, then the room, mention, answer-share and Inbox e2e specs on chromium.

## Result

Filled in at the end.
