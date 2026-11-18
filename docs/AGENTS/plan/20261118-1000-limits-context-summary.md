# A fresh session gets a summary of the older part, not only the last 40,000 characters

- Date (UTC): 2026-11-18 10:00
- Branch: `fix/limits-context-summary` (off `dev`)
- Status: in progress
- QA: TC-4905
- Where: Team AX core (`server/src/chat/`). Why: chat is core (docs/REPOSITORY-RULES.md)
- Version impact: patch, one additive migration

## Goal

A fresh engine session (every Codex or API message, every edit or regenerate, a change of person in a shared chat, a
Claude session dropped at 20 MB) gets only the newest 40,000 characters of the chat text. Older facts are gone: no
summary, no file paths, no decisions. Claude Code keeps the whole session and compacts it with a summary. Do the same.

## Scope

In:
1. A summary of the older part: one cheap model call (the file list's reader: Haiku, or Codex's nano/mini, on a
   team-wide AI account), cached per chat and person, keyed by a hash of exactly the text it was made from, so a branch
   (edit, regenerate) reuses the summary of the shared beginning and a changed beginning never reuses a wrong one.
   Updated in steps: when the recent part outgrows the window, the summary is extended so the recent part is half the
   window again (one call per half window of new text). Key facts, decisions, file paths touched (the step labels of
   the person's own answers), open tasks.
2. Shared chats: the summary is built from the same transcript the person whose turn it is gets (labels, hidden answers
   as one line, attachments as they may see them, step lines only of their own answers) and kept per person; a change
   in what they may see changes the hash, so an old summary is not used.
3. The window is token-based (an estimate: 4 Latin characters or 1 other character per token), 40,000 tokens: 160,000
   characters of English, the same 40,000 of Korean.
4. The session stash: pictures in older turns of the saved Claude session are replaced by a short note when it is over
   8 MB (the newest turn keeps its pictures), and the stash cap goes from 20 MB to 48 MB (the launcher's own cap).

Out: no summary without a team-wide AI account (then the old window with the count, as now); guests, confidential
chats, drafts and template runs keep the old window.

## Steps

1. Plan (this file).
2. prompt.ts: token window, summary in `<previous_conversation>`; history-summary.ts (cache, hash, refresh, AI call);
   migration 418; turn.ts: wait at most 30 s for the summary on a fresh session, refresh after a fresh turn.
3. session-slim.ts and the stash change.
4. Unit tests (b-history-summary), decision file, changes note, i18n step label.
5. Real-AI check on a copy of the QA team: an early detail, a long chat, regenerate, ask about the detail.

## Risks

A summary leaking what a person may not see in a shared chat: built only from their transcript, kept per person,
reused only on an exact hash match. Latency: at most 30 s once per half window, then cached; the refresh after a fresh
turn runs in the background. Cost: one Haiku call of up to ~60,000 tokens per half window of new text.
