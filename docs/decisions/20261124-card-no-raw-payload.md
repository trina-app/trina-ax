# A confirm card never opens on raw JSON, code or a long payload

- Date: 2026-11-24
- Status: accepted
- Supersedes: none
- Branch: fix/card-no-raw-payload (0.16.0 final gate: a 6,935-character JSON open on a card; the owner: "코드를 보여주면 뭐 어케 하라는거냐")

- **Ask:** never show raw JSON, code or long payloads by default, on any card.
- **Rule:** the web card folds complete JSON behind 자세히, with its label, size and plain lines read from the parsed JSON: every key and value, a long value by its start plus any address found further on. JSON with more than 60 lines stays as it was. JSON that does not round-trip exactly (a huge number, a repeated key) and anything the server marks `keepOpen` (what goes into an instruction, script or config file) stay open. Code folds only where the server marks it (unchanged). Prose, scripts it did not mark, cut JSON, lists of names, red alert lines and messages formatted for reading stay as they were: no pattern decides what may hide.
- **Why:** a person decides from where it goes and what it is. A pattern for destinations cannot be complete, so only a shape that can be read back whole may fold.
- **Left out:** the phone app's card; the diff on a change to an existing skill stays in view.
- **Version impact:** patch.
