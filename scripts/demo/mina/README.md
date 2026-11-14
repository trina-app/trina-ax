# Mina's first day (hands-on demo story)

The story the hands-on demo build plays (format: [`web/demo/script.ts`](../../../web/demo/script.ts), plan:
`docs/AGENTS/plan/20261114-0507-mina-demo.md`). English first; other languages come after the owner's review.

**Steepling is a fictional company.** Every person, number, address and file here is made up for the demo. The
agency's address uses the reserved `.example` domain. There are no photos of people and no real logos: the avatars are
initials on plain shapes, and the product and the banner backgrounds are drawn in CSS.

## Layout

| Path | What |
|---|---|
| `index.ts` | default export: `buildScript(en, 'en')`, the `DemoScript` the build plays |
| `story.ts` | the structure: ids, rooms, triggers, steps, file paths. No words of its own |
| `strings/en.ts` | every word: names, prompts, answers, messages, emails, guide, fallback, end card (`Strings`) |
| `assets/*.en.*` | what is English: the three banners, the team files, the four skills |
| `assets/bg-b.png`, `assets/avatar-*.png` | the same in every language: the "Higgsfield" background, the avatars |
| `source/` | how the pictures are made: banner templates, `banners/copy.en.json` (their words), `render.mjs`; the demo never reads it |

**Adding a language** (ko, id, ja, es): copy `strings/en.ts` to `strings/<locale>.ts` (`export const ko: Strings = …`)
and translate it; translate `assets/*.en.md` to `*.<locale>.md`; copy `source/banners/copy.en.json` to
`copy.<locale>.json`, translate it and run `render.mjs <locale>`; then build with `buildScript(ko, 'ko')`. The Korean
first draft of this story is in git history (commit 78e47299a).

## The story

Steepling is a 12-person company that makes cold-brew tea bags. Its winter Yuzu Ginger blend launches on Monday,
November 23. Mina Lee joins Marketing today; she is good at design.

| Who | Id | In the story |
|---|---|---|
| Mina Lee | `mina` | the visitor, new marketing hire |
| Sara Jensen | `sara` | Marketing lead: sends the DM, asks the CEO, points to Gmail |
| Daniel Okoye | `daniel` | CEO: approves and posts the final file |
| Leo Santos | `leo` | made the first banner, moves to Sales on November 23 |
| Tom Becker, Aiko Tanaka, Omar Haddad | `tom`, `aiko`, `omar` | operations, sales, online shop (only in #Everyone) |

1. **Home**: "Welcome aboard, Mina! Congratulations on your first day." → "What does our company do?" The answer reads
   the company intro and the brief and lists the team skills: the company, her role, 3 skills, the handover offer and
   Higgsfield. ("Yes, help me with the handover" has its own answer for a visitor who types it; not in the guide.)
2. **DM from Sara** with the project link.
3. **Project "November launch campaign"**: Leo's banner and his earlier chat. Two prompts: A "Make the title bigger
   and use our brand colors" (reads the brand guide) and B "Make a new background with Higgsfield and put it in".
4. **#Marketing**: the visitor shares the answer; Sara, Leo, Daniel (with `launch-banner-final.png`), Sara's Gmail line.
5. **✦ side chat in #Marketing**: "Email this banner to Chris" or "Make it a bit more formal and send it". Each shows
   the draft (to, subject, attachment, body), the card "Send this email with Gmail?" (Send / Make it more formal /
   Cancel), then the sent line.
6. **End card** after the mail. Free typing gets "This demo runs on suggested prompts" with the suggested prompts.

The final file Daniel posts is version A (`finalAsset` in `story.ts`): the format cannot yet say "the banner the
visitor made". If the engine learns that, use `banner-b.<locale>.png` after the `banner-b` answer.

Banners are 1200×628 PNG, 256 colours, in Pretendard (SIL Open Font License 1.1, loaded from jsDelivr only while
rendering; Leo's draft uses Arial on purpose). To render again, see the top of [`source/render.mjs`](source/render.mjs).
