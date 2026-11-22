# A company profile draft draws a script-only site in the locked-down browser

- Date: 2026-11-22
- Status: accepted
- Supersedes: none
- Branch: fix/company-profile-thin-site (the owner: potenlab.dev filled only the name and one line)

- **Ask:** the owner typed https://potenlab.dev in 회사 소개. Products and customers said "찾지 못했어요". The site is a
  Vite single-page app: its HTML is a title and an empty `<div id="root">`; every page of its sitemap is the same shell.
  Many small-company sites are built this way.
- **Rule:** when web_fetch reads an HTML page whose visible text is under 200 characters (`thinText`,
  server/src/tools/page-data.ts), it tries, in this order, each with its own time limit:
  1. In a company profile draft only: the page drawn by its own scripts (server/src/tools/page-render.ts) in HTML to
     PDF's browser (the pinned chrome-headless-shell, files/html-pdf.ts `runBrowser`: the converters' isolation with no
     network, a host resolver that resolves nothing, as the server account, never root, its own cgroup leaf, killed with
     all its processes at the end). JavaScript is on, which a print never has. Every request of the page is paused and
     answered by the server: the page is the HTML web_fetch already read; anything else is fetched through web_fetch's
     own address guard for that one request (resolveTarget: one lookup, public unicast only, not this server's own
     addresses, networks or exit addresses; pinned socket), a redirect goes back to the browser and is checked again.
     Only GET, HEAD and CORS preflights; only scripts, data requests and stylesheets; no cookies; 150 requests, 12 s.
     At most 6 fetches of the server at once (the rest wait), and 20 MB in all: each fetch reserves what it may bring
     before it starts (at most 3 MB, its decoding capped there too) and settles the real size after, so parallel
     requests cannot pass the budget together; every fetch still running is stopped when the drawing ends. The render
     takes one of HTML to PDF's print slots (`tryRenderSlot`: the print cgroup's room on a small server, never ahead of
     a waiting print), and a busy server skips it. runBrowser refuses to start without the isolation (a JavaScript-on run always; only printIn has a test-only hatch for a JavaScript-off print) or as root, whoever
     calls it. A page read on (offset > 0) reuses its first read's drawing and is never drawn again. No browser or no
     isolation: skipped quietly.
  2. For every web_fetch: what the page's markup says about it, each value on its own line exactly as written (no labels
     or joins of ours, so a quote is page text): meta description, Open Graph and Twitter card, names and descriptions
     in JSON-LD, prose strings of `__NEXT_DATA__`, `__NUXT_DATA__` and the RSC payload. Pure parsing, linear, at most
     6,000 characters. This embedded data now reaches every web_fetch of a thin page, not only drafts, inside the same
     external-data wrapper as the page text and capped.
  3. In a company profile draft only, when the text is still thin: the likely pages of `/sitemap.xml` (one sitemap
     index level, the same host and every redirect on it, 4 s, 1 MB), listed so the AI may open them.
  The draft's instructions say that this text is the page's own and may be quoted. "직접 적어 주세요" stays when
  nothing is found.
- **Why:** a draft from the title alone is no draft. The markup alone gives a description (potenlab.dev: products, not
  customers); only the drawn page has the real content (potenlab.dev drawn: about 3,800 characters in 4 to 8 s, with
  its services, packages, customers and portfolio). The browser and its isolation already ship for HTML to PDF
  (scripts/system/packages.json), so no new package; the server answering every request keeps the SSRF rules of
  web_fetch for every sub-request, which a browser with its own network could not.
- **Left out:** drawing pages for ordinary chats (more pages, more cost; can follow the same hook), POST requests of a
  page (the server never sends a stranger's page's writes), pictures and fonts (not needed for text), reading text out
  of JavaScript bundles.
- **Tests:** tests/unit/web-thin-page.test.ts (a Vite shell with meta and JSON-LD, `__NEXT_DATA__`, RSC, hostile
  markup, a sitemap index with off-host and blog entries, a sitemap redirect to another site, a drawn page whose script
  tries the office network, the cloud metadata address, a POST and a picture: none reach anything).
- **Version impact:** patch.
