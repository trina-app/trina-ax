# Mina's first day (hands-on demo story, v2)

The story the hands-on demo build plays (format: [`web/demo/script.ts`](../../../web/demo/script.ts), plan:
`docs/AGENTS/plan/20261114-0507-mina-demo.md`). English first; other languages come after the owner's review.

**Steepling is a fictional company.** Every person, number, address and file here is made up for the demo. The
agency's address uses the reserved `.example` domain. The avatars are photos of made-up people (generated with
Higgsfield, checked by hand), and the product and the banner backgrounds are drawn in CSS.

## Layout

| Path | What |
|---|---|
| `index.ts` | default export: `buildScript(en, 'en')`, the `DemoScript` the build plays |
| `story.ts` | the structure: ids, rooms, triggers, steps, file paths, timing. No words of its own |
| `strings/en.ts` | every word: names, prompts, answers, captions, messages, toasts, email, guide lines and nudges, end card |
| `assets/*.en.*` | what is English: banners, squares, stories, team files, skills |
| `assets/bg-b.png`, `assets/avatar-*.jpg` | the same in every language: the "Higgsfield" background, the profile photos (fictional people, 512×512) |
| `source/` | how the pictures are made: templates, `banners/copy.en.json` (their words), `render.mjs`; the demo never reads it |

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
| Chris Walker (Fieldnote) | `chris` | the agency, outside the team: only the reply toast |

1. **Home**: "Welcome aboard, Mina! Congratulations on your first day." (Sara invited you) → "What does our company
   do?" ① Three file reads, then what Steepling does, Mina's job, this week (Monday's launch), and Sara, Leo and
   Daniel as people chips. Then a toast: "Sara: Got a sec? 🙏".
2. **Sara's DM** with the project card.
3. **Project**: Leo's banner. A "Fix it with our brand guide" or B "Make a new background with Higgsfield" (with a
   Higgsfield step). ② Before/after slider, five deliverables (banner, square, story, captions, and the brand check
   for A or the background for B), three captions in the answer, and one big "Send to #Marketing" button.
4. **#Marketing**: ③ Daniel types and ships it, Leo laughs, Tom, Aiko and Omar react, Sara points to Gmail.
5. **✦ side chat**: "Email the banner to Chris" → the draft with the banner and the square attached → Send or Make it
   more formal → sent. ④ Chris's toast: "Looks great, running it Monday."
6. **End card** "Mina's first day" with time, files read (3), deliverables (5), CEO approval (1), email sent (1).

A and B save their files under the same names, so the mail always attaches the version the visitor made (the latest
one, if both). Cut from v1: the handover prompt, the get-started checklist, the CEO re-uploading the file.

Pictures are PNG, 256 colours, in Pretendard (SIL Open Font License 1.1, loaded from jsDelivr only while rendering;
Leo's draft uses Arial on purpose). To render again, see the top of [`source/render.mjs`](source/render.mjs).
