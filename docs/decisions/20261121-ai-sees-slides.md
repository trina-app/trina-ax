# The AI sees a PowerPoint deck's slides as pictures

- Date: 2026-11-21
- Status: accepted
- Supersedes: none (extends [20261116-pptx-to-pdf.md](20261116-pptx-to-pdf.md): the same drawing serves read)
- Branch: feat/ai-sees-slides (the owner: "ppt 슬라이드를 못봐?? 이거 보게 바로 해야할듯")

- **Ask:** read gave a .pptx as text only and refused `pages` / `as_images` ("only for PDF files"), so the AI could not
  say what a slide looks like or whether its layout is off. Claude Code can look at a slide picture.
- **Rule:** read (and chat_file, which reads through it, and room_file in a chat turn) with `pages` or `as_images` on a
  .pptx draws the deck as a PDF with **every** slide, hidden ones too, so page N is slide N as PowerPoint numbers them
  (files/deck-pdf.ts, mode `pptx-slides` of the office worker), then gives each page's text and picture as a PDF read
  with `as_images` does (files/service.ts pdfPagesForModel): at most 20 pages a call, `pages` required over 10 slides,
  the turn's picture budget, the team's image switch and the engine check. The result names hidden slides and what the
  drawing leaves out (charts, SmartArt and EMF/WMF pictures as grey boxes, shadows, gradients, WordArt effects), and
  tells the AI not to report those as faults of the deck. A plain read of a deck stays text.
- **Isolation:** the deck is untrusted. It is drawn only in the office worker (no network, time and memory limits) and
  printed by the headless browser in the converter isolation (bwrap or sandbox-exec, no network, the print cgroup, a temp
  work folder), never in the server process; the page's pictures come from the deck's own bytes by name.
- **Cache:** the PDF is kept in memory by the deck's sha256 (6 decks, 120 MB), so reading slides 1-5 and then 6-10 draws
  once; reads of one deck at the same time share one drawing. Memory only: nothing is left on disk, and the cache is
  reached only after the caller's own read check of those bytes.
- **Where it cannot run** (no headless browser, no isolation, a server too small to print, a --minimal install): a plain
  refusal that tells the AI to read the text and say that this server cannot show slide pictures, never to guess.
- **No new package:** the browser (`browser` group and the chrome-headless-shell artifact in
  scripts/system/packages.json) is already installed by the image, install-linux.sh, the dev environment and the office
  Mac. LibreOffice (faithful charts) stays out for the reasons of 20261116-pptx-to-pdf.md (300-500 MB, a large
  untrusted-input surface).
- **Not yet:** .ppt and .odp (the drawing reads only Office Open XML: a plain refusal names .pptx); Word, Excel and
  Hangul pages as pictures (no converter on the server draws them); charts and SmartArt drawn in a slide.
- **Version impact:** minor (read, chat_file and room_file can show slides).
