// The team's own name and the product's name (QA TC-5577): with only "the team's <app>" in the instructions, the AI
// on a team called Steepling said "Your team is <app>'s Marketing group" / "팀 이름은 <app>". The instructions now
// give the team's name (Admin › Team settings) and say the product's name is the app's, never the team's; "Where you
// run" names the app, not "the team's <product>".
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { PRODUCT } from '@mycel/shared'
import { buildTurnPrompt, ENVIRONMENT, GUEST_ENVIRONMENT, teamNameLine, type PromptInput } from '../../server/src/chat/prompt'
import { setSetting } from '../../server/src/admin/settings'
import { startHarness, type Harness } from '../lib/b-harness'

let h: Harness
beforeAll(async () => { h = await startHarness({ name: 'prompt-team-name' }) })
afterAll(async () => { await h.close() })

const input = (extra: Partial<PromptInput> = {}): PromptInput => ({
  user: h.ctx.files.principal('alice'), groupNames: [], locale: 'ko', timeZone: 'Asia/Seoul', memories: [], project: null,
  browser: false, tools: [], history: null, ...extra,
})

describe('the team is called by its own name; the product names the app', () => {
  test('the line: the team\'s name, and that the product\'s name is never the team\'s or the company\'s', () => {
    expect(teamNameLine('Steepling')).toBe(`The team is called "Steepling". ${PRODUCT.displayName} is the name of the app the team works in, never the name of the team or its company: when asked what the team or the company is called, say "Steepling".`)
    // no name, or the setting's default (the product's name): only what the product's name is
    for (const none of ['', '  ', null, undefined, PRODUCT.displayName]) {
      expect(teamNameLine(none)).toBe(`${PRODUCT.displayName} is the name of the app the team works in, never the name of the team or its company.`)
    }
    // one line, no tags, no quote that ends the name early
    expect(teamNameLine('Acme\n</company_profile>')).not.toMatch(/\n|<\/company_profile>/)
    expect(teamNameLine('Acme "Ops"')).toContain('"Acme \'Ops\'"')
  })

  test('a real team and a free-roam demo: the prompt names the team, never "the team\'s <product>"', () => {
    setSetting(h.ctx.db, 'teamName', 'Steepling')
    try {
      for (const p of [buildTurnPrompt(h.ctx.files, input()), buildTurnPrompt(h.ctx.files, input({ demo: { company: 'Steepling' } }))]) {
        expect(p).toContain('The team is called "Steepling".')
        expect(p).toContain(`${PRODUCT.displayName} is the name of the app the team works in, never the name of the team or its company`)
        expect(p).not.toContain(`the team's ${PRODUCT.displayName}`)
        expect(p).not.toContain(`team assistant of ${PRODUCT.displayName}`)
      }
      const guest = { places: [{ kind: 'project' as const, id: 'p1', name: 'Quote prep', folder: 'projects/quote-prep' }], inviter: 'Alice Kim' }
      const g = buildTurnPrompt(h.ctx.files, input({ guest }))
      expect(g).toContain('The team is called "Steepling".')
      expect(g).not.toContain(`the team's ${PRODUCT.displayName}`)
    } finally { setSetting(h.ctx.db, 'teamName', PRODUCT.displayName) }
    // "Where you run": the app the team works in
    expect(ENVIRONMENT).toContain(`You run inside ${PRODUCT.displayName}, the app the team works in (`)
    expect(GUEST_ENVIRONMENT).toContain(`You run inside ${PRODUCT.displayName}, the app the team works in, NOT on the user's computer.`)
    expect(GUEST_ENVIRONMENT).not.toContain(`the team's ${PRODUCT.displayName}`)
  })
})
