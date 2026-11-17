# Plain words and checked facts in answers to team members

- Date (UTC): 2026-11-17 05:50
- Branch: `fix/ai-wording-jargon`
- Status: done
- Where: server/src/chat and server/src/policy. Why: the words come from tool results, refusal notes and the per-turn prompt.
- Version impact: patch, wording in tool output and the prompt; no API or data change

## Goal

Real-AI scenario cases of 2026-11-17 (catalog run 01-18-18, access rerun 02-40-23) showed answers to members with
internal words or claims the AI could not back: "server" and "nobody can" (ADM-07.member), English skill ids instead
of the names people see (SKL-04), no "you are not a member" (PRJ-01.outsider), no "who can" for project members
(PRJ-03.project), the whole skill text pasted to copy by hand (SKL-02.member), "Seoul" (ADM-05.member).

## Scope

In: find each cause in the run records; fix tool output and refusal notes first (skill titles next to ids, a
read-only team-skill note, a not-a-member note after a refused projects/ call, who changes a project's members in a
shared project chat, "server" in the plain-words rule). Prompt words flat or fewer.
Out: the app map (chat/app-map.ts and its prompt section, owned elsewhere); judge and catalog artefacts (ADM-05
"Seoul" comes from the team time zone setting the AI is given).

## Steps

1. Failing tests pinning each new text (tests/unit/ai-wording-jargon.test.ts).
2. The fixes; decision note and changes fragment.
3. Independent review; fixes.
4. Real-AI run of the six cases, 2 runs, on Sonnet, before and after.

## Decisions

docs/decisions/20261117-ai-wording-jargon.md

## Result

Four real fixes (SKL-04, SKL-02.member, PRJ-01.outsider, PRJ-03.project) and the plain-words rule; ADM-05.member and
part of ADM-07.member are judge artefacts. Before/after in the branch report.
