---
name: ui-polish
description: Find and fix visual rough edges in the Team AX web app and desktop shell (cramped text with no padding, uneven gaps, misaligned rows, clipped or overflowing text, inconsistent buttons, dark-mode and phone-width problems). Use for "UI가 불편해", "패딩", "정렬", "간격", "보기 불편", UI polish passes.
---

# UI polish pass (Team AX)

Goal: the app should feel calm and even. Fix what a person notices while using it; do not redesign, rebrand or add features.

## 1. See it first, never fix blind

- Run the web app against the mock server (no real data, no real engines): see `web/playwright.config.ts` and `web/test/mock/server.ts` for how the e2e tests start it (`bunx playwright test` in `web/`). For a free-running instance, start the same mock + Vite the config starts and drive it with the Playwright MCP tools.
- Sign in as each role the mock has (owner, admin, member) and walk every screen: Home, Chat (empty, long conversation, streaming answer, attachments, file cards, artifact panel, browser panel, engine picker, "다른 모델로 다시 시도"), Files (list, empty folder, file view, version history, trash), Projects, Skills, Settings (all tabs incl. 앱), Admin (members, groups, folder rules, engines incl. API engine form, usage, audit, system), Auth (login, forced password change, setup).
- For each screen take screenshots in this matrix, at minimum: **desktop 1440×900** and **phone 390×844**; **light** and **dark** (`emulateMedia colorScheme`); **ko** (default for these users) and spot-check **en** (longer strings). Save them under `web/test-results/ui-polish/before/` (gitignored) and look at every one.
- Write a short list of findings before editing: screen, what is wrong, where in the code.

## 2. What to look for

- **Padding**: text touching a border, card edge, panel edge or the screen edge; headings flush against content; buttons whose label touches the edge. Containers holding text need inner padding (cards ≥ 12–16px, panels/sections 16–24px, phone gutter 16px).
- **Rhythm**: one spacing scale (Tailwind 1/1.5/2/3/4/6/8). Same kind of element → same gap everywhere (list rows, form fields, section headings). Vertical space above a heading larger than below it.
- **Alignment**: icons vertically centered with text (`items-center`), left edges of stacked blocks lining up, numbers right-aligned in tables, labels and inputs aligned in forms.
- **Text**: Korean wraps by word (`break-keep` / `word-break: keep-all`) and does not split mid-word; long file names and URLs truncate with ellipsis plus a `title`, or wrap with `break-all` only where that is the content; line-height comfortable for body text (≈1.5–1.7) and tighter for headings; no text clipped by fixed heights.
- **Overflow**: no horizontal page scroll at 390px; tables scroll inside their own box; dialogs fit the phone screen and scroll inside; sticky composer never covers the last message.
- **Consistency**: buttons of the same role share size, radius and padding (`ui.tsx` primitives first); same radius family for cards/inputs/dialogs; hover/focus states present and visible (keyboard focus ring).
- **Dark mode**: every color through the `--c-*` tokens in `web/src/index.css`, no hard-coded hex/`white`/`black` that breaks in dark; enough contrast for `text-faint` on `bg-subtle`.
- **Empty and loading states**: centered, padded, with one line of explanation, not a bare blank area.

## 3. How to fix

- Prefer fixing the shared primitive (`web/src/components/ui.tsx`, layout components) over patching each screen; match the surrounding Tailwind style and the existing tokens. No new UI library, no new colors outside the tokens.
- Small, reviewable commits grouped by area ("Chat: padding around answers and file cards", …), messages in the repo's style.
- Don't change copy meaning, flows, test ids (`data-testid`), roles/aria labels, or anything about permissions.
- Desktop shell (`desktop/src/ui/*.ts`, Electron browser pane / settings panel) follows the same rules; check it if it shares the issue.

## 4. Prove it

- Same screenshot matrix again into `web/test-results/ui-polish/after/`; compare before/after for every changed screen, and check that nothing else moved unexpectedly.
- `bun run typecheck` at the repo root, `bunx playwright test` in `web/` (all e2e, incl. `a11y.spec.ts`), and `bun test tests/unit` if anything outside `web/` changed. A screenshot-based e2e that changes because of an intended visual change: update it deliberately and say so.
- Report: the findings list with ✓ fixed / – left (and why), before/after screenshot paths for the most visible changes.
