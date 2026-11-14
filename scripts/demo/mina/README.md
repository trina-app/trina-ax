# 미나의 첫날 (hands-on demo story, Korean)

The story the hands-on demo build plays (format: [`web/demo/script.ts`](../../../web/demo/script.ts), plan:
`docs/AGENTS/plan/20261114-0507-mina-demo.md`). [`index.ts`](index.ts) default-exports the `DemoScript`; the pictures
and text files it names are in [`assets/`](assets/).

**차곡 is a fictional company.** Every person, number, address and file here is made up for the demo. The agency's
address uses the reserved `.example` domain. There are no photos of people and no real logos: the avatars are
initials on plain shapes, and the product and the banner backgrounds are drawn in CSS.

## The story

차곡 is a 12-person company in 성수동 that makes cold-brew tea bags. Its winter yuzu-ginger blend (유자생강 블렌드)
launches on Monday, November 23. 윤미나 joins Marketing today; she is good at design.

| Who | Id | In the story |
|---|---|---|
| 윤미나 | `mina` | the visitor, new marketing hire |
| 박서연 | `seoyeon` | 마케팅팀장, sends the DM, asks the CEO, points to Gmail |
| 정우진 | `woojin` | 대표, approves and posts the final file |
| 강레오 | `leo` | made the first banner, moves to Sales on November 23 |
| 한도윤, 최하은, 오지수 | `doyun`, `haeun`, `jisu` | operations, sales, online shop (only in #전체) |

1. **Home**: "신입사원 미나님, 입사를 축하합니다" → "우리 회사는 뭐 하는 회사예요?" The answer reads the company intro
   and the brief, lists the team skills: the company in 3 lines, her role, 3 skills, "인수인계 도와드릴까요?" and
   Higgsfield. (`인수인계 도와줘` has its own answer for a visitor who types it; it is not in the guide.)
2. **DM from the lead** with the project link.
3. **Project "11월 런칭 캠페인"**: Leo's banner and his earlier chat. Two prompts: A "제목을 크게, 브랜드 색으로
   정리해줘" (reads the brand guide) and B "Higgsfield로 새 배경 이미지 만들어서 넣어줘" (a Higgsfield step, then the
   banner on the new background).
4. **#마케팅**: the visitor shares the answer; the lead, Leo, the CEO (with `런칭배너_최종.png`) and the lead's Gmail line.
5. **✦ side chat in #마케팅**: "이 배너 김 실장님께 메일로 보내줘" or "좀 더 정중하게 써서 보내줘". Each shows the draft
   (to, subject, attachment, body) and a card "Gmail로 이 메일을 보낼까요?" (보내기 / 더 정중하게 다듬기 / 취소), then the
   sent line.
6. **End card** after the mail. Free typing gets "이 데모는 추천 질문으로 움직여요" with the suggested prompts.

The final file the CEO posts is version A (`FINAL_ASSET` in `index.ts`): the format cannot yet say "the banner the
visitor made". If the engine learns that, use `banner-b.png` after the `banner-b` answer.

## Files

| Path | What |
|---|---|
| `index.ts` | the story (`DemoScript`) |
| `assets/banner-leo.png` | Leo's banner: same-size lines, pastel gradient, red sale text, tiny logo bottom right (weak on purpose, not a joke) |
| `assets/banner-a.png` | version A: brand colours, one big title, yuzu badge, logo top left, Pretendard |
| `assets/banner-b.png`, `assets/bg-b.png` | version B and its "Higgsfield" background (drawn in CSS, no credits spent) |
| `assets/avatar-*.png` | 256×256 avatars, one per person |
| `assets/회사소개.md`, `assets/브랜드 가이드.md`, `assets/11월 런칭 캠페인 브리프.md` | team files: `shared/…`, `groups/마케팅/…` |
| `assets/skill-*.md` | the four team skills, seeded at `skills/<name>/SKILL.md`: SNS 카피 3안, 보도자료 초안, 경쟁사 요약, 인수인계 도우미 |
| `source/` | how the pictures are made: banner HTML/CSS, avatar SVGs, `render.mjs` (Playwright); the demo never reads it |

Banners are 1200×628 PNG, 256 colours. To make them again, see the top of [`source/render.mjs`](source/render.mjs).
Pretendard is under the SIL Open Font License 1.1 and is loaded from jsDelivr only while rendering.
