# Phone app: the load end's question asks about a document id, not the bridge's nonce

- Date (UTC): 2026-11-12
- Branch: `fix/mobile-same-document-id` (follow-up to #625, QA TC-251)
- Status: PR to dev, not checked on a device (native: ships with the next app build, 10)
- Where: trina-ax `mobile/` (the phone app). Why: the question is the app's own script; the page side does not change.
- Version impact: patch (hardening, no visible change).

## Goal

#625's `sameDocumentScript` sent the bridge's current nonce into whatever page is on screen at a load end. A new page
that overrides `JSON.stringify` or `ReactNativeWebView.postMessage` could read it, stay silent, keep the old bridge
and fetch the previous page's unfinished pick bytes. Ask about a separate, non-secret random id instead.

## Scope

In: a document id (16 random bytes, hex) set with the bridge (`documentScript` in `bootstrap`), the question about that
id with no page JSON call and no nonce, `readNewDocument`'s strict parsing kept. Out: the web page (unchanged).

## Steps

1. `mobile/src/bridge.ts`: `documentId`, `documentScript`, `sameDocumentScript(id)`, `readNewDocument(data, id)`.
2. `mobile/App.tsx`: a new id in `loaded()` with the nonce, in `bootstrap`; the load end and its answer use it.
3. Unit test in `tests/unit/mobile-photos.test.ts`.

## Risks

A session reset's `bootstrap(r.config)` keeps the id (it is set only on a new document). A load end before the first
id: no question, the bridge is installed as before.

## Tests

`npm --prefix mobile run typecheck`, `npm --prefix mobile test`, `bun test tests/unit/mobile-*.test.ts`.

## Result

The question and the answer carry only the document id; a page that hooks postMessage or JSON learns the id, which
opens nothing, and cannot keep the old bridge's nonce. Unit test covers the same document, a new one, a hooked JSON,
another id, the strict answer and ids that never go into a script.
