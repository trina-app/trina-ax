# A click on a person opens a small card with one button: Message

- Date: 2026-11-16
- Status: accepted
- Supersedes: none
- Branch: feat/person-card (the owner, 2026-11-16)

- **Ask:** in a team room a click on a person's photo beside a message did nothing. The owner wants to click the
  person and message them directly.
- **Rule:** a person's photo and name are buttons that open their card (`web/src/components/PersonCard.tsx`
  `PersonButton`, one piece for every place):
  - **Where:** a message's photo and name (the room's timeline and a thread), an @mention of a person in a message,
    and a row of the room's member list (the whole row).
  - **What it shows:** the photo with the online dot, the name, the Guest tag, the title and the status message, and
    one button, **Message**. Only what the people directory already gives every signed-in person (`GET /api/people`).
    No e-mail, role or groups: the directory never gives them, and no API was widened.
  - **Message** opens the 1:1 chat with them (`POST /api/rooms {kind: 'dm'}`: the one there is, or a new one), closes
    the member list when it was opened from there, and puts the keyboard in the message box (not on a touch screen,
    where the keyboard would cover the chat that just opened).
  - **Yourself:** no Message; **Edit profile** opens Settings › Profile.
  - **Who has a card:** the people the directory lists for the viewer. The server lets the viewer message exactly
    those (`rooms/service.ts` `openDm`: an active person the viewer may reach; a guest and the people of their places
    only, both ways, `auth/guests.ts` `sharesPlace`, and the directory is filtered by the same rule, `reachFilter`). So
    the button never fails, for a guest looking at a member and for a member looking at a guest. Anyone else has no
    card and their photo and name are not buttons: an account that is gone, the AI, and an app (an app's name keeps
    its own small menu, "Set up by …").
  - **How it opens:** the shared menu (`rooms/MenuButton.tsx`, new `body`, `bare`, `inline`, `closeOnScroll`): on a
    computer a popover under the photo or name, their left edges in line; Esc, a click outside or a scroll closes it
    and the keyboard goes back to where it was; Enter or Space opens it and the keyboard lands on the button. On a
    phone it is the menu's bottom sheet.
- **Why:** the 1:1 chat existed, but the only way to it was **New conversation** and a search. The person in front of
  you is the shortest way. One button, because the card answers one question ("how do I talk to them?"); a profile
  page, a call button or status editing would be a second place for things that have a place already.
- **Left out:**
  - The faces of a message's "3 replies" line stay part of that one button (it opens the thread, where each photo
    opens the card). They are 18px and sit inside a button: three more targets there would be mis-tapped on a phone.
  - No card for people outside the directory (a name-only card would be a card with nothing to do).
  - The same card on the AI chat's shared-chat faces, the search results and the Activity page: later, with
    `PersonButton`.
- **Tests:** `web/test/unit/person-card.test.tsx`, `web/test/e2e/person-card.spec.ts` (photo, name, mention, member
  list, yourself, an app and a gone account, a guest both ways, the keyboard, a phone's sheet).
- **Version impact:** patch. Web only; no API or data change.
