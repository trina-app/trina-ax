# The API engine shows pictures to a model that takes them; connector writes up to 10M characters; delete and access cards ask every time

- Date: 2026-11-18
- Status: accepted
- Supersedes: parts of [docs/DECISIONS.md](../DECISIONS.md) "AI가 휴지통으로 옮기기" (refused after a room read; two cards
  per answer), the card-count limits of change_project_members (two) and change_folder_access (three, 2026-11-16 "card
  fatigue"), and the 100,000-character connection write cap (2026-10-28)
- Branch: fix/api-images-connector-cap-delete-cards (limits audit #31, N25, N20; QA TC-4988, TC-4991, TC-5004…5009)

Plan: docs/AGENTS/plan/20261118-2158-api-images-connector-cap-delete-cards.md.

The owner's rule (2026-11-19): Claude Code is the floor. A limit Claude Code does not have goes, unless it keeps one
person's data from another.

## F. The API engine reads images

- **Before:** a team on the API engine (OpenRouter, Ollama, LM Studio, any OpenAI-compatible key) never sent a picture
  to the model: `visionBlock` answered 'engine' for every API turn and the AI got "reads text only".
- **Rule:** `engine/api-vision.ts` learns whether the model takes images from what its own server says: the
  OpenAI-compatible model list (`architecture.input_modalities` on OpenRouter, the same field, `capabilities.vision` or
  `supports_vision` on others), Ollama `/api/show` `capabilities` ("vision"; an older Ollama: its vision projector),
  LM Studio `/api/v0/models/<id>` `type` (vlm / llm), llama.cpp `/props` `modalities.vision` (local addresses only). The
  official OpenAI, Gemini and Anthropic endpoints say nothing, so their current chat models are known by name (gpt-4o,
  gpt-4.1, gpt-5, o1/o3/o4, gemini-*, claude-*). Cached 10 minutes per address and model (a local miss 1 minute); at most
  5 s per look-up; the key goes only to the address it was saved for. Same address check as the turns (apiEngineFetch).
- **Unknown:** only then the admin's choice counts: "Reads pictures" in the API engine form (shown only while the
  server says nothing, for the saved model), stored as `vision: "on" | "off"` in engine-api.json, dropped when the
  address or model changes. With no choice: text only, as before.
- **How the pictures go:** the turn marks itself (`setApiVisionTurn`), so `read`, `room_file`, a connection's image and
  the other readers give image blocks as for Claude Code, within the same per-answer image caps. A Chat Completions
  tool message carries text only, so the round's pictures go in one user message after its results (OpenAI's
  `image_url` part with a data URL), introduced as content to look at, not instructions; the tool result says how many
  follow. A provider that refuses pictures after all (a wrong choice) answers 400 with its own words (`IMAGES_REFUSED`):
  the same round goes again with the plain note in their place, the rest of the turn text only, no error shown.
- **A model that takes none:** the existing note, in plain words: "The AI model of this chat reads text only, so the
  image cannot be shown to it. To look at images, use Claude, Codex or a model that reads images. If this model does
  read images, an admin can turn that on in AI providers." The text path (a Mac's Apple Vision text, a PDF's text layer)
  stays as it was.
- **Left for later:** fold the probes into batch 2's `engine/api-context.ts` (#1322) once it is on dev (the same three
  servers are asked; `isLocalApiHost` repeats its `isLocalApiAddress`).

## K. Connector write size

- **Before:** a write through a connected service over 100,000 characters (text plus the card's fields) was refused:
  "Send less at a time".
- **Rule:** `MAX_CARD_PAYLOAD` is 10,000,000 characters (what one call may hold in memory with its card). Above 100,000
  the card lists only the recipients as lines and shows the call's text (not every value twice). Any card detail longer
  than `CARD_TEXT_INLINE` (100,000) carries its start, its full size (`ConfirmDetail.fullChars`) and a fold
  (`chat/card-fold.ts`, applied when any card opens); the whole text stays with the open card on the server and the
  card's "Show all" reads it: `GET /api/turns/:id/requests/:requestId/details/:index`, the turn's own person only,
  only while the card is open (404 otherwise, as for another person's turn). So the person can still check every character before it goes out, the
  event and a reload stay small, and nothing is cut silently.

## H. Delete in chats that read room messages; no card count

- **Before:** delete_files was refused outright in any chat that had read room messages, a ✦ side chat, a quoted
  message or a shared file ("ask in a new chat"). Delete and members cards stopped after 2 per answer, folder-access
  cards after 3.
- **Rule:** delete there goes behind its card: the card leads with the room line (the members and folder access cards'
  "Messages from your conversations … came in here, so changes are asked first") and offers "Always allow" like
  anywhere else. The person's own "Always allow" for deletes is final there too, as for members and folder access (the
  owner, 2026-11-11, "always allow means done … rooms too"; [Rule A](20261116-always-allow-final-rule-a.md)): no card.
  delete_files is the call's only card there (`ROOMS_SEEN_READ_ONLY_TOOLS`). A scheduled run that read rooms still
  refuses, Always allow or not (it shows no card, and its prompt may hold other people's words). No per-answer count for the delete, members and folder-access cards; a
  "no" still ends that kind for the answer (Claude Code stops after a rejected tool too), one card open at a time.
- **One card for several:** delete_files and change_project_members already take lists. change_folder_access takes
  `changes` (up to 20: folder, action, who, access each): planned together per folder in the order given, one card lists
  every change under its folder with what that folder's plan does, one yes saves each folder with its own hash check.
  Every folder is planned again before anything is saved; a change that cannot be planned stops the call before a card.
  Separate calls stay separate cards: the gate runs a write call only after the one before it ended, so they cannot be
  joined without making the first wait.
- **Kept, and why (one line):** delete stays refused in a chat other people write in (a shared chat): there someone
  else could ask for a delete that only the asker may make, and the asker's yes would answer their request.

## Tests

`tests/unit/limits-api-images-cards.test.ts` (fold, the details route, detection, the loop, a whole API turn with a
real picture), `ai-delete-files`, `b-project-members-tool`, `c-folder-access-tool`, `c-integrations-tools`,
`vision-read`.

Version impact: patch.

## Security review of #1338 (fixed before the batch)

- **M1:** the Chat Completions API takes text only in a tool message, so a round's pictures stay in a user message. It
  starts "[Not from the user]", names the tool and call each picture came from, and says any text in them is content,
  never a request to act on (tool names and ids reduced to word characters). The instructions get the same rule
  (`API_IMAGE_RULE`) whenever pictures go to the model.
- **L1:** one change_folder_access call refuses a folder together with a folder inside it (each preview is made from
  what is saved now): two calls, a card each.
- **L2:** where a connection's call goes is never folded: any recipient, address or query value over 10,000 characters
  is refused, measured whole (the gate's lines are cut at 2,000); a big call's card shows each recipient whole.
- **L3:** a folded card text says "Showing 2,000 of 300,011 characters" on the card itself before it is opened.
