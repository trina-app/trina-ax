# Research answers carry source figures faithfully

- Date (UTC): 2026-11-25 08:51
- Branch: `fix/research-figure-fidelity`
- Status: done
- Where: server/src/tools/web-fetch.ts, server/src/chat/prompt.ts. Why: the page reader and the instructions every
  engine and sub-agent gets are core (see docs/REPOSITORY-RULES.md)
- Version impact: patch: answers and page fetches get better, no new feature, setting or data

## Goal

QA A-11-M (Top 50 tasks 2026-11-24, Mac, "Worse" than Claude Code): a cited brief said the UK four-day-week pilot gave
"71% less burnout and 39% less stress"; the source says 71% / 39% **of staff reported** less burnout / stress. The
turn's record shows why: `web_fetch` of the source page (autonomy.work) failed ("the site sent no valid HTTP
response"), so the AI wrote the figures from WebSearch's result text, a summary another model wrote, and lost what the
percentages count. No instruction says that a figure keeps its unit and population, that a search summary is not the
source, or that cited links must be ones a tool returned. Sub-agents get none of the honesty rules.

## Scope

In:
1. web_fetch: the site dropped the connection because of our `Mozilla/5.0 (compatible; …)` User-Agent (a common
   WAF rule; the same request with a plain `<app>-fetch/1.0` agent answers 200). When a site drops the connection or
   answers 403/406 to the first agent, try once more with the plain agent inside the same time limit (web_fetch; save_url
   has its own streaming request and is left for later).
2. One rule for answers built from the web (every engine, and sub-agents): a figure keeps what it counts (unit, base,
   population, percent vs points, currency and year, period, hedges), in any language; state and cite a figure only
   from a page whose text you read; a search result's text is a summary, not the source; when the source cannot be
   opened, find another page that states it or mark the figure as from a search summary; links only from tool results;
   before sending a cited answer, check each figure against what you read.
3. Held-out eval: ≥8 prompts (EN/KO; percent of a population, ratios, currency, dates; different sources) run through
   the real engine before/after (tests/ai-scenarios, Claude Code login), judged figure by figure against the source.

Out: a server-side checker that rewrites answers; Codex search path changes (codex-search-step.ts keeps its own text).

## Steps

1. Plan (this file).
2. web_fetch / save_url fallback agent + unit tests (a test server that drops the first agent).
3. WEB_FIGURES_RULE in prompt.ts for the main prompt and the sub-agent prompt + unit tests.
4. Eval before/after; numbers in Result.
5. typecheck, check:prepush, unit tests; changes/research-figure-fidelity.md.

## Decisions

none (an instruction line and a fetch retry).

## Risks

Prompt length (one rule, about 120 words). A retry doubles a refused fetch's time at most within the same 30 s limit.
No migration, no UI, no i18n.

## Tests

`bun run typecheck`, `bun run check:prepush`, tests/unit/c-webfetch.test.ts and the prompt tests.

## Result

- web_fetch: `FETCH_AGENTS` + `pinnedGetEither` (server/src/tools/web-fetch.ts). A panel of 30 report/news/statistics
  sites by curl: the plain agent was never worse than the first, and opened autonomy.work, which drops the first.
- `WEB_FIGURES_RULE` (server/src/chat/prompt.ts) in every turn and sub-agent prompt that has web_fetch; example figure
  is not the QA case's. Engine prompt pins re-recorded (one added line each).
- Eval: tests/ai-scenarios/figure-eval.ts. 11 prompts (A0 = the QA prompt, F1-F10 held out: 6 EN, 4 KO), 3 runs each
  before and after on the real engine (local Claude Code login), every linked figure checked by a Sonnet judge against
  the text of the page it links (same judge for both sides).

  | | before | after |
  |---|---|---|
  | held-out: figures wrong for their cited page (misstated + not there) | 9 of 311 (2.9%) | 5 of 420 (1.2%) |
  | held-out: misstated | 2 | 1 |
  | held-out: pages read (web_fetch) per answer | 3.1 | 4.1 |
  | held-out: links not from any tool result / dead | 1 / 0 of 107 | 0 / 0 of 95 |
  | QA prompt: wrong figures | 4 of 47 | 1 of 35 |
  | QA prompt: pages read per answer | 2.3 | 5.7 |

  The QA case's own misstatement did not recur in 6 runs (3 before, 3 after); the class it belongs to went down.

