// A plain browser's "Switch team" (lib/teamSwitch.ts browserTeamTarget; docs/decisions/20261118-team-menu-for-members.md):
// what was typed is read as the apps read their one box (shared/src/team-link.ts), and only an http(s) team origin with
// its first page comes out.
import { describe, expect, test } from 'bun:test'
import { browserTeamTarget } from '../../src/lib/teamSwitch'

const T = 'a'.repeat(43)

describe('browserTeamTarget', () => {
  test('a name, an address, a pasted address bar and an invite or team link open that team', () => {
    expect(browserTeamTarget('beta', 'acme.trina.app')).toEqual({ url: 'https://beta.trina.app/' })
    expect(browserTeamTarget(' Beta.Trina.App ', 'acme.trina.app')).toEqual({ url: 'https://beta.trina.app/' })
    expect(browserTeamTarget('https://office.example.com:8443/files?x=1', 'acme.trina.app')).toEqual({ url: 'https://office.example.com:8443/' })
    expect(browserTeamTarget(`https://beta.trina.app/invite/${T}`, 'acme.trina.app')).toEqual({ url: `https://beta.trina.app/invite/${T}` })
    expect(browserTeamTarget(`초대 링크: https://beta.trina.app/join#t=${T} 입니다`, 'acme.trina.app')).toEqual({ url: `https://beta.trina.app/join#t=${T}` })
  })

  test('nothing typed: no words yet; anything else that is not a team address says why', () => {
    expect(browserTeamTarget('', 'acme.trina.app')).toEqual({ problem: null })
    expect(browserTeamTarget('me@example.com', 'acme.trina.app')).toEqual({ problem: 'teamSwitch.problem.email' })
    expect(browserTeamTarget('https://beta.trina.app/invite/abc', 'acme.trina.app')).toEqual({ problem: 'teamSwitch.problem.link' })
    expect(browserTeamTarget('http://beta.example.com', 'acme.trina.app')).toEqual({ problem: 'teamSwitch.problem.insecure' })
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'https://user:pw@beta.example.com', 'https://macmini', 'ㅁ츼']) {
      expect(browserTeamTarget(bad, 'acme.trina.app')).toEqual({ problem: 'teamSwitch.problem.invalid' })
    }
  })

  test('plain http to this machine only from a page on this machine (development)', () => {
    expect(browserTeamTarget('localhost:5173', 'localhost')).toEqual({ url: 'http://localhost:5173/' })
    expect(browserTeamTarget('http://localhost:5173', 'acme.trina.app')).toEqual({ problem: 'teamSwitch.problem.insecure' })
  })
})
