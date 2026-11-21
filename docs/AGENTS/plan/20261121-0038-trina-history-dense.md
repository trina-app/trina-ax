# Trina history: denser rows, a step bigger names, titles up to the tag

- Date (UTC): 2026-11-21 00:38
- Branch: `fix/trina-history-dense`
- Status: in progress
- Where: `web/src` (index.css list tokens, components/list/List.tsx). Why: the owner, 2026-11-21, with a screenshot of
  the sidebar's 트리나 기록: "여기 칸 사이 빈공간은 없애고 폰트 조금만 키워줄래?"
- Version impact: patch. A look fix in the web app; no API, data or setting change.

## Goal

The Trina history on a computer reads as a loose list since
[20261120-sidebar-history-row-spacing](../../decisions/20261120-sidebar-history-row-spacing.md): 36px rows 2px apart
(38px a row) with 14px names. The owner wants the air between rows gone and the names a little bigger. Some titles are
also cut early while blank space sits before the right-hand tag.

## Scope

In: the Trina history's rows on a computer (`ListRow scale="history"`: a chat's row, a task's folded runs, a group's
"N more", in the Trina panel and the filtered history): row height 36px → 32px, the 2px gap between rows removed, names
14px → 15px (the other panels' `text-row`). The title takes the room up to the tag; the tag stays right-aligned,
secondary (13px, faint) and is itself cut when long.
Out: the phone and touch screens (phone rows stay 48px / 16px, touch screens 44px or more); the other panels (30px /
15px) and the section headers.

## Steps

1. Tokens in `web/src/index.css`: `--spacing-row-history` 2rem, `--text-row-history` 0.9375rem / 1.25rem.
2. `components/list/List.tsx`: `historyRowsGap` gives no gap; find and fix what reserves blank space before the tag.
3. A decision file superseding 20261120-sidebar-history-row-spacing (its Status line updated), `changes/` note.
4. Update `web/test/e2e/type-scale.spec.ts` and `web/test/unit/type-scale-source.test.ts` to the new sizes.
5. Before/after screenshots at 1440 and 390, light and dark, ~20 rows on the mock server.

## Decisions

New: `docs/decisions/<date>-trina-history-dense.md`, superseding
[20261120-sidebar-history-row-spacing](../../decisions/20261120-sidebar-history-row-spacing.md).

## Risks

Web only. Phone unchanged (the phone tokens). Hover fills now touch between rows (no gap), as Claude's and Slack's.

## Tests

`bun run typecheck`, `bun run check:prepush`, web unit tests, e2e: type-scale, session-markers, chat-list-folds,
chat-pins, rail, phone-targets.

## Result

(filled in at the end)
