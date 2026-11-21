# Demo: a banner's words can be changed (make_banner), and the AI knows the demo's services are practice copies

- Date (UTC): 2026-11-21 15:20
- Branch: `feat/demo-banner-editable-text`
- Status: done (PR open, not in the queue)
- Where: server/src/demo/fakes (the fake Higgsfield), server/src/chat (the demo rule), scripts/demo/steepling (the
  seed), scripts/demo/company/fakes.ts (copying the fakes into the snapshot), tests/unit. Why: demo-only behaviour of
  the free-roam demo (docs/decisions/20261119-demo-fakes.md)
- Version impact: **none**. Only a free-roam demo with fakes changes; no product feature, setting, API or migration

## Goal

The owner, in the Korean free-roam demo (Steepling, "유자 진저 런칭 캠페인"): Trina made the banners, then the visitor
asked to change the headline "작은 햇살 한 잔." to "작은 햇살 두 잔.". Trina refused ("완성된 이미지 안의 글자만 따로
바꿀 수가 없어요 … 글자를 얹는 도구는 지금 없어요") and offered to make the whole banner again.

Cause: the banners are finished JPEGs with the words baked in (scripts/demo/mina/source/render.mjs renders HTML over a
Higgsfield photo with Playwright, once, offline). On a demo instance the AI has no Bash and no code; make_file's SVG to
PNG draws in isolation and cannot reference a team picture; the fake Higgsfield only hands back canned photos. So it
was right that no tool could put words on a picture. It also said "Higgsfield로 새로 찍었어요" though the fake picks a
prepared photo.

After: the visitor asks for new words and gets a new banner back, with real-looking photos made in advance.

## Scope

In:
- The fake Higgsfield gets `make_banner` (size, scene, headline, subline, eyebrow, badge, badge_note, button): a
  text-free photo made in advance + the words as their own layer, drawn by typst (already on every server that makes
  PDFs) in the converters' isolation. Words left out, and the photo, stay as on the last banner make_banner made (the launch banner's at first); the newest
  30 pictures are kept, one render at a time per process, typst `--jobs` as make_file. The picture comes back inline and at the
  fake's download address, like generate_image, so save_connector_file saves it.
- The banner kit in the seed: 4 scenes (one glass by the window = the story's photos, two glasses, the pouch close up,
  a café table) × 1200×628 / 1080×1080 / 1080×1920 (the pouch close-up has no square), the pouch label printed by the
  template, the brand guide's fonts (Fraunces, Noto Serif KR, Noto Sans KR: SIL OFL 1.1, subset). The scene follows the
  words ("두 잔" → two glasses). The other scenes are generate_image pictures too.
- The demo rule (prompt.ts demoRule) tells the AI, on a demo with fakes: the services are practice copies; generate_image
  picks a prepared photo (say so, never "shot a new one"); mail is never really sent; and, only when the demo has a
  banner kit, banner words are a layer, change them with make_banner.

Out: real image generation in the demo; editing other pictures' text; the visible notice on the landing page and the
bar (another PR).

## Steps

1. Make 8 text-free photos with Higgsfield (gpt_image_2_6, the story's hero as reference), cut them to the sizes with
   `scripts/demo/steepling/banner/make-backgrounds.py` (JPEG q84, ≤1200 px a side), find the pouch labels.
2. `server/src/demo/fakes/banner.ts`: the kit, the scene picker, the typst document, the render.
3. `make_banner` in `higgsfield.ts`; the kit loaded in `fakes/index.ts`; `scripts/demo/steepling/banner/kit.ts` writes
   the kit from the story's banner words (`scripts/demo/mina/source/banners/copy.<locale>.json`); `company/fakes.ts`
   copies `higgsfield/banner/` into the snapshot.
4. The demo rule's note; `turn.ts` passes whether the demo has fakes.
5. Tests, README, changes note.

## Decisions

None new; this extends docs/decisions/20261119-demo-fakes.md (the fake Higgsfield's tool list).

## Risks

- typst on the demo Mac: the same Homebrew typst make_file uses; `curve` needs typst 0.13+. Without typst make_banner
  says it is not set up.
- The words are typst strings, never markup or code (tested). The render runs isolated, time and memory capped.
- Snapshot size: +about 1.4 MB photos, 2.5 MB fonts.
- No string in scripts/demo/steepling/strings (another PR adds four locales there). ja/zh/es/id kits work from the
  story's own copy files when those locales are added.

## Tests

`bun run typecheck`, `bun run check:prepush`, tests/unit/demo-banner.test.ts (new: every scene and size in en and ko,
new words → new picture, typst escaping, scene picking, end to end connection → make_banner → save_connector_file, the
demo note), demo-fakes, demo-free-roam (the snapshot carries the kit), demo-company-seed, b-prompt-team-name.

## Result

Built as planned. Option A (the fake draws the banner) over option B (the AI edits a template): the AI has no
renderer it could feed a team picture to, and one tool call is what a visitor's "change the headline" needs.
