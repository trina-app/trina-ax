// "Connect your tools" on the My setup card (lib/myTools.ts; docs/decisions/20261120-my-setup-card.md): the team's
// recommended tools first, then the usual ones, at most four; a member only what is on for members; what this server
// cannot connect for the person left out; how each one stands.
import { describe, expect, test } from 'bun:test'
import { DEFAULT_TOOLS, MAX_TOOLS, myTools, type ToolFacts } from '../../src/lib/myTools'

const facts = (o: Partial<ToolFacts> = {}): ToolFacts => ({
  recommended: undefined, admin: false,
  drive: { configured: true, mine: false },
  google: ['gmail', 'calendar', 'docs', 'sheets'].map((id) => ({ id, available: true, mine: false, team: false })),
  listedAllowed: true, listedMine: new Set(), listedTeam: new Set(), ...o,
})
const ids = (f: ToolFacts) => myTools(f).map((x) => `${x.id}:${x.state}`)

describe('which tools, in which order', () => {
  test('nothing chosen (null, or an older server that sends nothing): the usual four', () => {
    expect(DEFAULT_TOOLS).toEqual(['google-drive', 'gmail', 'calendar', 'notion'])
    for (const recommended of [undefined, null]) expect(ids(facts({ recommended }))).toEqual(['google-drive:open', 'gmail:open', 'calendar:open', 'notion:open'])
  })

  test('the team\'s recommended tools first; a member only those; an owner or admin the usual ones after them; four at most', () => {
    expect(ids(facts({ recommended: ['linear', 'notion'] }))).toEqual(['linear:open', 'notion:open'])
    expect(ids(facts({ recommended: ['linear', 'notion'], admin: true }))).toEqual(['linear:open', 'notion:open', 'google-drive:open', 'gmail:open'])
    expect(myTools(facts({ recommended: ['linear', 'figma', 'canva', 'airtable', 'notion'] })).length).toBe(MAX_TOOLS)
    // an empty list (the team turned everything off): nothing for a member
    expect(ids(facts({ recommended: [] }))).toEqual([])
  })

  test('left out: Drive not set up here, a Google app that is off, listed services when nobody may connect their own, an id nobody knows', () => {
    expect(ids(facts({ drive: { configured: false, mine: false }, google: [{ id: 'gmail', available: false, mine: false, team: false }], listedAllowed: false, recommended: ['local-app-x', 'notion'] }))).toEqual([])
    expect(ids(facts({ drive: null, recommended: ['google-drive', 'sheets'] }))).toEqual(['sheets:open'])
  })

  test('how each stands: theirs, the team\'s for everyone (even where they may not connect their own), or open', () => {
    const f = facts({
      drive: { configured: true, mine: true },
      google: [{ id: 'gmail', available: false, mine: false, team: true }, { id: 'calendar', available: true, mine: true, team: false }],
      listedAllowed: false, listedTeam: new Set(['notion']),
    })
    expect(ids(f)).toEqual(['google-drive:mine', 'gmail:team', 'calendar:mine', 'notion:team'])
    expect(myTools(facts({ listedMine: new Set(['notion']), listedTeam: new Set(['notion']) })).find((x) => x.id === 'notion')!.state).toBe('mine')
  })
})
