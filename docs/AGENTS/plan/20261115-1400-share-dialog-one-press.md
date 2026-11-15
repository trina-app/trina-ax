# Share in one press: the warning shows while picking, and only when something real is at stake

- Date (UTC): 2026-11-15 14:00
- Branch: `feat/share-dialog-one-press`
- Status: draft
- QA: TC-3092
- Where: Team AX core (`server/src/chat/{people-share,share-chat,widening,answer-share}.ts`, `server/src/routes/chats.ts`,
  `shared/src/api/chats.ts`, `web/src/components/chat/{ChatShareDialog,ShareChat}.tsx`, a new shared
  `web/src/components/ShareWarning.tsx`, `web/src/components/{ProjectMembersDialog,WideningList}.tsx`,
  `web/src/i18n/*`, `web/test/mock/server.ts`, `docs/site/use/chats-and-projects.md`, `docs/DECISIONS.md`). Why: chats,
  sharing and permissions are core (docs/REPOSITORY-RULES.md).
- Version impact: **minor**. A visible flow changes, there is one new endpoint and new optional response fields. No
  migration.

## Goal

The owner's decision of 2026-11-15, which is final and is designed here, not reopened.

**Today.** You add a person and press **Share**. The server answers `confirm` and the warning appears. The button changes
to **Share anyway**, so you have to press a second time. The warning is vague: "Not everything this chat used is known"
and "Some answers may have used your personal memories".

**Wanted.** One press, as in Google Drive's inline warning when you add someone from outside:

- The dialog checks as soon as a person or group is added. The warning appears inline, before any press, and only when
  something real is at stake:
  - (a) answers that used the sharer's personal memories;
  - (b) answers or files that the new people could not open before. This is the existing widening logic.
- The warning is specific: "2 answers may have used your personal memories" or "3 answers used files Mina can't open".
  Clicking it shows those answers (the existing widening list).
- When nothing is at stake, or only unknowns are found, there is no yellow box: at most one small grey line, and a normal
  Share button.
- The button keeps its normal colour and label in every case. Pressing Share is the confirmation.

This supersedes the DECISIONS.md line "The check comes on Save, not while picking"
(feat/shared-chats-p4, 2026-11-14).

**Non-developer check:** "Mina can't open 3 answers' files. Show answers." A colleague understands that in 3 seconds,
which is not true of "Not everything this chat used is known".

## Where the warning comes from today

- `PUT /api/chats/:id/audience` (`server/src/chat/people-share.ts putChatAudience`) runs the check only on Save, for the
  people who would start to see the chat:
  - `chatUse` and `provenanceChecker` (`answer-share.ts`) look at every branch's `message_sources` files (with sha256)
    and at the chat's read-scope sources when the scope describes every answer. The result is `missing` (who can't
    open something), `places` (named only where the sharer may look) and `unknown`.
  - `memoriesInPlay` (`share-chat.ts`) is one boolean for the whole chat. It is true if any answer was written while the
    person had a memory, or if one was deleted since.
  - `hiddenAnswers` = `chatWidening(...).total` (`widening.ts`): answers whose recorded places
    (`shared_answer_reads`) a new person can't open. A private chat has no records yet, so a first share always gets 0
    here and only the vague provenance line.
  - `earlierFiles`: on a first share, the creator's computer uploads that get copied into the chat.
- If anything applies, the server answers `{status:'confirm', …, confirmKey}`. `confirmKey` is a `confirmMac` over the
  chat, subjects, new people, sources, places, unknown, memories, hiddenAnswers, earlierFiles and every message id. The
  client shows the lines and the label becomes **Share anyway** (`ChatShareDialog.tsx`, `chat.share.shareAnyway`). The
  second PUT sends the key back. A key that no longer matches gets `confirm` again with `reason:'changed'`.
- Every PUT takes a room-send token, so the check is not a free probe of who may read what. This is why the check
  currently runs only on Save.
- The project Members dialog already runs a dry run while you pick: `useAccessCount` calls
  `POST /api/projects/access-preview` 400 ms after the last pick (`previewLimit`, 60 a minute) and gets `hiddenAnswers`.
  That is the pattern to copy.

## What "unknown" means today, and the decision

`BranchUse.known` is false, and `prov.unknown` is true, when any of these hold:

