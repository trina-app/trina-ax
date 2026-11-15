# Korean particles after service names; Providers line when every account is off

- Date (UTC): 2026-11-15 09:10
- Branch: `fix/ko-particles-providers-off`
- Status: done
- Where: shared/src (one particle helper), web/src/i18n (text filling), server/src/admin/engines.ts. Why: the web app
  fills every Korean text through one function, and the Providers line is built on the server.
- Version impact: patch, two wording fixes, no new feature or API change.

## Goal

1. Tracking TC-3042 reported Korean connector pages that read "Canva을(를) 연결하면…": a form-style particle after a Latin
   service name. Korean readers expect "Canva를", "Notion을", "Gmail을", "Slack을".
2. Tracking TC-3043: on Admin › Providers, when all of a provider's accounts are only switched off, the line still lists
   "refused, expired or at their limit". It should say they are switched off and to switch one on below.

## Scope

In: one shared helper that picks a Korean particle (을/를, 이/가, 은/는, 와/과, (으)로) from how a name ends when read
aloud: Hangul and digits as today, Latin service names from a small table of known names, short all-capital
abbreviations letter by letter (AI, MCP, SQL). Unknown names keep the written-out form "을(를)". The web text filling uses it
for every placeholder followed by one of these particles, also when a closing quote sits between them, so every
Korean text on screen (connector pages, app pages, files, plugins) is fixed at once. New "all switched off" line in all six
languages.
Out: server-written texts with particles (update notices, room app lines): not connector pages; a follow-up can
use the same helper.

## Steps

1. shared/src/ko-particle.ts: the helper and the name table.
2. web/src/i18n/index.ts format(): use it (koRo and koEul stay as thin wrappers).
3. server/src/admin/engines.ts: managedAllOff when every account's reason is "disabled".
4. Unit tests: many names through the helper, format() on real templates, engine status with all accounts off.

## Plain words

Korean: "Canva를 연결하면", "이 엔진의 AI 계정이 모두 꺼져 있어요. 아래에서 하나를 켜 주세요." No internal words.

## Risks

A wrong table entry reads worse than the form "을(를)": the table holds only names whose Korean reading is common.
No migration. Six languages for the new line.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, web unit tests (i18n), tests/unit engine and i18n
tests, `bun run test:web`, `bun run build:web`, connector e2e specs. Screens in Korean at 1440 and 390.

## Result

Built as planned. Unknown Latin names keep "을(를)". On Admin › Providers the all-off line comes from the server
(managedAllOff); one account switched off beside a refused one still shows the reasons line. Tests that asserted the old
"을(를)" after Hangul names (a project, a skill) now expect the fitted particle.
