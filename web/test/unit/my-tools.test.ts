// "Connect your tools" on the My setup card (lib/myTools.ts; docs/decisions/20261120-my-setup-card.md): the team's
// recommended tools first (TeamSettings.recommendedTools, shared/src/api/team-tools.ts), then the usual ones, at most
// four; nothing gated by the recommendation; what this server cannot connect for the person left out; how each stands.
import { describe, expect, test } from 'bun:test'
import { DEFAULT_TOOLS, MAX_TOOLS, myTools, type ToolFacts } from '../../src/lib/myTools'

const facts = (o: Partial<ToolFacts> = {}): ToolFacts => ({
  recommended: undefined,
  drive: { configured: true, mine: false },
  google: ['gmail', 'calendar', 'docs', 'sheets'].map((id) => ({ id, available: true, mine: false, team: false })),
  listedAllowed: true, listedMine: new Set(), listedTeam: new Set(), ...o,
})
const ids = (f: ToolFacts) => myTools(f).map((x) => `${x.id}:${x.state}`)

describe('which tools, in which order', () => {
  test('none recommended (absent from an older server, or empty): the usual four', () => {
    expect(DEFAULT_TOOLS).toEqual(['google-drive', 'gmail', 'calendar', 'notion'])
    for (const recommended of [undefined, null, []]) expect(ids(facts({ recommended }))).toEqual(['google-drive:open', 'gmail:open', 'calendar:open', 'notion:open'])
  })

  test('the team\'s recommended tools first, in their order, then the usual ones; nothing gated; four at most', () => {
    expect(ids(facts({ recommended: ['linear', 'sheets'] }))).toEqual(['linear:open', 'sheets:open', 'google-drive:open', 'gmail:open'])
    // a recommended usual tool moves up, and is not listed twice
    expect(ids(facts({ recommended: ['calendar'] }))).toEqual(['calendar:open', 'google-drive:open', 'gmail:open', 'notion:open'])
    expect(myTools(facts({ recommended: ['linear', 'figma', 'canva', 'airtable', 'sheets'] })).length).toBe(MAX_TOOLS)
  })

  test('left out: Drive not set up here, a Google app that is off, listed services when nobody may connect their own, an id nobody knows', () => {
    expect(ids(facts({ drive: { configured: false, mine: false }, google: [{ id: 'gmail', available: false, mine: false, team: false }], listedAllowed: false, recommended: ['aside', 'linear'] }))).toEqual([])
    expect(ids(facts({ drive: null, google: [], recommended: ['google-drive', 'linear'] }))).toEqual(['linear:open', 'notion:open'])
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
