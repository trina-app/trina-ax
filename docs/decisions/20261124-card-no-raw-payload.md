# A confirm card never opens on raw JSON, code or a long payload

- Date: 2026-11-24
- Status: accepted
- Supersedes: the "a text with marks stays open" line of the `folded` detail (ConfirmDetail)
- Branch: fix/card-no-raw-payload (0.16.0 final gate: a 6,935-character JSON open on a card; the owner: "코드를 보여주면 뭐 어케 하라는거냐")

- **Ask:** never show raw JSON, code or long payloads by default, on any card.
- **Rule:** the web card judges each detail by its shape. Raw JSON, markup and code fold behind 자세히 with their label, size and a one-line summary; long prose shows its start. Still in view: recipients (short values and lists of names), every email address and web host in the payload, long random-looking values, red alert lines, and a message formatted for reading.
- **Why:** a person decides from where it goes and what it is. Random-looking values kept the whole text open so that they could be seen; now they are shown on their own.
- **Left out:** the phone app's card; the diff on a change to an existing skill stays in view.
- **Version impact:** patch.