1. The read scope does not describe every answer. The scope empties when a session starts on a first message, so answers
   from before the newest first answer have no scope.
2. The chat is confidential.
3. An answer ran dev environment commands (`box_shell`).

`roomsUnseen` (the chat read room messages and the scope doesn't say which) and an unfinished turn feed the same flag.
When the flag is set, everyone new counts as "missing", which produces "N people can't open some of what this chat used"
plus "Not everything this chat used is known".

**Decision (owner, 2026-11-15):** unknown alone puts nothing at stake that we can name, so it **does not warn**. It shows
as one grey line, "{n} older answers couldn't be checked", with the count of answers in cases 1, 3 and `roomsUnseen`.
The Share button stays normal.

Nothing changes on the safety side:

- The answers are still recorded with `x: 1`. Later readers are still judged conservatively (`shared-answers.ts`).
- The `share_hidden` refusal stays.

## Design

### Server

1. **One check function.** Pull the check out of `putChatAudience` into
   `audienceCheck(ctx, rt, userId, a, wanted, locale)` → `{ newPeople, check, key }`. The preview and the PUT both call
   it, so what is shown and what is enforced cannot drift apart. It computes these values for the new people only:
   - `memoryAnswers`: the ids of answers from the chat's **private period** that were written while the person had a
     memory. That is the same test as `memoriesInPlay`, applied per answer and only to turns from before
     `people_shared_at` and `shared_at`. Shared turns never get memories, which fixes the over-warning on a re-share.
   - `fileAnswers`: answers whose own `message_sources` files some new person can't open (by sha256 rules, as now),
     joined with the existing recorded-places answers (`hiddenAnswers`) into one set of distinct answer ids. The list
     shows the same set (step 3), so the count and the list match.
   - `otherPlaces`: read-scope sources (a room, a connection, a shared Drive, the in-app browser) that a new person
     can't open. They can't be tied to single answers, so they are named and not counted: "This chat also used Sales
     Drive, which Mina can't open".
   - `unchecked`: the count of unknown answers, for the grey line only.
   - `earlierFiles`: unchanged, shown as a grey line.
2. **Preview endpoint** `POST /api/chats/:id/audience/preview` `{ subjects }` → `ChatAudiencePreview`
   `{ added, memoryAnswers: n, fileAnswers: n, places, otherPlaces, unchecked?, earlierFiles?, names, previewKey }`.
   - Only the creator may call it (403 `chat_share_creator_only` to others who see the chat, 404 to everyone else).
     It applies the same `changeable` and `checkNewSubjects` refusals as a save.
   - It saves nothing and is not audited.
   - It uses the **dry-run limit `previewLimit` (60 a minute)**, not the room-send token, exactly as the project dry run
     does. The dialog debounces for 400 ms (`ACCESS_COUNT_DEBOUNCE_MS`).
   - Security review must accept this probe budget, as it did for `previewProjectAccess`. The preview reveals nothing a
     save's confirm doesn't reveal already.
3. **Widening list for a private chat.** In `widening.ts`, for `target.kind === 'chat'`, an answer with no
   `shared_answer_reads` record uses its own `message_sources` files as its places. A first share then lists real
   answers too. `WideningAnswersBody` gets `memories?: true`, which adds the `memoryAnswers` ids. Each item gets
   `usedMemories?: true`, so its row can say "May have used your memories". The bench
   (`b-widening-answers-bench.test.ts`) must stay within 300 ms.
4. **The server still refuses an unpreviewed widening save.**
   - The PUT body keeps `confirmKey` (the preview's `previewKey` is the same MAC), with the version raised to 2. The
     MAC now also covers `memoryAnswers`, `fileAnswers`, `otherPlaces` and `unchecked`.
   - **New rule:** an add that brings in new people must always carry the key of the current check, whether or not
     anything applies. The old rule asked for a key only when something applied.
   - No key, or a stale key (a new message, a rule change, someone joined a picked group, a different list of people):
     the server saves nothing and answers `confirm`, now including the full preview fields, with `reason: 'changed'` or
     `'unchecked'`.
   - Removals alone still save at once.
   - The PUT keeps its room-send token.
5. **Project chats** (`POST /api/chats/:id/share`, `ShareChatFlow`): the `confirm` there gets the same specific fields
   from the shared counting (`memoryAnswers`, `fileAnswers`, `otherPlaces`, `unchecked`). That dialog already opens
   first from the menu, so its **Share** is already the one press. Only its lines change.

### Web

A new shared `ShareWarning` component, used by the chat Share dialog, the project chat share and the project Members
dialog's widen line, with one look in all three.

- The yellow box (`bg-warn-soft`) appears only when `memoryAnswers + fileAnswers > 0` or there are `otherPlaces`. It
  holds at most two sentences and one **Show answers ›** link that opens the existing `WideningList` (now also listing
  memory answers).
- Otherwise there is no box, only at most **one** grey line, picked in this order: unchecked, then earlier files, then
  the future-group note.
- The fixed note stays (`noteShort` when the box shows).

`ChatShareDialog`:

- When the picks bring in someone new, wait 400 ms, then call preview. A newer pick drops an older answer (sequence
  number, like `useAccessCount`). Removals and no-new-people make no call.
- **Loading:** after 300 ms the space where the warning goes shows a grey "Checking what they'll see…" line. Share is
  disabled until the answer comes, so nobody can share past a warning they never saw (the bench makes this ≤ 300 ms).
- **Ready:** the warning or grey line shows, and **Share**/**Save** stays the normal primary button. One press sends
  `confirmKey = previewKey`.
- **Preview failed** (offline, 5xx, 429 after its retries):
  - A grey line: "Couldn't check this chat yet. You'll see what's at stake before it's shared."
  - Share stays enabled. Pressing it sends no key, so the server answers `confirm`. The dialog shows that answer inline
    (box or grey line, as above) with a status line: "Check this, then press Share again."
  - This is today's confirm step, kept only as the fallback. It never shares silently. The label stays "Share".
- **Stale preview:** the PUT answers `confirm` with `reason:'changed'`. The new lines replace the old ones in place,
  `chat.shareChat.changed` shows above them, and the same Share button is pressed again.
- **Roles:** only the creator edits and previews. Someone else's shared chat stays read-only, with no call. A member can
  add only their own groups; owners and admins can add any group. Guests are never offered. Admins who aren't the
  creator see the read-only view, as now.
- **Phone, 390 px:** the bottom sheet, with a full-width box and **Show answers ›** wrapping under the text. The
  wrapping trick for the long "Compartir de todos modos" label is no longer needed and is removed.
- **Dark mode:** uses the existing `warn`/`warn-soft`/`faint` tokens, with no new colours.
- **Screen readers:** the existing `aria-live` line reads the warning when it changes.

**Every place a person or group is added:**

| Place | Change |
|---|---|
| Chat outside projects (Share…) | The full flow above |
| My private chat in a team project (Share… → members) | Specific lines and the grey unknown line; still one press |
| Project Members dialog (adding people or groups) | The widen line becomes `ShareWarning` (memory answers don't apply: shared project chats never use memories). Its folder-access save confirm (`confirmMembers`) is a different decision (file access) and stays; its duplicated widen line is removed because the warning is inline |
| A group picked in any of these | The preview counts its members now; the future-group note is the grey line |
| Admin › Groups (someone joins a group) | No warning. Silent widening was accepted on 2026-11-14 (d) |

**Copy, English first** (`en.ts`; then ko, id, ja, es, zh):

- `share.warn.memories`: "{n, plural, one {# answer} other {# answers}} may have used your personal memories."
- `share.warn.files`: "{n, plural, one {# answer} other {# answers}} used files {names} can't open."
- `share.warn.places`: "This chat also used {places}, which {names} can't open."
- `share.grey.unchecked`: "{n, plural, one {# older answer} other {# older answers}} couldn't be checked."
- `share.grey.checking`: "Checking what they'll see…"
- `share.grey.failed`: "Couldn't check this chat yet. You'll see what's at stake before it's shared."
- `share.again`: "Check this, then press Share again."
- `share.widenList.usedMemories`: "May have used your memories"
- The existing `share.widenList.*`, `chat.share.earlierFiles`, `futureGroup` and `chat.shareChat.changed` stay.

## Removed

- The **Share anyway** step and label: `chat.share.shareAnyway` in all six languages, the label switch, and the phone
  wrapping trick for it.
- The vague lines `chat.shareChat.unknown` ("Not everything this chat used is known") and `chat.shareChat.memories`
  ("Some answers may have used your personal memories"), plus `chat.share.warn`/`warnPlaces` and
  `chat.shareChat.provenance`/`provenanceNoPlace`. The new keys replace them; `check:i18n` catches leftovers.
- The yellow box for unknown-only and for no-stake cases.
- The `memories: boolean` on the confirm, replaced by the count. The old field is dropped because the web is served by
  the same server.
- The DECISIONS.md rule "The check comes on Save, not while picking". It gets a new entry that says it was superseded.
- The "Share anyway" text and screenshot in `docs/site/use/chats-and-projects.md`, which are rewritten and reshot.

## Steps

1. Server: `audienceCheck`, per-answer memories and files, the key v2, the "always a key for new people" rule, and the
   preview endpoint with its contract in `shared/src/api/chats.ts`.
2. Server: the widening list for a private chat (synthetic records) and `memories`. Keep the bench green.
3. `shareChat` (project chats) returns the same specific fields.
4. Web: `ShareWarning`, the `ChatShareDialog` preview hook and states, `ShareChatFlow` lines, and the Members dialog
   widen line. Mock server endpoint.
5. i18n: six languages, English first.
6. Docs: DECISIONS.md entry, `docs/site/use/chats-and-projects.md` with a new screenshot (`bun run docs:reshoot`),
   `changes/share-dialog-one-press.md`.
7. Independent security review (the probe budget, the key rule, unknown → grey) and a product reviewer who cuts.
   Neither is the author.

## Risks

- **Probe:** preview at 60 a minute instead of on the room-send budget. It reveals the same counts and places the confirm
  does. This needs the security reviewer's sign-off, as `previewProjectAccess` got.
- **Unknown no longer warns:** this is an owner decision, and the conservative `x: 1` record and the `share_hidden`
  refusal remain. The review should confirm that `roomsUnseen` counted as unknown is acceptable.
- **Key rule tightened:** an old tab that saves without a key now gets one `confirm` round. That is acceptable and
  intended.
- **Count and list must match:** both come from one set of answer ids. Tests assert they are equal.
- **Speed:** the per-answer file check walks `message_sources` once per preview. Each distinct place is checked once
  per person set, as in `widening.ts`.
- No migration (highest on dev: `701_g_retention_indexes.sql`). Phone and desktop share the web UI.

## Tests

- **Server unit** (`b-share-chat-people.test.ts`, `b-widening-answers.test.ts`, `b-share-existing-chat.test.ts`):
  - the preview counts memory answers (private period only, not after the share) and file answers (first share and
    re-share);
  - count = list total;
  - unknown-only → `unchecked` and no stake;
  - `roomsUnseen` → unknown;
  - one PUT with the preview key saves;
  - no key with new people → `confirm`;
  - a stale key after a new message, a rule change or someone joining a picked group → `confirm` `changed`;
  - removals save without a key;
  - preview 429 past 60 a minute;
  - non-creator 403/404;
  - nothing is saved or audited by a preview.
  - The bench stays ≤ 300 ms with the private-chat records.
- **Security** (`tests/security/lib/cases.ts`, `people-shared-chats.test.ts`): the preview endpoint's matrix (creator,
  person in it, group member, admin outside, member outside, removed, anonymous) and the key rule.
- **Web unit** (`chat-share-dialog.test.tsx`, `share-chat-count.test.tsx`, a new `share-warning.test.tsx`):
  - pick → debounced preview → inline warning → one press sends the key;
  - no stake → no box and a normal button;
  - unknown → one grey line;
  - loading disables Share;
  - failed → grey line → press → inline confirm → press again;
  - stale → changed line;
  - a newer pick drops an older preview;
  - the label is never "Share anyway";
  - Show answers opens the list, including memory answers.
- **E2E:**
  - `share-chat-people.spec.ts`: one-press share with a warning, with no warning, and the list from the warning, at
    1440 and 390, light and dark;
  - `share-existing-chat.spec.ts`: the project chat wording;
  - `members-widening-list.spec.ts`: the shared component.
  - The full web e2e runs because a shared component and the server contract change.
- **Checks:** `bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run test:unit`. Server tests run
  under Bun 1.3.12.
- **QA sheet:** TC-3092 plus one row per case above (every role at 390/1440, light and dark, six languages), each
  brought to Pass after the dev merge.

## Result

Filled in at the end.
