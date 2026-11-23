# A confirm card never opens on raw JSON, code or a long payload

- Date: 2026-11-24
- Status: accepted
- Supersedes: the "a text with marks stays open" line of the `folded` detail (ConfirmDetail)
- Branch: fix/card-no-raw-payload (0.16.0 final gate: a 6,935-character JSON open on a card; the owner: "코드를 보여주면 뭐 어케 하라는거냐")

- **Ask:** never show raw JSON, code or long payloads by default, on any card.
- **Rule:** only sure machine text folds: JSON, markup, a script, or what the server marks as code. It folds behind 자세히 with its label, size and plain lines of its short values and every destination (email, address of any scheme, IP, phone), read from the parsed values. If those are too many to be a summary, the card shows it as before. Long prose shows its start only when no destination or marked value would go out of view. Lists of names, red alert lines and messages formatted for reading never fold.
- **Why:** a person decides from where it goes and what it is. Random-looking values kept the whole text open so that they could be seen; now they are shown on their own.
- **Left out:** the phone app's card; the diff on a change to an existing skill stays in view.
- **Version impact:** patch.
