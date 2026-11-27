// The office supervisor's watchdog (server/src/office/watchdog.ts; docs/decisions/20261127-restart.md): the same rule as
// the bootstrap's. Counted only after this start answered; "migrating" is an answer; 10 failures in a row is a hang;
// it restarts unless TEAMAX_WATCHDOG_KILL=0 (log only then); at most 3 kills an hour, then data/liveness.json until the next answer.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { OfficeWatchdog, officeWatchdogKills, readLiveness, WATCH_FAILURES } from '../../server/src/office/watchdog'
import { settingsFrom, settingsText } from '../../server/src/office/settings'
import { WORK } from '../lib/env'

fs.mkdirSync(WORK, { recursive: true })
const dir = () => fs.mkdtempSync(path.join(WORK, 'office-watchdog-'))
const hang = (w: OfficeWatchdog, kill: boolean, now: number, n = WATCH_FAILURES) => {
  let last = null as ReturnType<OfficeWatchdog['look']>
  for (let i = 0; i < n; i++) last = w.look(null, kill, now) ?? last
  return last
}

describe('the office watchdog', () => {
  test('a start that never answered is not counted; one that answered and stopped is a hang after 10 failures', () => {
    const w = new OfficeWatchdog(dir())
    w.started()
    expect(hang(w, true, 0, 50)).toBeNull()
    expect(w.look('0.21.0', true, 0)).toBeNull()
    expect(hang(w, true, 0, WATCH_FAILURES - 1)).toBeNull()
    expect(w.look(null, true, 0)?.kind).toBe('kill')
    // the new start is watched again only once it answers
    w.started()
    expect(hang(w, true, 0, 50)).toBeNull()
  })

  test('a migrating answer is an answer (it resets the count)', () => {
    const w = new OfficeWatchdog(dir())
    w.started()
    w.look('0.21.0', true, 0)
    hang(w, true, 0, WATCH_FAILURES - 1)
    expect(w.look({ migrating: '0.21.0', progress: '' }, true, 0)).toBeNull()
    expect(hang(w, true, 0, WATCH_FAILURES - 1)).toBeNull()
  })

  test('log only with the switch off, once per hang', () => {
    const w = new OfficeWatchdog(dir())
    w.started()
    w.look('0.21.0', false, 0)
    const a = hang(w, false, 0)
    expect(a).toMatchObject({ kind: 'log' })
    expect(a && a.line).toContain('TEAMAX_WATCHDOG_KILL=0')
    expect(hang(w, false, 0)).toBeNull()
  })

  test('3 kills an hour, then it gives up until the next answer (not until the hour passes)', () => {
    const d = dir()
    const w = new OfficeWatchdog(d)
    for (let i = 0; i < 3; i++) {
      w.started(); w.look('0.21.0', true, 0)
      expect(hang(w, true, 0)?.kind).toBe('kill')
    }
    w.started(); w.look('0.21.0', true, 0)
    expect(hang(w, true, 0)?.kind).toBe('gave-up')
    expect(readLiveness(d)).toMatchObject({ gaveUp: true })
    expect(hang(w, true, 5 * 3600_000)).toBeNull()
    expect(readLiveness(d)).not.toBeNull()
    expect(w.look('0.21.0', true, 5 * 3600_000)?.kind).toBe('recovered')
    expect(readLiveness(d)).toBeNull()
    expect(hang(w, true, 5 * 3600_000)?.kind).toBe('kill')
  })

  test('the switch: on unless TEAMAX_WATCHDOG_KILL=0 in office.env, kept when the settings are written again', () => {
    expect(officeWatchdogKills(null)).toBe(true)
    expect(officeWatchdogKills('')).toBe(true)
    expect(officeWatchdogKills('TEAMAX_LABEL=x\n')).toBe(true)
    expect(officeWatchdogKills('TEAMAX_LABEL=x\nTEAMAX_WATCHDOG_KILL=0\n')).toBe(false)
    expect(officeWatchdogKills('TEAMAX_LABEL=x\nTEAMAX_WATCHDOG_KILL=0 \n')).toBe(false)
    expect(officeWatchdogKills('# TEAMAX_WATCHDOG_KILL=0\nTEAMAX_LABEL=x\n')).toBe(true)
    expect(officeWatchdogKills('TEAMAX_LABEL=x\nTEAMAX_WATCHDOG_KILL=1\n')).toBe(true)
    const home = dir()
    const def = settingsFrom(home, {})
    expect(def.watchdogKill).toBe(true)
    expect(officeWatchdogKills(settingsText(def))).toBe(true)
    const off = settingsFrom(home, { TEAMAX_WATCHDOG_KILL: '0' })
    expect(off.watchdogKill).toBe(false)
    expect(officeWatchdogKills(settingsText(off))).toBe(false)
    expect(settingsFrom(home, { TEAMAX_WATCHDOG_KILL: '1' }).watchdogKill).toBe(true)
  })
})
