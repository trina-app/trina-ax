# One message box everywhere: the shared composer shell

- Date (UTC): 2026-11-26 10:26
- Branch: `feat/composer-shell` (stacked on `fix/side-chat-stop`, PR #643, which adds `chat/StopButton.tsx`)
- Status: in progress
- Where: web (`web/src/components/composer/` new, the four boxes that move onto it). Why: a UI consistency change of
  one surface type, no server change (see docs/REPOSITORY-RULES.md)
- Version impact: minor. Visible changes in four message boxes (the + menu, round send, Esc stops, mic in answer
  threads, kept drafts, the key warning in rooms); no API, data or permission change

## Goal

The owner asked for one composer managed in one place ("컴포넌트화, 공통관리"). Today four boxes are written four
times and each drifted: only the full chat stops with a button (the side chat since #643), none stops with Esc, the
attach button is a `+` menu in one box and a 📎 file dialog in two, the send button is a grey square in the full chat
and a round accent button elsewhere, the side chat's text is smaller and sends on a phone's Return with no IME guard,
the key/password warning runs in one box only, drafts are lost on reload (side chat) or close (answer threads), the side
chat says a failed send only in a toast, and its limit notice and "no usable AI" line are copies.

After this, every box looks and behaves the same, and a surface turns features on with props.

## The four boxes

| | A `chat/Composer.tsx` | B `rooms/SideChatPanel.tsx` box | C `rooms/RoomComposer.tsx` | D `chat/ChatThreadPanel.tsx` ReplyBox |
|---|---|---|---|---|
| Where | private, shared, project chats; Home | ✦ side chat | rooms, DMs, room threads | threads under an AI answer |

## What the shell owns (`web/src/components/composer/`)

- **`ComposerShell.tsx`**: the frame (`composerRadius`, one border, one focus edge, the drop highlight), the layout
  (the text on top and the row under it, `ComposerToolbar`; or a phone's one line: attach · text · mic · send), the
  recording layout (`VoiceBar`, `VoiceHeld`, `VoiceProgress`, `VoiceLive`), the row's end (mic, then Send / Queue /
  Stop), the slots above the text (`top`: chips, quote, hold line, file list) and above the frame (`above`: the key
  warning, the AI band, a quote card), and the notices under it (`ComposerNotices`).
- **`ComposerField.tsx`**: the one text field: a plain `<textarea>` or, with mentions, `TokenTextarea`; one font
  (`text-reading leading-reading`), one height (grows to 240 px on a computer; on a phone the whole box within about
  35 % of the screen, the existing QA TC-252 rule), one key handler: the surface's menus first (`/`, `#`, `@`), then
  voice (Space held, Esc while recording), then **Esc stops** the running answer when the box has Stop (never while an
  input method composes, a menu is open or a recording runs; it then stops the event so a panel's Esc does not also
  close the panel), then **Enter**: sends with a keyboard; Shift+Enter, an input method composing (`isComposing` or
  keyCode 229) or a touch screen (`pointer: coarse`) make a new line, as decided for phones ("Enter makes a new line
  there"). One function, `enterSends(e)`, used by every box (also the room's edit mode).
- **`AttachMenu.tsx`**: the `+` everywhere. A computer: the small menu (this computer · team files); a phone: the
  attach sheet (`AttachSheet`: photos, camera, files, team files). It holds the hidden file inputs and the
  `TeamFilePicker`. Props: `onFiles`, `onTeam` (absent: no team row), `computer` (false: team files only), `room`,
  `fileMax`, `off` (a reason: the button says it and does nothing, the room's project read-only case).
- **`ComposerButtons.tsx`**: `SendButton` (round accent, ↑; `kind` send / answer (답하기) / later (the clock, "Send when
  ready")), and `StopButton` from #643 reused as it is. Same size in every box (36 px, 40 px under 640 px).
- **`useSecretGate`** (on `useSecretHold`): every send of every box is checked; the warning shows above the frame.
  Wording by audience: AI boxes keep `composer.secretWarning` ("goes to the AI company …"); rooms and answer threads
  get `composer.secretWarningPeople` ("Everyone here can read it, and it stays in the conversation. …"), 6 languages.
- **Drafts** (`lib/localData` readDraft/writeDraft, the one store already used by A): `useKeptDraft(key)` for B
  (`side:<roomId>`, across reloads; still one draft per room for every panel of it) and D (`thread:<chatId>:<rootId>`).
  A keeps its own keyed draft; C keeps `store/rooms` drafts (they already survive reloads and sync between tabs).
- **`ComposerNotices`**: under the frame, in one order: demo used up, the usage-limit notice (`CalmNotice`,
  `CirclePause`), the mic blocked notice, the send failure kept in the box ("보내지 못했어요 · 다시 보내기",
  `conn.unsent` + Retry; "Trina is updating" sends by itself once back), a plain error. B uses it in place of its
  toasts for send failures and its copy of the limit notice.
- **AI band**: `aiBand` prop renders `AiAccessBanner` above the frame for every AI box (A from pages/Chat.tsx as
  today; B for everyone without usable AI, not only guests).
- **Placeholder and disclaimer**: `composerHint()` picks the line once: transcribing › answering the AI's question ›
  waiting for the answer (`outbox.placeholder`, `outbox.placeholderChoice` when a card waits for a choice) › the
  surface's own. The footer (`chat.footerAi` + who sees it) on a computer; a phone shows who sees it only. B drops its
  own `sideChat.disclaimer` for `chat.footerAi` (its header already says "Only you").

## Before → after per surface

| | Before | After |
|---|---|---|
| Stop | A; B since #643; C, D none (no AI answer to stop) | A, B: StopButton + **Esc**; shared chats: only the asker (unchanged: A's `running` is the asker's turn only) |
| Attach | A `+` menu; B, C 📎 → file dialog (team files on phones only); D none | A, B, C: the same `+` menu with team files on computers too (C copies a team file as it already does on phones); D none (a reply has no files, decided in 20261116-chat-answer-threads) |
| Mic | A, B, C | A, B, C, **D** (the thread's chat id: `assertVoiceChat` takes a shared chat I see) |
| Touch Return | B sends at once, no IME guard | new line everywhere, the button sends |
| Send button | A grey square at 1440 | round accent everywhere |
| Height, font | A 240, B 160 `text-sm`, C/D 200 | 240 px and `text-reading` everywhere; phones the 35 % rule |
| Phone layout | A plain: one line; B two rows; C one line; D two rows | A, C, D one line; B two rows (kept, decided in 20261117-side-chat-mic); any box with more than + and send in its row (A's picker or tools) stacks |
| Waiting line | differs A/B | one helper |
| Footer | differs A/B | `chat.footerAi` (+ who) for AI boxes; none in rooms and threads (as today) |
| Queue | A clock beside Stop; B the same since #643 | one `SendButton kind="later"` beside Stop |
| Key warning | A every send; B answers only; C, D never | every send, every box, wording by audience |
| Drafts | B lost on reload; D lost on close | kept (localStorage, per person) |
| Send failure | B toast; A calm row | the calm row in A and B; C, D keep their per-message "send again" |
| AI band | B guests only | every AI box |
| Limit notice | copy in B | `ComposerNotices` |

## Kept different, and why

- The side chat queues while its answer runs and has the mic (20261118-side-chat-queued-sends, 20261117-side-chat-mic);
  its phone box keeps two rows (same decision).
- No "Send to Trina" in answer threads (20261118-thread-no-send-to-trina), and no files there (a reply has none).
- Shared chats: Stop only for the person whose turn it is (owner decision; the server enforces it too).
- No "@" in AI chats' main box (20261122-ai-session-no-main-mention): `@` stays a room/thread-only prop.
- The model picker, "/" skills and "#" rooms stay A-only props (opt-in, not separate code); the "@전체" question, the
  link choice, the typing line and the phone edit mode stay C's own slots.
- Esc closes a panel where panels cover the room (20261117-thread-plus-trina): unchanged, except that Esc in a box
  whose answer runs stops it first (the next Esc closes the panel).

## Steps

1. Plan (this file); independent review; apply it.
2. `components/composer/`: shell, field, attach menu, buttons, notices, `useKeptDraft`, `composerHint`; unit tests.
3. Move A, then B, then C, then D onto it; delete their copies (attach menus, send buttons, Enter handlers, notices).
4. Guard test `web/test/unit/composer-single.test.ts`: every `<textarea>`/`TokenTextarea` in `web/src` is listed with
   why (forms, the inline edit fields, the ask card), and only `components/composer/` draws a message box: uses of
   `useVoiceInput`, `VoiceMic`, `ComposerToolbar` and `AttachSheet` outside it fail. `device-pick.test.ts` KNOWN: the
   three file inputs become `components/composer/AttachMenu.tsx`.
5. i18n: `composer.secretWarningPeople` (6 languages); `sideChat.disclaimer` removed.
6. e2e `web/test/e2e/composer-shell.spec.ts`: each surface at 1440 and 390, light and dark: the round send, the `+`
   menu (team files row), Esc stops (A, B), touch Return makes a new line, the key warning, the kept draft (B reload, D
   close and open), the mic in D. Run the related specs: composer-*, side-chat*, chat-threads, rooms, phone-composer-
   keyboard, phone-attach-sheet, voice.
7. Decision file `docs/decisions/20261126-one-composer.md`; `changes/composer-shell.md`.

## Decisions

Made here (recorded in the decision file): Esc in the box stops (box focus only, not page-wide); touch Return is a new
line everywhere; one height 240 px; team files on computers in rooms and the side chat; key warning in people boxes
with its own wording; side chat footer is `chat.footerAi`.

## Risks

- A large refactor of the most used surface: every existing test id is kept (`composer-input`, `send`, `stop`,
  `side-chat-*`, `room-*`, `chat-thread-*`), and the related unit and e2e suites run before the PR.
- Conflicts with PR #634 (model and effort picker in `Composer.tsx`) and packages B and C: the picker stays in A's
  code (passed into the shell's `end` slot); no menu or long-press code is touched.

## Tests

`bun run typecheck`, `bun run check:prepush`, web unit suite, the e2e above.

## Result
