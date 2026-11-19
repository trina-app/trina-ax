# QA 11-19 project area: page marks in a long room PDF's text

- Date (UTC): 2026-11-19 07:10
- Branch: `qa/1119-project`
- Status: in progress
- Where: server/src/chat/room-tools.ts. Why: the room file reader is core chat code (docs/REPOSITORY-RULES.md).
- Version impact: patch, the AI's view of a room PDF's text gets page marks; no API or data change.

## Goal

AI parity QA cases AP-052 (project instructions), AP-053 (project file used without attaching), AP-054 (a page of an
80-page PDF sent in a room) and AP-060 (two members in one project at once). Run each against a local instance with the
real Claude engine and fix what is wrong.

## Scope

In: when room_file gives a PDF of more than 10 pages as its text (no `pages`, or `offset`), the text marks where each
page starts (`[p.N]`, the grep/read convention) and the result says how many pages there are and that `pages` reads one
page. Before, page breaks were form feeds only, and the 40,000-character window gave no page numbers, so a question
about "page 47" could only be answered by counting form feeds or reading on.
Out: "@Trina" in rooms (removed by the owner, DECISIONS.md "Room @트리나 code removed"; the side chat asks instead);
a project file listing in the instructions (AP-053 passed without it: the AI globbed and read the project folder);
the AI-app connection's room_file (its schema has no pages).

## Steps

1. Browser runs of the four cases (owner + member, real Claude engine).
2. roomPdf text path: `[p.N]` marks and the page note; unit test in tests/unit/room-file-pdf.test.ts.
3. typecheck, the unit test, check:docs.

## Decisions

No new decision: the 40,000-character window per call stays (DECISIONS.md "내 AI 채팅에서 대화방 읽기", Limits); the
page-aware `pages` read already existed (DECISIONS.md "room_file reads a scanned PDF's pages").

## Result

(filled in at the end)
