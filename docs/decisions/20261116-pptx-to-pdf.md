# A PowerPoint deck saved as a PDF, a page per slide

- Date: 2026-11-16
- Status: accepted
- Supersedes: none (adds a source kind to the archive's "HTML to PDF")
- Branch: feat/pptx-to-pdf (AI flow check FL-15 step 3, QA TC-3816)

- **Ask:** "그 PPT PDF로도 저장해줘". The AI rewrote the three slides as a Markdown document and saved a one-page PDF.
  In FL-22 another AI wrote an HTML page per slide by hand and printed that (5 pages, a leftover .html file). Nothing on
  the server converted a deck: no LibreOffice in any install, and pandoc has no PowerPoint-to-PDF path.
- **Rule:** make_file with `source` = a .pptx and format "pdf". The office worker (files/pptx-html.ts, mode
  `pptx-html`, isolated like every reader of an untrusted file) draws the deck as one HTML page with a page per shown
  slide at the deck's slide size: every shape at its own place or its layout's / master's placeholder's, text with
  size, weight, colour, alignment and bullets from the slide, layout, master and theme, fills, outlines, lines,
  pictures (cropped as in the deck), tables, the background, and the layout's and master's own shapes. The server's
  headless browser (files/html-pdf.ts) prints it; the page's pictures are answered from the deck's own bytes by name,
  never from the team folder or the network. The deck is the PDF's only source (the wider-audience card as for every
  make_file output); the PDF is placed like every make_file output (conflict copy, version, audit with slides and pages).
- **Honest result:** the AI is told the page count (one per slide), hidden slides left out (as PowerPoint's export
  does), and what was not drawn: charts, SmartArt and other embedded objects leave a light grey box, pictures in EMF,
  WMF or TIFF too; shadows, gradients beyond their first colour, animations and WordArt effects are not drawn, and the
  layout can differ slightly from PowerPoint. It tells the person.
- **Where:** wherever the HTML print runs (a headless browser: the hosted image and Linux servers with Debian's
  chromium, a development Mac with the promo video's chrome-headless-shell). Where it does not (an Office Mac without
  one), make_file's description and the refusal say plainly that this server cannot make a PDF of a deck and that
  PowerPoint or Keynote can (File > Export > PDF); the AI never rewrites the slides as a document instead.
- **Not chosen:** shipping LibreOffice (about 300-500 MB in every image and Mac bundle, a large untrusted-input attack
  surface, its own sandbox and font work) for exact fidelity; a prompt hint alone to write HTML by hand (FL-22's way:
  the AI retypes the deck, loses its design and leaves an .html file behind).
- **Version impact:** minor (a new make_file source kind).
