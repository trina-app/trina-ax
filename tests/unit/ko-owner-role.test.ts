// Korean server texts name the owner role with its Korean name 팀장, as the web dictionary does (role.owner), and
// never with the English word "owner" or the other Korean term 소유자 (QA B-W1-2: engine diagnostics, member-role
// errors, the first-run setup texts). The Indonesian texts
// keep "owner", because the Indonesian dictionary names the role "Owner" (docs/DECISIONS.md "Owner role name").
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
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
      expect(texts.filter(([, ko]) => /소유자/.test(ko)).map(([k]) => k)).toEqual([])
    })
  }

  test('the engine sign-in lines name 팀장 with the correct particle', () => {
    expect(ENGINE_TEXT.claudeLogin!.ko).toContain('팀장이')
    expect(ENGINE_TEXT.codexLogin!.ko).toContain('팀장이')
    expect(AUTH_MESSAGES.notOnOwner.ko).toContain('팀장 넘김')
    expect(AUTH_MESSAGES.setupNotRemote.ko).toContain('팀장 계정')
  })

  // The office CLI and the install script print Korean lines that are not in a text table. Read their source.
  test('the office CLI and the install script do not say 소유자', () => {
    const root = path.join(import.meta.dir, '../..')
    for (const file of ['server/src/office/cli.ts', 'scripts/office/office-install.sh']) {
      const bad = fs.readFileSync(path.join(root, file), 'utf8').split('\n')
        .map((line, i) => [i + 1, line] as const).filter(([, line]) => /소유자/.test(line))
      expect(bad.map(([n]) => `${file}:${n}`)).toEqual([])
    }
  })
})
