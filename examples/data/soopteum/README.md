# 숲틈 / Soopteum (fictional data)

가상의 자료 / Fictional data. 숲틈 / Soopteum is a made-up 18-person office plant subscription in Seoul. Its person
(이도윤 · Doyun Lee), numbers, quote, phone number and the domain `soopteum.example` (reserved, RFC 2606) are invented;
no business by this name turned up in a web search (2026-11-22). There is no logo and no photo: the deck is the
text-only version.

It is the company of the 회사 소개서 / Company profile example (`web/public/skill-examples/<ko|en>/intro-deck.webp`,
`server/src/onboarding/skill-examples.ts`). The other kept skills' examples are made on 예시커피 / Example Coffee
(`../example-coffee/`).

| File (`ko/`, `en/`) | Used for |
|---|---|
| `회사 소개.md`, `Company intro.md` | the company intro: every fact on the slides is written here |
| `intro-deck.json` | the slides, filled in the `intro_deck` tool's slots from the intro (title, company, website, brand colour, theme, section names, slides) |

## How the picture is made (2026-11-22)

```sh
bun scripts/intro-deck-example.ts ko /tmp/ko.html     # checks the slides with the tool's schema, every number against the intro
cd web && bun run build                               # the fonts come from web/dist
bun scripts/skill-examples.ts intro-deck /tmp/ko.html ko public/skill-examples/ko/intro-deck.webp
```

The same for `en`. The picture is the cover, the numbers and the process (slides 1, 5 and 6), 1280 px wide, WebP.
The slides are laid out by the server's own code (`server/src/intro-deck/layout2.ts`), so a change to the deck's design
is shown by running these again. The slides were filled by hand as the skill fills them, not by a live AI run: the
example shows the design, and the intro holds every fact it uses.
