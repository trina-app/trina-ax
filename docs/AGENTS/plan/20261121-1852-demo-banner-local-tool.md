# Demo: banner words change with a local tool, not through Higgsfield

- Date (UTC): 2026-11-21 18:52
- Branch: `fix/demo-banner-local-tool`
- Status: done
- Where: server (demo fakes, tools, prompt), shared (step labels), web (step family). Why: the free-roam demo filed
  banner text editing under the fake Higgsfield connector (see docs/REPOSITORY-RULES.md)
- Version impact: patch. A demo-only fix: no API, data or setting changes.

## Goal

The owner tried the live demo (유자 진저 project) and wrote a short new headline right after a banner. Three problems:

1. `make_banner` was a tool of the fake Higgsfield connector, so the visitor got the connection's send card ("AI가
   Higgsfield에 이 내용을 보내려고 해요 … 보낼까요?") and the step read "Higgsfield · Make banner". Banner words are
   drawn on our server; nothing goes out.
2. The card showed `Headline 작지 않아\n큰 햇살이야!` with a literal backslash-n.
3. Trina asked which of two readings was meant before acting.

## Scope

In:
- A built-in, demo-only team tool `change_banner_text` ("배너 글자 바꾸기" / "Change banner text"), registered like
  the other in-process tools (tools/index.ts, exposed to turns), offered only when the demo's banner kit is there. It
  draws the banner (same typst path), saves the PNG into the chat's project folder (else the person's own folder)
  through the product's normal produced-file path (confirmSources + placeProduced, as make_file), and returns the
  picture inline plus the Markdown image to show. No connection, so no external-send card.
- `make_banner` leaves the fake Higgsfield's tool list; an old saved list that still names it gets an answer that points
  to change_banner_text. Higgsfield `generate_image` stays the tool for a new background or photo; its description
  and DEMO_BANNER_NOTE say words → change_banner_text, new background or scene → generate_image.
- A literal "\n" (and "\r\n", `<br>`) in any banner word is a real line break before typst; the step label shows the
  headline on one line.
- DEMO_BANNER_NOTE: a short phrase right after a banner is the new headline: apply it, then offer to undo.
- Kept from #262 / #269: layers, typst isolation, hostile-words tests, the disk cap (BANNERS_KEPT), one render at a
  time, last-banner defaults, the prepared-photo line, auto save and inline show.

Out: the real Higgsfield connector, the hosted demo itself (no deploy here).

## Steps

1. Move the banner drawing out of FakeHiggsfield into `demo/fakes/banners.ts` (DemoBanners, owned by DemoFakes).
2. Register `change_banner_text` (tools/demo-banner.ts) and its step label (shared/src/step-labels.ts).
3. Update the prompt note, the Higgsfield descriptions, turn.ts's banner flag.
4. Tests: demo-banner, demo-fakes, prompt; a test that the new tool raises no send card and its step says no
   Higgsfield; a test for the line break.

## Decisions

None new. Follows docs/decisions/20261119-demo-fakes.md.

## Risks

A live demo snapshot whose saved Higgsfield tool list still holds make_banner: the AI may see it; the fake then answers
with a pointer to change_banner_text. No migration. All six languages get the step label.

## Tests

`bun run typecheck`, `bun run check:prepush`, `bun run check:i18n`, every `tests/unit/*demo*.test.ts`, the demo-gate
tests, web demo-free-roam.

## Result

Built as planned. `change_banner_text` lives in server/src/tools/demo-banner.ts (registered in tools/index.ts, exposed
to turns, available only when `demoFakesOf(ctx).banners.ready`); the drawing moved to server/src/demo/fakes/banners.ts.
The step reads "배너 글자 바꾸기 · 작지 않아 큰 햇살이야!". The banner is saved straight into the project folder
(`banner-<size>-<id>.png`), so the AI no longer needs save_connector_file for it. tests/unit/c-reader-counters.test.ts
lists the new file's `users/` fallback.
