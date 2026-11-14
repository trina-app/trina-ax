# Mina's first day (hands-on demo story, v2.1)

The story the hands-on demo build plays (format: [`web/demo/script.ts`](../../../web/demo/script.ts), plan:
`docs/AGENTS/plan/20261114-0507-mina-demo.md`). English first; other languages come after the owner's review.

**Steepling is a fictional company.** Every person, number, address and file here is made up for the demo. The
agency's address uses the reserved `.example` domain. The avatars are photos of made-up people (generated with
Higgsfield, checked by hand). The campaign photos were generated with Higgsfield too (made-up product, no real brand,
no text in the pictures).

## Layout

| Path | What |
|---|---|
| `index.ts` | default export: `buildScript(en, 'en')`, the `DemoScript` the build plays |
| `index.ko.ts` | the Korean story, `buildScript(ko, 'ko')`: built with `DEMO_LOCALE=ko`, served at /demo/ko/ |
| `story.ts` | the structure: ids, rooms, triggers, steps, file paths, timing. No words of its own |
| `strings/en.ts` | every word: names, prompts, answers, captions, messages, toasts, email, guide lines and nudges, end card |
| `strings/ko.ts` | the same in Korean (Slack-style office Korean, not word for word); `assets/*.ko.*` its pictures and team files, `source/banners/copy.ko.json` its banner words (headline in Noto Serif KR) |
| `assets/*.en.*` | what is English: Leo's draft, the campaign banner, square and story, team files, skills |
| `assets/higgsfield-photo.jpg`, `assets/avatar-*.jpg` | the same in every language: the Higgsfield photo, the profile photos (fictional people, 512×512) |
| `source/` | how the pictures are made: the Higgsfield photos (`photos/`), templates, `banners/copy.en.json` (their words), `render.mjs`; the demo never reads it |

**Adding a language** (ko, id, ja, es): copy `strings/en.ts` to `strings/<locale>.ts` (`export const ko: Strings = …`)
and translate it; translate `assets/*.en.md` to `*.<locale>.md`; copy `source/banners/copy.en.json` to
`copy.<locale>.json`, translate it and run `render.mjs <locale>`; then build with `buildScript(ko, 'ko')`.

## The story: four moments, about 9 clicks

| Who | Id | In the story |
|---|---|---|
| Mina Lee | `mina` | the visitor, new marketing hire |
| Sara Jensen | `sara` | Marketing lead: invited Mina, sends the DM, points to Gmail |
| Daniel Okoye | `daniel` | CEO: "🔥 This is it. Ship it." |
| Leo Santos | `leo` | made the first banner; "wait how did you do this so fast 😂" |
| Tom Becker, Aiko Tanaka, Omar Haddad | `tom`, `aiko`, `omar` | #Everyone, and emoji reactions on Mina's post |
| Chris Walker (Fieldnote) | `chris` | the agency, outside the team: his reply comes through Sara |

1. **Home**: "Welcome aboard, Mina! Congratulations on your first day." (Sara invited you) → "What does our company
   do?" ① Three file reads, then what Steepling does, Mina's job, this week (Monday's launch), and Sara, Leo and
   Daniel as "People to know". Then Sara's DM arrives.
2. **Sara's DM** with the project card.
3. **Project**: Leo's banner, one suggestion: "Follow our brand guide and make a new background with Higgsfield". ② Two Higgsfield steps (the
   hero photo, then the square and story from the same shot), then in the answer: before (Leo's) and after, the
   square and the story, three captions. Five files are saved: web banner 1200×628, Instagram square 1080×1080 and
   story 1080×1920, captions, the Higgsfield photo. Then "Send to #Marketing".
4. **#Marketing**: ③ Daniel types and ships it, Leo laughs, Tom, Aiko and Omar react, Sara points to Gmail.
5. **✦ side chat**: "Email the banner to Chris" → the draft with the banner and the square attached → Send or Make it
   more formal → sent. ④ Sara passes on Chris's reply in #Marketing: "Looks great, running it Monday."
6. **End card** "That's Mina's first day", with what it usually takes.

Cut: option A (brand-guide only), the handover prompt, the get-started checklist, the CEO re-uploading the file.

**Pictures.** Three Higgsfield photos (gpt_image_2_6, medium, 2k; 3 credits): the 16:9 hero, then 1:1 and 9:16 with
the hero as a reference so the pouch stays the same. The pouch's label is blank in the photos and printed on in HTML,
so no AI-made letters show. Type is Fraunces (headline, wordmark) with Pretendard (both SIL Open Font License 1.1,
loaded only while rendering); Leo's draft uses Arial on purpose. The campaign pictures are JPEG at quality 85 with
full colour detail (4:4:4); a 256-colour palette banded the frosted window. To render again, see the top of [`source/render.mjs`](source/render.mjs).
