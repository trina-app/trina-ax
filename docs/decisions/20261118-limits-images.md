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
    (`mycel-safeops resize`) in the converter isolation, no metadata, cached by the picture's sha256 (64 MB; hashed with
    WebCrypto, off the event loop), so each is converted once;
  - past 20 MB of pictures (base64), more go smaller, a block of 12 at a time, oldest first; past 96 pictures, or still
    past 20 MB, the oldest give way, in blocks of 12, to one line that names the picture's file when the read said it
    ("The picture of users/…/photo-03.jpg was left out here … Read that file again"). The newest picture always stays.
  - Every line moves in steps of 12 pictures, so the start of the request (the part the provider caches) changes once
    every 12 new pictures, not with each one.
  - Conversions run two at a time outside the request. A request waits at most 1.5 s for the smaller copies of its
    older pictures and sends those still being made as they are (the next request uses the copy); only what it needs
    to fit the byte limit is waited for.
  - "Cannot be made smaller" (small already, not a picture the helper reads) is kept (at most 2,048 entries); a
    conversion that did not finish (the server busy, a time or memory limit, a stop) is not kept and is tried again.
    Any failure forwards the request as it came.
- **What the proxy takes in:** the engine's own request must reach the proxy before it can be fitted. Its body limit is
  `PROXY_BODY_MAX`, 64 MB (was 32 MB; Bun answers 413 past it). A request is held about four times while it is checked
  and fitted (bytes, text, parsed object, body written again), so about 256 MB for each 64 MB request at the same time.
- **Per-answer caps** (`files/vision.ts turnImageCaps`, all bytes counted as base64, `b64Len`, as the request carries
  them; images, PDF pages, video frames, screenshots and connection pictures all count):
  - in every turn the first 16 pictures (or 10 MB) a read sends go at full size and the next ones already smaller, so
    the engine's request stays small (60 photos of about 1 MB came to the proxy as about 12 MB);
  - a turn whose requests pass the proxy (a proxy token of the anthropic family: managed AI connections, an office
    Mac's own sign-in): 200 pictures / 48 MB, what the proxy takes in with room for the text;
  - other turns (Codex, a direct sign-in): 90 pictures / 20 MB, what one request may carry.
  - The note past a cap no longer says "Continue in a new message": it tells the AI to answer from the pictures it saw
    and name the files it did not look at.
- **Batches:** the `read` description tells the AI to look at many pictures in batches of about 10, write down what each
  shows before the next batch, and read one again for small details (earlier ones are kept at a lower resolution).
- **Attachments:** `MESSAGE_ATTACHMENTS_MAX` 20 -> 100 (what one request may hold in pictures); the chips of a message
  scroll on a computer past a few rows (`md:max-h-40`), as they already did on a phone.
- **Left out:** fitting Codex requests (the Responses format; its turns use the source-side smaller pictures); PDF page
  and video frame sizes (they count, but are not made smaller at the source); a summary of left-out pictures. A session
  that collects pictures over several turns can still bring the engine's own request past 64 MB (each turn stays under
  48 MB of pictures; Claude Code keeps every picture until it compacts).
- **Tests:** `tests/unit/fit-images.test.ts` (60 photos, 60 real-size photos of 1 MB, stable lines under byte pressure,
  cache, kept and retried failures, a slow converter, drop with the file's name, 60 attachments), `tests/unit/proxy.test.ts` (the proxy forwards the fitted request; a failing fitter forwards it as it
  came; a 53 MB request of 40 real-size photos is taken in and goes on under 21 MB; past 64 MB, 413), `tests/unit/vision-read.test.ts` (note wording, fitted cap, smaller after the first 16 with the real helper, with and without the proxy),
  `tests/unit/b-browser.test.ts` (120 screenshots in one fitted turn).
- **Version impact:** patch.
