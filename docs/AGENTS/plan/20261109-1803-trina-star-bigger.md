# Trina's star in the toolbars: no grey circle, bigger

- Date (UTC): 2026-11-09 18:03
- Branch: `feat/trina-star-bigger`
- Status: in progress
- Where: trina-ax core (`web/src/components/rooms/AiFace.tsx`, `MessageHoverBar.tsx`, `RoomMessages.tsx`). Why: the
  room's toolbars are core (see docs/REPOSITORY-RULES.md)
- Version impact: minor. A visible look change in the room's toolbars; no API, setting or data change.

## Goal

The owner, on a room on a computer in light mode: "트리나 아이콘 주변에 회색 원은 지워줘. 그리고 트리나 로고가 좀더 크게
시원시원하게 보이게 해줘 오른쪽 위도 그렇고 호버 했을때도 그렇고!"

- In a message's hover bar (✅ 👀 👍, 반응 추가, 스레드에서 답장, ✦, ⋮) the star sits on the grey circle of a person
  without a photo (`AiFace`, 20 px circle, 16 px star box) and looks small next to the emoji.
- In the room header (✦, 🔔, ⋯) the star (`AiMark`, 20 px box) looks small next to the bell.

The star should read at a glance in both places, balanced against the icons beside it.

## Scope

In:
- The hover bar's ✦ and the long-press / ⋮ menu's "트리나에게 이 메시지 묻기" use the toolbar mark (`AiMark`), no
  circle. The circle stays where the AI is someone in the room (beside its answers, the status line, the "@" menu,
  Inbox, the rooms list).
- `AiMark` gets a size for each place: the hover bar, the room header (and the image viewer's bar, which shares it),
  and a menu row. The star is bigger in the hover bar and the header; the button sizes and the bar height stay.
- The other look (lucide `Sparkles`, where the product is not named after its AI) follows: no accent circle in the
  hover bar and the menu, and one step bigger where the star grows.
- Unit test of the sizes; the e2e specs of the hover bar check there is no circle.

Out:
- The star's shape and colours (trina.app's mark) do not change.
- The AI's face beside its answers and elsewhere keeps its circle.

## Steps

1. Measure the star and its neighbours (bell, ⋯, emoji, thread icon) at 1440 and 390, light and dark, on the mock
   server; screenshots before.
2. `AiMark` sizes; the hover bar and the menu use it; header and image viewer checked.
3. Unit and e2e tests; CHANGELOG; screenshots after.

## Risks

- `AiMark` is shared with the image viewer's bar (18 px icons, 40 px buttons): check it there.
- Phones have no hover bar (the long-press sheet); the header star must still fit the phone header.

## Tests

`bun run typecheck`, `bun run check:i18n`, the web unit tests, and the e2e specs of rooms, the hover bar, the side
chat and the image viewer.

## Result

Filled in at the end.
