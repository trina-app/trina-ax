# The AI names files and folders by a link with their name, not by a team path

- Date (UTC): 2026-11-16 05:00
- Branch: `fix/ai-file-link-labels`
- Status: done
- Where: server/src/chat/prompt.ts. Why: the wording of the in-app AI's answers is set by its system prompt.
- Version impact: patch, a wording fix of the AI's answers

## Goal

The AI scenario check (2026-11-16 first run, root cause #1 "jargon") found answers that tell an office worker where a
file is with a raw team path in code formatting (`groups/영업/견적서/`, `users/sora/작업/`, `skills/…/SKILL.md`).
The prompt asked for that: "Say where with the team path (e.g. users/<id>/report.docx)". The person should read the
file's name as a link that opens it, and a folder by the name the Files screen shows (전사 공유, 내 폴더, …).

## Scope

In: the file-link rule (SOURCE_LINK_RULE) and the "Say where" line of both "Where you run" sections (team and guest).
Folder links already open: /files/view?path=<folder> goes to the Files screen there (web/src/lib/markdown.ts
classifyLink), so no web change. Slack keeps team paths (chat/situation.ts app line). Unit tests of the prompt text.

Out: a post-processor that rewrites backticked paths into links (see Decisions). The other jargon words ("서버",
"HTML", tool names) are PR #1057's plainWordsRule.

## Steps

1. SOURCE_LINK_RULE: name a team file or folder by a link labelled with its name (a top folder or the person's own
   folder by its name under "Team folders"), never a path in code formatting or as text, unless the person asks.
2. Both "Say where" lines: say where by that link, not the team path (guest: the name, no link page).
3. Tests in tests/unit; re-run the related scenario cases and count answers with backticked team paths.

## Decisions

- No answer post-processor for backticked paths: the answer streams to the screen as it is written
  (chat/turn.ts RedactingText), a rewrite would need the access check and the folder words per viewer of a shared chat,
  and it cannot tell when the person asked for the exact path. The prompt rule is the fix; revisit if the count stays
  high.

## Result

SOURCE_LINK_RULE, both "Say where" lines, FIND_FILE_RULE ("list the closest as links") and the Slack app line
("also where you link it") changed; tests/unit/b-prompt-file-links.test.ts. Scenario re-run of the 11 related cases:
answers with a backticked team path 9 → 1 (the one left repeats the path the person typed), passes 1 → 6 (run 1) and
3 of 9 in run 2; the rest fail on other words ("서버", "HTML", skill ids: PR #1057) or wrong claims.
