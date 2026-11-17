// The AI scenario runner keeps cases apart: a case meant for the shared project chat is asked by someone who can open
// that chat (the runner no longer falls back to a personal chat), what one case changes in who can open what is seen
// and put back (lib/state-guard.ts), and the card check reads the cards of the turn that used the tool.
import { describe, expect, test } from 'bun:test'
import { loadCatalog } from '../ai-scenarios/lib/catalog'
import { COMPANY, PROJECT } from '../ai-scenarios/fixture/seed'
import { driftOf, type State } from '../ai-scenarios/lib/state-guard'
import { runChecks } from '../ai-scenarios/lib/checks'
import type { Check, TurnRecord } from '../ai-scenarios/lib/types'

const cases = loadCatalog()

describe('AI scenario runner: places and state', () => {
  test('every shared project chat case is asked by a member of the project', () => {
    const rules = COMPANY.rules.find((r) => r.path === PROJECT.folderPath)!.rules
    const groups = new Set(rules.flatMap((r) => ('group' in r ? [r.group] : [])))
    // the project's creator (the owner, who seeds it), its member groups' people and the people named on it
    const members = new Set(['jiwoo', ...rules.flatMap((r) => ('user' in r ? [r.user] : [])), ...COMPANY.people.filter((p) => p.group && groups.has(p.group)).map((p) => p.username)])
    const outside = cases.filter((c) => c.context === 'project' && !members.has(c.as)).map((c) => `${c.id} (${c.as})`)
    expect(outside).toEqual([])
  })

  test('drift lists what was added and what is gone, per kind', () => {
    const base: State = { rules: ['groups/a|group|g1|write'], groups: ['g1|sora'], skills: ['skills/quote-writer'], always: [], rooms: [], links: [] }
    const now: State = { ...base, rules: ['groups/a|group|g1|write', 'groups/a|group|g2|read'], skills: ['groups/a/skills/quote-writer'] }
    expect(driftOf(base, now)).toEqual(['+ rules: groups/a|group|g2|read', '+ skills: groups/a/skills/quote-writer', '- skills: skills/quote-writer'])
    expect(driftOf(base, base)).toEqual([])
  })

  test('card_or_not_used fails a turn that used the tool with no server card', async () => {
    const turn = (tools: string[], cards: TurnRecord['cards']): TurnRecord => ({ prompt: 'p', status: 'done', error: null, answer: 'a', tools: tools.map((name) => ({ name, input: {}, ok: true })), cards, saved: [], ms: 1, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, apiCalls: 0 }, model: null })
    const check: Check = { type: 'card_or_not_used', tools: ['read'] }
    const run = async (turns: TurnRecord[]) => (await runChecks([check], { teamRoot: '/nonexistent', changed: [], turns, room: '' }))[0]!.ok
    expect(await run([turn(['read'], [])])).toBe(false)
    expect(await run([turn(['read'], [{ kind: 'server-card', origin: 'server', question: 'q', answer: 'share' }])])).toBe(true)
    expect(await run([turn(['glob'], [])])).toBe(true)
  })
})
