# A stored key in base64 is hidden also when line breaks split it

- Date (UTC): 2026-11-15 14:32
- Branch: `fix/hide-base64-across-breaks`
- Status: in progress
- Where: server/src/integrations/connections (hide.ts, redact.ts). Why: the server's key hiding (see
  docs/REPOSITORY-RULES.md)
- Version impact: patch, a security fix with no new feature or API change

## Goal

The AI wrote a person's stored connection key in base64 and a tool call fell inside it. Both engines put a blank line
around a tool call (`claude-parse.ts`, `codex-parse.ts`), so the answer held the base64 in two parts with "\n\n"
between them, and hide.ts's base64 patterns, which need the characters next to each other, did not hide it (QA
tracking TC-3096). Base64 wrapped at 76 characters has the same problem.

## Scope

In:
- hide.ts: the base64 patterns (and the value with every character %-escaped, JSON \u-escaped or as an HTML entity)
  also match with white space, or a JSON-escaped \n, \r, \t, between their characters. The value as written stays
  strict: "QA FAKE KEY" is ordinary text.
- redact.ts: the live answer also holds back a line break inside a run of base64 characters at the end (not spaces:
  prose keeps flowing).

Out: a key split as written (letters with spaces between them); hashed, hex or reversed forms (as before).

## Steps

1. Plan (this commit).
2. hide.ts and redact.ts.
3. Unit tests that fail without the fix: split forms hidden, ordinary text (prose, base64-looking words, code,
   Korean) unchanged.

## Risks

No migration, no UI text. Pattern size grows a little per stored key; the patterns stay linear (fixed characters with
an optional break run between them). Plain-words check: no new words; the mark is the existing "[hidden key]".

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, tests/unit c-integrations-*.

## Result

Filled in at the end.
