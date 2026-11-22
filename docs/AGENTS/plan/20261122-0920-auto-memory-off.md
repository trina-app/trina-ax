# Auto memory off means off: save only when the person's own message asks

- Date (UTC): 2026-11-22 09:20
- Branch: `fix/auto-memory-off`
- Status: done
- Where: server/src/chat (remember, auto-memory checks). Why: the AI and its memories are component B (docs/WORKPLAN.md).
- Version impact: patch: a bug fix; the switch now does what it says.

## Goal

QA on qa.trina.app (TC-7737, PR #332): with "자동으로 기억하기" OFF, "저는 보고서를 읽을 때 항상 요약이 맨 위에 있는 걸
좋아해요" and "앞으로 회의록은 항상 표로 정리해서 줘" were saved with the 기억함 step and no card. With the switch off the
model still called remember (the old prompt line lets it, and `asked: true` is the model's own claim), and the server
kept it on the clean-chat path.

## Scope

In: with the switch OFF, the server keeps a memory only when the person's own message of this turn asks for it in so
many words (a keyword list in ko, en, ja, zh, es, id: 기억해, 잊지 마, remember, don't forget, keep in mind, 覚えて, 记住,
recuerda, ingat …). Otherwise the call is skipped silently: the tool answer says automatic memory is off and the person
can say "기억해 줘" or add it in Settings › Memory. No card. `asked: true` never overrides it. An explicit request in a
chat with outside content keeps today's card (as before #332).
Out: the switch ON (unchanged), the prompt.

## Steps

1. `asksToRemember(text)` in chat/auto-memory.ts, the person's message of the turn read on the server.
2. remember: the gate before any save when the switch is off.
3. Unit tests: off + a stated preference → nothing; off + "이거 기억해 줘: …" → kept; off + asked:true without the
   words → nothing; on unchanged.

## Decisions

Adds to [docs/decisions/20261122-auto-memory.md](../../decisions/20261122-auto-memory.md) (its "Off is today's
behaviour" now means: only on the person's explicit words).

## Tests

`bun run typecheck`, `bun run check:prepush`, tests/unit/auto-memory.test.ts, tests/unit/b-chat.test.ts.

## Result

Built as planned: `asksToRemember` (chat/auto-memory.ts) gates remember when the switch is off; tests in
tests/unit/auto-memory.test.ts (off + preference, off + asked:true, off + "기억해 줘"; the on cases unchanged).

Security review of #377 (APPROVE) follow-ups: only a request shape counts (an imperative or "please …", "기억해 줘",
"覚えておいて", "记住", "recuerda", "tolong ingat"); negations ("don't remember", "기억하지 마", "不记得", "tidak ingat",
"覚えてない", "no recuerdo") and questions ("Do you remember…?", "기억나?") do not, and quoted lines (`withoutQuoteLines`)
are left out. Tests that ran the switch-off path now say "please remember this" in the person's message.
