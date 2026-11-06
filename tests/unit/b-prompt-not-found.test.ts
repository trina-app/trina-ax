// What the assistant and its sub-agents are told about refused tool calls (server/src/chat/prompt.ts). The file tools
// answer "Access denied: not found or no access: '<path>'" both for a file that does not exist and for one the person
// cannot open (on purpose: the answer must not tell them apart). The instruction names that exact text, so it cannot
// clash with the line before it ("tell the user plainly" when a tool refuses, e.g. read-only), and the AI never says or
// guesses that a closed file exists.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { buildSubagentPrompt, buildTurnPrompt } from '../../server/src/chat/prompt'
import { Denied } from '../../server/src/policy/errors'
import { harness, withOwner, type Harness } from './a-lib'

let h: Harness
beforeAll(async () => { h = await harness('prompt-not-found'); await withOwner(h) })
afterAll(async () => { await h.close() })

const input = () => ({ user: h.ctx.files.principal('olga'), groupNames: [], locale: 'ko' as const, timeZone: 'UTC', memories: [], project: null, browser: false, tools: [], history: null })

describe('"not found or no access" in the instructions', () => {
  test('the tools\' own words are what the instructions quote', () => {
    // files/service.ts and tools/registry.ts prefix a policy refusal with "Access denied: "
    expect('Access denied: ' + new Denied('not found or no access').message).toBe('Access denied: not found or no access')
  })

  test('the assistant: read-only refusals plainly; the exact denied answer as not found among the files they can open', () => {
    const p = buildTurnPrompt(h.ctx.files, input())
    expect(p).toContain('If a tool refuses (for example "read-only: you cannot change …"), tell the user plainly')
    expect(p).toContain(`A tool answer "Access denied: not found or no access: '…'" is the same for a file that does not exist and one this person cannot open`)
    expect(p).toContain('say you could not find it in the files they can open, and do not say or guess that it exists or that permission is the reason')
    // the older wording that told the AI to report every denial as "access denied" is gone
    expect(p).not.toContain('If a tool says access is denied')
  })

  test('the sub-agent says the same in its report', () => {
    const p = buildSubagentPrompt(h.ctx.files, input(), ['read', 'glob'])
    expect(p).toContain('If a tool refuses (for example "read-only: you cannot change …"), say so in your report')
    expect(p).toContain(`Report a tool answer "Access denied: not found or no access: '…'" as not found among the files this person can open`)
    expect(p).toContain('without saying or guessing that it exists or that permission is the reason')
    expect(p).not.toContain('If a tool says access is denied')
  })
})
