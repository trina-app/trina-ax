# Many pictures in one answer: the request is fitted, the person is not sent to a new message

- Date: 2026-11-18
- Status: accepted
- Supersedes: the per-turn image budget of "AI sees images and PDF pages (feat/vision-read)" in the archive (40 images or 10 MB a turn, then "Continue in a new message")
- Branch: fix/limits-images (limits audit #4, QA TC-4907; owner goal "the AI should behave like Claude Code")

- **Ask:** a person attaches 60 photos and asks about all of them. The answer stopped after 40 pictures (or 10 MB)
  with "Continue in a new message", and one message could carry only 20 attachments.
- **Why the old cap existed:** the engine sends every picture of the conversation again with each model request, and
  one request may hold at most 100 images and 32 MB (each full picture also costs about 2,500 tokens of context). The
  cap counted everything sent in the turn, not what was still in the request, and had no way but to hand the job back.
- **Rule: the model proxy fits each Claude request** (`server/src/proxy/fit-images.ts`, called in `model-proxy.ts`
  before the checked body is written again). Every base64 picture of the request, in a message or inside a tool result,
  oldest first:
  - the newest `FIT_FULL_NEWEST` (12) go as they are: the AI is looking at them now;
  - older ones go smaller: longest side 768 px, at most 150 KB (about 600 tokens), made by the resize helper
    (`mycel-safeops resize`) in the converter isolation, no metadata, cached by the picture's sha256 (64 MB), so each is
    converted once;
  - the line between the two moves in steps of `FIT_STEP` (12) pictures, so the start of the request (the part the
    provider caches) changes once every 12 new pictures, not with each one;
  - past 96 pictures or 20 MB of pictures, more of the full ones go smaller (oldest first) and then the oldest give way,
    in steps, to one line: "An earlier picture was left out here ... Read its file again to look at it." The newest
    picture always stays.
  - A picture that cannot be made smaller stays as it is; any failure forwards the request as it came.
- **Per-answer caps** (`files/vision.ts turnImageCaps`): a turn whose requests pass the proxy (a proxy token of the
  anthropic family: managed AI connections, an office Mac's own sign-in) keeps only a safety cap of 400 pictures /
  400 MB (conversion time and memory). Other turns (Codex, a direct sign-in) keep what one request can hold, 90 pictures /
  24 MB, and after the first 16 pictures (or 8 MB) the source sends each new picture already smaller. The note past a cap
  no longer says "Continue in a new message": it tells the AI to answer from the pictures it saw and name the files it
  did not look at.
- **Batches:** the `read` description tells the AI to look at many pictures in batches of about 10, write down what each
  shows before the next batch, and read one again for small details (earlier ones are kept at a lower resolution).
- **Attachments:** `MESSAGE_ATTACHMENTS_MAX` 20 -> 100 (what one request may hold in pictures); the chips of a message
  scroll on a computer past a few rows (`md:max-h-40`), as they already did on a phone.
- **Left out:** fitting Codex requests (the Responses format; its turns use the source-side smaller pictures), PDF page
  and video frame sizes (they count as before), a summary of left-out pictures.
- **Tests:** `tests/unit/fit-images.test.ts` (60 photos, stable line, cache, drop with note, bytes, failures, 60
  attachments), `tests/unit/proxy.test.ts` (the proxy forwards the fitted request; a failing fitter forwards it as it
  came), `tests/unit/vision-read.test.ts` (note wording, fitted cap, smaller after the first 16 with the real helper),
  `tests/unit/b-browser.test.ts` (120 screenshots in one fitted turn).
- **Version impact:** patch.
