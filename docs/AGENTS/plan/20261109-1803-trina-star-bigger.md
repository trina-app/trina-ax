# Trina's star in the toolbars: no grey circle, bigger

- Date (UTC): 2026-11-09 18:03
- Branch: `feat/trina-star-bigger`
- Status: done
- Where: trina-ax core (`web/src/components/rooms/AiFace.tsx`, `MessageHoverBar.tsx`, `RoomMessages.tsx`,
  `SideChatPanel.tsx`). Why: the room's toolbars and its side chat are core (see docs/REPOSITORY-RULES.md)
- Version impact: minor. A visible look change in the room's toolbars; no API, setting or data change.

## Goal

The owner, on a room on a computer in light mode: "트리나 아이콘 주변에 회색 원은 지워줘. 그리고 트리나 로고가 좀더 크게
시원시원하게 보이게 해줘 오른쪽 위도 그렇고 호버 했을때도 그렇고!"

- In a message's hover bar (✅ 👀 👍, 반응 추가, 스레드에서 답장, ✦, ⋮) the star sits on the grey circle of a person
  without a photo (`AiFace`, 20 px circle, 16 px star box) and looks small next to the emoji.
- In the room header (✦, 🔔, ⋯) the star (`AiMark`, 20 px box) looks small next to the bell.

The star should read at a glance in both places, balanced against the icons beside it.

Added during the work, the owner on the side chat's box: "only you see this 도 이상해 그냥 지우고 send 버튼 실화냐? ㅋㅋ
뭐여.. 아이콘으로 바꾸던가 해". The line "나만 볼 수 있어요" under the box goes, and the text button 보내기 becomes the
room box's round ↑.

## Scope

In:
- The hover bar's ✦ and the long-press / ⋮ menu's "트리나에게 이 메시지 묻기" use the toolbar mark (`AiMark`), no
  circle. The circle stays where the AI is someone in the room (beside its answers, the status line, the "@" menu,
  Inbox, the rooms list).
- `AiMark` gets a size for each place: the hover bar, the room header (and the image viewer's bar, which shares it),
  and a menu row. The star is bigger in the hover bar and the header; the button sizes and the bar height stay.
- The other look (lucide `Sparkles`, where the product is not named after its AI) follows: no accent circle in the
  hover bar and the menu, and one step bigger where the star grows.
- The side chat's box: no "나만 볼 수 있어요" (the empty side chat says it; `sideChat.private` leaves the five
  languages), and send is the room composer's button (36 px round, ↑, accent / grey, its name and tooltip 보내기, or
  답하기 while the AI waits for an answer to its question).
- Unit test of the sizes; the e2e specs of the hover bar check there is no circle and the sizes; the side chat's e2e
  compares its send with the room's.

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

Built as planned. `AiMark` has a size per place (drawn / slot, star; the sparkle look in brackets):

| Place | Before | After |
|---|---|---|
| Hover bar ✦ (28 px button) | 16 px star on a 20 px grey circle (sparkle 12 on a 20 px accent circle) | 22 px star, no circle (sparkle 18) |
| Room header ✦ (32 px button, 36 on a phone) | 20 px star | 24 px star in the same 20 px slot (sparkle 18 in 16) |
| Image viewer ✦ (40 px button) | 20 px star | 24 px star (sparkle 18) |
| ⋮ menu / phone sheet row | 16 px star on a 14 px grey circle | 18 px star in the 14 px icon slot, no circle (sparkle 16) |
| Side chat send | text button 보내기, 51 × 24 px | round ↑, 36 px (40 on a phone), as the room's box |

Measured on the mock server: the star's own shape is now 18 × 19.8 px in the hover bar (the emoji beside it 20 × 18,
the thread icon 13.3 × 12.7 plus its stroke) and 19.6 × 21.6 px in the header (the bell 12 × 13.3 plus its stroke).
Buttons, the hover bar (34 px), the header and menu rows keep their size; the side chat's box is 9 px taller for the
round button. The circle stays where the AI is someone in the room (beside its answers, the status line, the "@" menu,
Inbox, the rooms list). The room composer has no spinner while it sends, so the side chat's button has none either;
while the AI answers it is disabled (grey), as before.
