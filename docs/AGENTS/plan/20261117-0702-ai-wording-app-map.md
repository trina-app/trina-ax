# The AI's app map names five more places: Shared with me, answer threads, Open the app, meeting notes, folder sharing

- Date (UTC): 2026-11-17 07:02
- Branch: `fix/ai-wording-app-map` (stacked on `batch/1117a`, which carries #1185's app map change)
- Status: done
- Where: server/src/chat/app-map.ts (the "Where things are in the app" section of every turn's instructions). Why: the
  AI's map of the app lives there (docs/decisions/20261116-ai-app-map.md).
- Version impact: patch (the AI's answers change; no screen, API or data change)

## Goal

A real-AI rerun of the scenario catalog (2026-11-17) found the AI answering "I'm not sure, the guide doesn't mention it"
in 12 cases (ACC-04/05/06, CHT-13/14/16, SHR-03, FSH-03, MTG-01/02) because the map has no line for five shipped
features. People asking "where do I see files shared with me", "can we talk under an answer", "how do I go on in the
desktop app", "can it take meeting notes", "what can people do in a folder I share" get a hedge instead of the place.

## Scope

In: one short entry each, with the app's own labels in the person's language (generated from web/src/i18n):
- Files › Shared with me (filesPanel.shared);
- Reply in thread under a finished answer of a shared chat, Send to <AI> (rooms.replyInThread, chat.thread.sendToAi);
- Open the app in a Mac or Windows browser (openApp.lineLink, openApp.download);
- Take meeting notes, desktop app on a Mac (meeting.entry), notes in My files › Meetings — checked shipped on this base:
  merged (Meeting notes 1/4–4/4), no flag; shown only in the Mac desktop app (not the store build) when the team has
  voice input;
- folder sharing: Share on a folder in one's own files (folderAccess.menu), view only, Stop sharing, Undo for 10
  minutes (fileShare.stop, common.undo) — the gate FOLDER_SHARES_OPEN is open on this base.
Out: per-install conditions for meeting notes (voice input off, Windows) beyond one plain clause; a help tool.

## Steps

1. Failing tests in tests/unit/ai-app-map.test.ts: every view and language names the five places with the real labels;
   the size test stays.
2. Measure the per-turn size the test's way (before: 893 tokens, the longest form, shared chat in Korean; cap 900).
3. Add the keys to app-map-keys.ts, regenerate app-map-labels.ts (`bun scripts/app-map-labels.ts`), write the entries;
   tighten other lines and merge lines to stay under the line cap; keep the token cap unless the measured need says
   otherwise (then the reason goes in the decision note).
4. Decision note docs/decisions/20261117-ai-app-map-five-places.md, changes/ai-wording-app-map.md.
5. Checks: typecheck, the touched tests also under Bun 1.3.12, check:prepush. Independent review. Real-AI before/after on
   the 12 cases.

## Decisions

docs/decisions/20261117-ai-app-map-five-places.md (extends docs/decisions/20261116-ai-app-map.md).

## Risks

Every turn's instructions grow; the map is in every fresh session's instructions. Wording must stay plain (no tool
names). Labels in six languages come from the generator, so no hand-written Korean in server code.

## Tests

`bun run typecheck`, tests/unit/ai-app-map.test.ts (also under Bun 1.3.12), ai-situation, `bun run check:prepush`.

## Result

Built as planned, with one difference: the size cap moves from 900 to 1,200 (measured: the longest form, an owner's or
admin's in Korean, 886 → 1,189 tokens by the test's estimate; reasons in
docs/decisions/20261117-ai-app-map-five-places.md). The size test now covers all six languages. Meeting notes were
shipped on this base (no flag), so they are in. The independent review added the team's switch for members' sharing,
the Continue in the Mac app button, "not the Mac App Store build" for meeting notes, kept Google Forms and Claude in
their lines, and cut the shared chat's thread line to its labels.

Real AI on the 12 results (two runs each, relay on): before 0/12 and 1/12 passed; after 10/12 and 10/12. The after
failures were MTG-02 twice (no file save facts; the map now says notes are saved every 2 minutes and the card offers a
line to tell the call, not rerun), ACC-05 once and CHT-14 once (the judge called true labels or facts invented). No PR
yet (local branch only).
