// Korean server texts name the owner role with its Korean name 팀장, as the web dictionary does (role.owner), and
// never with the English word "owner" (QA B-W1-2: engine diagnostics and member-role errors). The Indonesian texts
// keep "owner", because the Indonesian dictionary names the role "Owner" (docs/DECISIONS.md "Owner role name").
import { describe, expect, test } from 'bun:test'
import { AUTH_MESSAGES } from '../../server/src/auth/messages'
import { T as ENGINE_TEXT } from '../../server/src/admin/engines'
import { M as SYSTEM_TEXT } from '../../server/src/system/messages'
import { engineStatusMessages, hostMessages, ML } from '../../server/src/system/messages-linux'

type Entry = { ko: string; en: string; id: string }
const isEntry = (v: unknown): v is Entry => !!v && typeof v === 'object' && typeof (v as Entry).ko === 'string'

/** Call a text function with sample arguments: strings first, then a list (some functions join a list). */
function sample(fn: (...a: unknown[]) => unknown): unknown {
  for (const args of [['x', 'y', 'z'], [['x'], false, 'z']]) {
    try { return fn(...args) } catch {}
  }
  return null
}

/** All Korean texts of a table, also the ones that functions make. */
function koTexts(table: Record<string, unknown>): [string, string][] {
  const out: [string, string][] = []
  for (const [key, v] of Object.entries(table)) {
    const r = typeof v === 'function' ? sample(v as (...a: unknown[]) => unknown) : v
    if (isEntry(r)) out.push([key, r.ko])
  }
  return out
}

const TABLES: Record<string, Record<string, unknown>> = {
  auth: AUTH_MESSAGES,
  engines: ENGINE_TEXT,
  system: SYSTEM_TEXT,
  linuxChecks: ML,
  linuxSystem: hostMessages('linux', { id: 'mycel', base: '/opt/mycel' }),
  hostedSystem: hostMessages('hosted', { id: 'mycel', base: '/opt/mycel' }),
  linuxEngines: engineStatusMessages('linux', '/opt/mycel'),
  hostedEngines: engineStatusMessages('hosted', '/opt/mycel'),
}

describe('Korean texts use 팀장 for the owner role', () => {
  for (const [name, table] of Object.entries(TABLES)) {
    test(name, () => {
      const texts = koTexts(table)
      expect(texts.length).toBeGreaterThan(0)
      expect(texts.filter(([, ko]) => /\bowner\b/i.test(ko)).map(([k]) => k)).toEqual([])
    })
  }

  test('the engine sign-in lines name 팀장 with the correct particle', () => {
    expect(ENGINE_TEXT.claudeLogin!.ko).toContain('팀장이')
    expect(ENGINE_TEXT.codexLogin!.ko).toContain('팀장이')
    expect(AUTH_MESSAGES.notOnOwner.ko).toContain('팀장 넘김')
  })
})
