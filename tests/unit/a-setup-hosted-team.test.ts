// The hosted service names the team at sign-up and sends the name and language in the setup link
// (#token=…&team=…&lang=…). The setup page shows them as set and never asks for them again (owner 2026-11-20), also
// after a reload, when the link is gone from the address. An installer link (?token= only) still asks.
import { beforeEach, describe, expect, test } from 'bun:test'
import { forgetSetupToken, keptSetupTeam, readSetupLink, rememberSetupToken, setupTeamOf } from '../../web/src/lib/setupLink'

const store: Record<string, string> = {}
;(globalThis as { sessionStorage?: unknown }).sessionStorage = {
  getItem: (k: string) => store[k] ?? null,
  setItem: (k: string, v: string) => { store[k] = String(v) },
  removeItem: (k: string) => { delete store[k] },
}
const TOKEN = 'abcdefghijklmnopqrstuvwxyz012345'
const at = (hash: string, search = '') => readSetupLink({ pathname: '/setup', search, hash })

beforeEach(() => { for (const k of Object.keys(store)) delete store[k] })

describe('the hosted setup link fixes the team name and language', () => {
  test('a cloud link carries both: the page shows them as set', () => {
    const link = at(`#token=${TOKEN}&team=diontest&lang=ko`)
    expect(setupTeamOf(link)).toEqual({ team: 'diontest', lang: 'ko' })
    expect(link.cleanUrl).toBe('/setup')
  })

  test('an installer link (token only) asks for the name as before', () => {
    rememberSetupToken(TOKEN, { team: 'earlier', lang: 'en' })
    const link = at('', `?token=${TOKEN}`)
    rememberSetupToken(link.token, null)
    expect(setupTeamOf(link)).toBeNull()
    expect(keptSetupTeam()).toBeNull()
  })

  test('after a reload (no link in the address) the kept name and language still apply', () => {
    const link = at(`#token=${TOKEN}&team=${encodeURIComponent('Acme 팀')}&lang=ja`)
    rememberSetupToken(link.token, { team: link.team!, lang: link.lang })
    const reload = at('')
    expect(reload.token).toBeNull()
    expect(setupTeamOf(reload)).toEqual({ team: 'Acme 팀', lang: 'ja' })
  })

  test('nothing kept without a token, and the team is forgotten with the token', () => {
    rememberSetupToken(null, { team: 'x', lang: 'ko' })
    expect(keptSetupTeam()).toBeNull()
    rememberSetupToken(TOKEN, { team: 'x', lang: 'ko' })
    forgetSetupToken()
    expect(keptSetupTeam()).toBeNull()
  })

  test('an unknown language keeps the name fixed and lets the language be picked', () => {
    const link = at(`#token=${TOKEN}&team=Acme&lang=xx`)
    expect(setupTeamOf(link)).toEqual({ team: 'Acme', lang: null })
    store['mycel.setupTeam'] = JSON.stringify({ team: 'Acme', lang: 'xx' })
    expect(keptSetupTeam()).toEqual({ team: 'Acme', lang: null })
  })

  test('a broken kept value is ignored, a long name is cut to the server limit', () => {
    store['mycel.setupTeam'] = '{nope'
    expect(keptSetupTeam()).toBeNull()
    store['mycel.setupTeam'] = JSON.stringify({ team: 'a'.repeat(300), lang: 'en' })
    expect(keptSetupTeam()?.team.length).toBe(100)
  })
})
