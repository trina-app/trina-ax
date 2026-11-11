# Files search finds files by name first, then lines; HTML lines as text

- Date (UTC): 2026-11-11 19:29
- Branch: `fix/files-search-names-first`
- Status: done
- Where: trina-ax core (web/src Files screen, server/src/team-files). Why: the file screen's search is core (docs/REPOSITORY-RULES.md).
- Version impact: patch, a fix of the file screen's search (no API change)

## Goal

QA TC-260 (FILES-16): the Files search only searched inside files. "로고" did not find 로고.png, a quotation PDF was not
found by its file name, and a line of an HTML file showed its markup (`<!doctype html>…`). People search a file by its
name first.

## Scope

In:
- The Files search shows the files and folders whose name holds the words (the ⌘K name search, GET /api/files/find
  with `folders=1`, under the open folder) above the lines that contain the text. Same permission checks as ⌘K
  (team-files/find.ts: allowedRoots + visiblePath per hit, siblingVisible for folders); nothing in them changes.
- A line of an .html/.htm/.xhtml file is shown as its readable text (tags, scripts and styles out, entities decoded, the
  web_fetch tool's one-pass htmlToText); a line whose match is only in the markup (a tag or an attribute) is not shown.
- Korean names in NFC or NFD (macOS) match with a query in either form (test; find.ts already folds both to NFC).
- Search box label/placeholder say "files", not only "contents", in the five languages.

Out: lines inside a multi-line `<script>`/`<style>` block (a line on its own has no tag to see); searching the
text of an HTML file as a whole document.

## Steps

1. server/src/team-files/content-search.ts: HTML hits through htmlToText per line; drop markup-only hits.
2. web/src/components/FileContentSearch.tsx: FileNameResults (debounced findFiles, newer answer wins), shown by
   Files.tsx before FileContentResults. A file opens in the side panel, a folder opens in the list.
3. i18n (5 languages), changes/files-search-names-first.md.
4. Tests: server unit (names NFC/NFD, permissions, HTML snippet), web unit (name list), Playwright 390 and 1440.

## Risks

Permissions: only the existing find endpoint is used. One more request per search (the same as ⌘K, debounced). Phone
layout of the result list (Playwright at 390).

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, tests/unit/file-content-search.test.ts,
tests/unit/attach-team-files.test.ts, web/test/unit/file-content-search.test.tsx, Playwright at 390 and 1440.

## Result

Built as planned. The Files search shows the ⌘K name search (files and folders, under the open folder) above the line
matches; an HTML line is its plain text (a new `plain` option of web_fetch's htmlToText: no link, heading, list or
table marks, so nothing is stripped afterwards by a pattern). The name list keeps its last answer while the next one
loads, so the lines below do not jump. Known limits (in the code): ripgrep's per-file cap counts HTML lines before the
markup-only check; a line inside a multi-line `<script>`/`<style>` stays as written; GET /api/files/find has no rate
limit (as for ⌘K). PR: see the branch's pull request.
