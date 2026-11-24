# A picture is placed, looked at and moved, with no mark rules

- Date: 2026-11-24
- Status: accepted
- Supersedes: [20261123-signing-slots.md](20261123-signing-slots.md)
- Branch: feat/place-picture (the owner: "저런거 말고 좀더 general 하게 고치고 싶은데", "파인튜닝은 절대 금지야. root를 해결하자")

- **Ask:** put a picture anywhere the person wants, the way Claude Code would, instead of more seal logic.
- **Rule:** Word (edit_office `insert_picture`) and Hangul (edit_hwp's image change) take a text, a table cell, or
  x/y mm. In Hangul that is x/y on a page number; in Word it is x/y on the page of a text. A text in several places is
  refused with the places listed and the `occurrence` to give. Nothing else is refused for being hard to prove.
  Where Hangul may lay the page out differently, the result says the place was not verified. The result gives each
  picture an id. `move_picture { picture: id, dx_mm, dy_mm }` or a new place or size does the placing call again on the
  file as it was before it, with that picture's place changed (`server/src/tools/placed-pictures.ts`). This works only
  while the file is still that call's result and the server remembers it (a day, in memory). A Hangul result carries the
  page as the preview engine draws it. A Word result points to `read as_images`.
- **Removed:** the sign-mark words and signer picking (`sign-slots.ts`), the pairing proofs (table readings), the landing
  check and its "checked, N mm" line, and the refusal of wrapped lines.
- **Kept:** read access, re-encoding, size limits, the not-your-own-picture card with Always, byte preservation, read-back.
- **Left out:** moving a picture that was in the file before. PDF keeps stamp_pdf x/y. PowerPoint and Excel already have
  their own move_picture.
- **Version impact:** minor.
