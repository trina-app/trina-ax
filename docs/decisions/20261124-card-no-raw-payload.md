# A confirm card never opens on raw JSON, code or a long payload

- Date: 2026-11-24
- Status: accepted
- Supersedes: none
- Branch: fix/card-no-raw-payload (0.16.0 final gate: a 6,935-character JSON open on a card; the owner: "코드를 보여주면 뭐 어케 하라는거냐")

- **Ask:** never show raw JSON, code or long payloads by default, on any card.
- **Rule:** the JSON of a connected service's call (the server marks it `callJson`; not a call that runs code) folds behind 자세히, with its label, size and plain lines read from it: every key and value, a long value by its start plus any address found further on. If it does not round-trip exactly or has more than 60 lines, it stays open. Nothing else folds by its shape: a file's content, a scheduled task's instruction, a message, a script and text cut short stay as the server sent them.
- **Why:** raw JSON on a card is always a call's arguments, so that is the one place to fold. Guessing from the text's shape on other cards hid instructions an AI would run.
- **Left out:** the phone app's card; the diff on a change to an existing skill stays in view.
- **Version impact:** patch.
