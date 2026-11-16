// Answers claimed what no action of the turn showed: a team time zone never read (ADM-05), "I'll show a connect card"
// after the call had failed (CON-02), "I cannot delete it" without trying (SKL-09), "nothing on file" without reading the
// room that held it (FLOW-03) (AI scenario check 2026-11-16, root cause #3; docs/AGENTS/plan/20261116-0500-ai-wrong-claims.md).
// One short rule in the turn rules (server/src/chat/prompt.ts SHOWN_ONLY_RULE) and a shorter one for sub-agents.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { buildSubagentPrompt, buildTurnPrompt, SHOWN_ONLY_RULE, SUBAGENT_SHOWN_ONLY_RULE, type PromptInput } from '../../server/src/chat/prompt'
import { B_TOOL_DESCRIPTIONS } from '../../server/src/chat/tools'
import { ROOM_TOOL_DESCRIPTIONS } from '../../server/src/chat/room-tools'
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
    expect(SHOWN_ONLY_RULE).toContain('Never claim you checked, set, found or will show something no action (this turn or earlier in this chat) or your instructions showed')
    for (const c of ['a setting you did not read', 'a card after a failed call', 'page text you did not get', '"nothing on file" for places you did not read (rooms included)', 'will show'])
      expect(SHOWN_ONLY_RULE).toContain(c)
    expect(SHOWN_ONLY_RULE).toContain('Not checked? Say so.')
    // about 70 tokens: it is in every new session's instructions (capped by characters)
    expect(SHOWN_ONLY_RULE.length).toBeLessThanOrEqual(320)
    expect(SUBAGENT_SHOWN_ONLY_RULE.length).toBeLessThanOrEqual(80)
  })

  test('in every chat that keeps the tool rules, once; and in a sub-agent\'s rules', () => {
    for (const p of [
      buildTurnPrompt(h.ctx.files, input()),
      buildTurnPrompt(h.ctx.files, input({ locale: 'en', tools: [] })),
      buildTurnPrompt(h.ctx.files, input({ shared: { project: 'Atlas', audience: 3, asker: 'Alice Kim' }, roomReadable: () => true })),
    ]) expect(p.split(SHOWN_ONLY_RULE).length).toBe(2)
    expect(buildSubagentPrompt(h.ctx.files, input(), ['read', 'write'])).toContain(SUBAGENT_SHOWN_ONLY_RULE)
  })

  test('the connect card point is said once (CON-02); rooms are searched for client facts (FLOW-03)', () => {
    // said once, in the rule (and in the refusal itself), not again in the tool description
    expect(B_TOOL_DESCRIPTIONS.connect_service).not.toContain('Whether a card is shown')
    expect(ROOM_TOOL_DESCRIPTIONS.rooms).toContain('search it by name for what was said about a client, deal or project before saying nothing answers a question')
  })
})
