// Answers claimed what no action of the turn showed: a team time zone never read (ADM-05), "I'll show a connect card"
// after the call had failed (CON-02), "I cannot delete it" without trying (SKL-09), "nothing on file" without reading the
// room that held it (FLOW-03) (AI scenario check 2026-11-16, root cause #3; docs/AGENTS/plan/20261116-0500-ai-wrong-claims.md).
// One short rule in the turn rules (server/src/chat/prompt.ts SHOWN_ONLY_RULE) and a shorter one for sub-agents.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { buildSubagentPrompt, buildTurnPrompt, CONNECT_RULE, ROOMS_RULE, SHOWN_ONLY_RULE, SUBAGENT_SHOWN_ONLY_RULE, type PromptInput } from '../../server/src/chat/prompt'
import { startHarness, type Harness } from '../lib/b-harness'

let h: Harness
beforeAll(async () => { h = await startHarness({ name: 'prompt-shown-only' }) })
afterAll(async () => { await h.close() })

const input = (extra: Partial<PromptInput> = {}): PromptInput => ({
  user: h.ctx.files.principal('alice'), groupNames: [], locale: 'ko', timeZone: 'Asia/Seoul', memories: [], project: null,
  browser: false, tools: ['ask_user'], history: null, ...extra,
})

describe('say only what the actions showed', () => {
  test('the rule names the cases and what to say when nothing was checked; short', () => {
    expect(SHOWN_ONLY_RULE).toContain('Say only what your actions this turn showed')
    for (const c of ['a setting you did not read', 'a card after a failed call', 'page text you did not get', '"nothing on file" for places you did not read, rooms too', 'will show'])
      expect(SHOWN_ONLY_RULE).toContain(c)
    expect(SHOWN_ONLY_RULE).toContain('Not checked? Say so.')
    // about 60 tokens: it is in every new session's instructions
    expect(SHOWN_ONLY_RULE.split(/\s+/).length).toBeLessThanOrEqual(55)
    expect(SUBAGENT_SHOWN_ONLY_RULE.split(/\s+/).length).toBeLessThanOrEqual(15)
  })

  test('in every chat that keeps the tool rules, once; and in a sub-agent\'s rules', () => {
    for (const p of [
      buildTurnPrompt(h.ctx.files, input()),
      buildTurnPrompt(h.ctx.files, input({ locale: 'en', tools: [] })),
      buildTurnPrompt(h.ctx.files, input({ shared: { project: 'Atlas', audience: 3, asker: 'Alice Kim' }, roomReadable: () => true })),
    ]) expect(p.split(SHOWN_ONLY_RULE).length).toBe(2)
    expect(buildSubagentPrompt(h.ctx.files, input(), ['read', 'write'])).toContain(SUBAGENT_SHOWN_ONLY_RULE)
  })

  test('a connect card is said only after the call showed one (CON-02); rooms are searched for client facts (FLOW-03)', () => {
    expect(CONNECT_RULE).toContain('Say a card is shown only after connect_service returned one; never announce it first.')
    expect(ROOMS_RULE).toContain('search them too for facts about a client or deal before saying nothing answers it')
  })
})
