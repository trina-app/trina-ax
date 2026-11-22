# Company profile draft: read sites that show almost no text without scripts

- Date (UTC): 2026-11-21 23:50
- Branch: `fix/company-profile-thin-site`
- Status: done
- Where: server/src/tools (web_fetch), server/src/onboarding/draft.ts. Why: the draft reads the website only through
  web_fetch (see docs/REPOSITORY-RULES.md)
- Version impact: patch: a fix of what the existing company profile draft finds; no new API or setting

## Goal

The owner typed https://potenlab.dev in the "회사 소개" dialog. Only the name and the one-line intro were filled (from
the page title); products and customers said "찾지 못했어요. 직접 적어 주세요." The site is client-rendered (a Vite
single-page app): its HTML is a shell with an empty `<div id="root">`, so web_fetch's text is the title alone. Many
small-company sites built this way say what they do only in the markup's head (meta description, Open Graph,
JSON-LD) or in an embedded data blob (Next.js `__NEXT_DATA__`, the App Router's RSC payload, Nuxt's `__NUXT_DATA__`).

## Scope

In:
- web_fetch: when a page's visible text is almost nothing (under 200 characters), add what the page's own markup says
  about it: the meta description, the Open Graph / Twitter card title and description, names and descriptions in
  JSON-LD (Organization, Product, Service, offers, item lists), and prose strings of `__NEXT_DATA__`,
  `__NUXT_DATA__` and the RSC payload. Every line is copied from the page as it is, so the draft's source excerpts stay
  true. Pure parsing, linear in the page, capped in characters. For every web_fetch caller (a chat reading such a page
  had nothing too).
- In a company profile draft only: for such a page, web_fetch also reads the site's `/sitemap.xml` (the same host
  only, every redirect hop on that host and inside the draft's scope, the normal SSRF guard of webFetch, 5 s and
  1 MB, one sitemap index level) and lists up to 10 likely pages (about, company, services, products, customers ...),
  so the AI may open them within its page budget (they appear in a web_fetch result, so the URL gate learns them).
- The draft instructions say that this part of a page and its page list may be used and quoted like page text.
- "직접 적어 주세요" stays when nothing is found (no change to the review screen).

Out:
- Rendering pages in a headless browser. The servers have chrome-headless-shell (HTML to PDF), but it runs with
  JavaScript off and no network by design (docs/DECISIONS.md "HTML to PDF"); rendering a stranger's site needs
  JavaScript on and the page's API calls answered (potenlab.dev loads its text from another host, a Supabase function),
  which is a separate security decision for the owner. Proposed as a follow-up. (Changed while building: added at the
  coordinator's request, see Result.)
- Reading text out of a site's JavaScript bundles.

## Steps

1. `server/src/tools/page-data.ts`: `pageData(html)` and `sitemapPages(xml, base)`.
2. web_fetch: append the page data for a thin HTML page; `sitePages` option for the sitemap list; `maxBytes` option.
3. tools/index.ts: drafts pass `sitePages`.
4. draft.ts prompt: mention the page data and the sitemap list.
5. Unit tests with fixtures: a title-only Vite shell with meta + JSON-LD, a Next.js `__NEXT_DATA__` page, an RSC page,
   a sitemap with /about (local test server), hostile input (size, nesting), off-host sitemap entries dropped.

## Decisions

[docs/decisions/20261122-company-profile-thin-site.md](../../decisions/20261122-company-profile-thin-site.md) (added
with the render).

## Risks

- SSRF: the sitemap fetch goes through webFetch (one lookup, public addresses only, pinned socket), its redirects must
  stay on the same host and pass the draft's scope.
- Prompt injection: the added lines are inside the same external-data block as the page text.
- No migration, no UI, no new system package.

## Tests

`bun run typecheck`, `bun run check:prepush`, the web_fetch and onboarding draft unit tests.

## Result

Built as planned, plus the browser render, which the plan had left out: the coordinator asked for it, reusing HTML to
PDF's browser (no new package) with every sub-request blocked from private and internal addresses. Decision:
[docs/decisions/20261122-company-profile-thin-site.md](../../decisions/20261122-company-profile-thin-site.md).

- `server/src/tools/page-render.ts`: the page drawn with JavaScript on in HTML to PDF's isolated browser; the server
  answers every request (web_fetch's address guard per request, GET/HEAD/preflight only, scripts, data and stylesheets
  only, 150 requests, 12 s, 20 MB reserved per fetch before it starts, 6 fetches at once, one of the print slots). `files/html-pdf.ts`: the launch moved into `runBrowser` (shared;
  prints unchanged), `browserArgs(work, { scripts })`.
- `server/src/tools/page-data.ts` and web_fetch: the markup's data for a thin page (every web_fetch), the sitemap list
  and the render hook (drafts only).
- potenlab.dev, checked live once: the markup alone gives the description (products: 포텐부스터, 커스텀 프로덕트 개발,
  디자인&컨설팅) and 10 sitemap pages; drawn, about 3,800 characters in 4 to 8 s, with services, packages, customers
  ("스타트업부터 엔터프라이즈까지", "초기 창업가", "기존 비즈니스에 AI 도입하려는 팀") and portfolio.
