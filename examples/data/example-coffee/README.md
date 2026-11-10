# 예시커피 / Example Coffee (fictional data)

가상의 자료 / Fictional data. 예시커피 / Example Coffee is a made-up 12-person coffee roaster. Its people (김민지,
이지훈, 박수아 · Mina Kim, Jihoon Lee, Sua Park), numbers, quote and the domain `coffee.example` (reserved, RFC 2606)
are invented; no real business by these names turned up in web searches. There are no photos, only a type-only
wordmark, so the three visual skills make their text-only version.

The kept skills' examples (`server/src/onboarding/skill-examples.ts`, EXAMPLES-PLAN) were made from these files by
the skills themselves: one per skill in Korean and in English.

| File (`ko/`, `en/`) | Used for |
|---|---|
| `회사 소개.md`, `Company intro.md` | the company intro, put in the team's brand folder (`groups/<team>/브랜드/`, `Brand/`) |
| `로고.png`, `logo.png` | the wordmark "EXAMPLE COFFEE" (#3B2A20), in the brand images folder (`…/이미지/`, `…/Images/`) |
| `공지 초안.md`, `post-draft.md` | the AI-sounding text pasted into 자연스러운 글 / Natural writing |

## How they were made (2026-11-08)

1. A local dev server per language with a real AI (Claude Code, the default model) and no web search:
   `TEAM_AX_DEV_DIR=<new short folder> TEAM_AX_DEV_PORT=<free port> MYCEL_DECK_TIER=quick bun run dev --no-relay`,
   the owner from `bun run dev admin create-owner --team 예시커피 --locale ko` (or `--team "Example Coffee" --locale en`).
2. 회사 소개 (`PUT /api/onboarding/profile`) filled from the intro file: name, the one line, products, audience,
   tone (담백하게, 친근하게 · plain, friendly), avoid (최고, 프리미엄, 혁신 · best, premium, revolutionary), website
   `https://coffee.example`, colours `#3b2a20`, `#e9d8c4`. Then the team folder (`POST /api/onboarding/welcome/team`),
   the intro and the wordmark uploaded into the brand folder, and both packs installed.
3. Each skill run once in a new chat with its form's defaults, as the form sends them: `/intro-deck `, `/card-news` and
   `/promo-video` with "어디에 올릴까요: 인스타그램" ("Where will it go: Instagram"), `/humanizer` with "무엇을: 다듬기",
   "어디에 쓸 글: 보도자료·공지" ("What to do: Rewrite") and the draft pasted under it. At most two tries; the better one.
4. The pictures: the artifact's `content` (`GET /api/artifacts/:id`) through
   `cd web && bun scripts/skill-examples.ts <skill> <artifact.html> <ko|en> public/skill-examples/<ko|en>/<skill>.webp`
   (after `bun run build`). The text: `resources/skill-packs/work/<ko|en>/humanizer/EXAMPLE.md`, the draft quoted, then
   the answer (the rewrite and the first lines of "바뀐 점" / "What changed") within 900 / 1,200 characters.
5. Checked by a person: every fact comes from these files, no real company, person, logo or place, and it reads well
   at 390 px wide and in dark mode.

## When a SKILL.md changes

Make its example again in the same PR, the same way, and record the new `skillHash` (the first 12 hex digits of
`shasum -a 256 SKILL.md`): in `skill-examples.ts` for a picture, in the EXAMPLE.md front matter for a text.
`tests/unit/b-skill-catalog.test.ts` fails until the hash matches.
