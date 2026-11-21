# A free-roam visitor's demo limit counts cache writes at 0.1; the gate's day counts them fully

- Date: 2026-11-21
- Status: accepted
- Supersedes: the weight in [docs/decisions/20261119-demo-free-roam-a.md](20261119-demo-free-roam-a.md) "Rule: the
  demo limit" (cache writes counted fully)
- Branch: fix/demo-question-meter (the owner, live on demo.trina.app)

- **Ask:** the bar says "About 8 questions left" and drops to "About 5" after one question. Visitors feel cheated.
- **Rule:** the visitor's demo limit weighs a cache write like a cache read: uncached input + output + 0.1 × (cache
  reads + cache writes) (shared `DEMO_CACHE_WRITE_WEIGHT`, server credentials/broker.ts `record`, free-roam only).
  demo-gate's per-visitor backstop (`inst.tokens` against the instance's limit × `instanceCapMargin`) counts the same
  (demo-gate/src/model.ts `visitorWeighted`). demo-gate's daily cap (`dailyWeightedTokens`), its stats, the rate-limit
  pause and utilization stay on the true weight (cache writes counted fully, `weighted`). Each `upstream usage` log line
  has both counts and the usage fields, so a question's cost can be measured from the log next time.
- **Why:** a fresh copy's first question writes the system prompt and the tools to the cache: about 90k true tokens,
  2.6 questions at 35k, before the visitor asked anything big. The gate's stats for 11-21 (ko: 9 questions, 407,098
  true tokens, 3 copies) average 45k a question in the old weight, so 300k read as about 6. In Trina engine sessions on
  this Mac, cache writes were about 40-60 % of a warm question's old-weight count and about 90 % of a cold one's. In the
  new weight a typical question is about 20k-25k, the first one about the same, a banner edit about two.
  `DEMO_QUESTION_TOKENS` stays 35k: the bar starts at "about 8" (the landing's words) and the first question leaves
  "about 7". The backstop follows the instance, or it would stop a visitor ("resting") while their bar says questions
  are left.
- **Trade-off:** a visitor can now use more true tokens before the limit (the cold start and the writes of each answer
  no longer count fully), up to roughly 10-12 questions of real use. The daily cap still bounds the whole demo. If that
  is too much per visitor, lower the demo file's `limitTokens` (about 210k with a 25k question constant keeps "about
  8" and today's use per visitor).
- **Left out:** changing the limit or the landing text.
- **Tests:** tests/unit/a-demo-free-roam.test.ts (the limit's weights, a cold first question leaves about 7),
  demo-gate/test (the visitor's count, the per-instance cap, the day and the log line).
- **Version impact:** patch.
