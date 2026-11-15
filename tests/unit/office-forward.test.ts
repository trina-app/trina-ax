// QA TC-335 (server/src/office/forward.ts, docs/OFFICE.md troubleshooting): an office whose update migrated the
// database is never left on a build that exits 75 (database too new) in a restart loop.
//   - exit75Decision: restart / go forward to a newer kept release that reads the database / stop with one message
//   - the new install sets aside an app.previous that cannot read the database, so the rollback of an OLD updater
//     (0.4.0's contract, copied below) is refused and the new app/ stays
//   - the heal of `update run` starts the server again after such a refused rollback, and only then
//   - the advice names the newest kit, and a recovery clears the failed run's advice
import { afterAll, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import {
  exit75Decision, extraWaitSeconds, goForward, healDecision, previousDecision, healFile, readHealMarker, recoveryAdvice, releaseIn, setAsideUnreadablePrevious,
  unreadablePrevious, UNREADABLE, writeHealMarker, type HealMarker,
} from '../../server/src/office/forward'
import { clearStaleFailure, NoRollback, patchUpdateState, readUpdateState, rollBack, type UpdateDeps } from '../../server/src/office/update'
import { healAfterRefusedRollback } from '../../server/src/office/update-cli'
import { settingsFrom } from '../../server/src/office/settings'
import { EXIT_SCHEMA_TOO_NEW } from '../../server/src/office/cli'
import { EXIT } from '../../server/src/main'
import { PRODUCT } from '@mycel/shared'
import { WORK } from '../lib/env'

const BASE = path.join(WORK, 'office-forward')
fs.rmSync(BASE, { recursive: true, force: true })
fs.mkdirSync(BASE, { recursive: true })
afterAll(() => fs.rmSync(BASE, { recursive: true, force: true }))

/** a release folder: VERSION and migrations up to reader level `level` */
function release(home: string, name: string, version: string, level: number) {
  const dir = path.join(home, name)
  fs.mkdirSync(path.join(dir, 'server', 'migrations'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'VERSION'), version + '\n')
  for (let l = 1; l <= level; l++) fs.writeFileSync(path.join(dir, 'server', 'migrations', `${String(l).padStart(3, '0')}_m.sql`), `-- min_compatible_reader: ${l}\nSELECT 1;\n`)
}

/** data/app.db whose applied migrations need reader level `need` */
function database(home: string, need: number) {
  fs.mkdirSync(path.join(home, 'data'), { recursive: true })
  fs.rmSync(path.join(home, 'data', 'app.db'), { force: true })
  const db = new Database(path.join(home, 'data', 'app.db'))
  db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT, min_compatible_reader INTEGER)')
  for (let l = 1; l <= need; l++) db.query('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(l, `${l}.sql`, l)
  db.close()
}

let n = 0
function home(): string {
  const h = path.join(BASE, `h${++n}`)
  fs.mkdirSync(path.join(h, 'config'), { recursive: true })
  fs.writeFileSync(path.join(h, 'config', 'office.env'), 'TEAMAX_LABEL=app.team-ax.test-forward\n')
  return h
}
const version = (h: string, name = 'app') => fs.readFileSync(path.join(h, name, 'VERSION'), 'utf8').trim()

test('the supervisor knows exit 75 as main.ts does', () => {
  expect(EXIT_SCHEMA_TOO_NEW).toBe(EXIT.schemaTooNew)
})

describe('exit75Decision', () => {
  test('app/ reads the database: a plain restart', () => {
    const h = home()
    release(h, 'app', '0.5.5', 8)
    database(h, 8)
    expect(exit75Decision(h)).toMatchObject({ kind: 'restart' })
  })

  test('TC-335: 0.4.0 back in app/, 0.5.5 kept in app.failed: forward to 0.5.5', () => {
    const h = home()
    release(h, 'app', '0.4.0', 4)
    release(h, 'app.failed', '0.5.5', 8)
    database(h, 8)
    const d = exit75Decision(h)
    expect(d).toMatchObject({ kind: 'forward', to: { name: 'app.failed', version: '0.5.5' }, from: { version: '0.4.0' }, need: 8 })
    if (d.kind !== 'forward') throw new Error('not forward')
    expect(goForward(h, d.to)).toBe(`app = 0.5.5 (from app.failed), 0.4.0 moved to ${UNREADABLE}`)
    expect(version(h)).toBe('0.5.5')
    expect(version(h, UNREADABLE)).toBe('0.4.0')
    expect(fs.existsSync(path.join(h, 'app.failed'))).toBe(false)
    expect(exit75Decision(h)).toMatchObject({ kind: 'restart' })
  })

  test('the newest kept release that reads the database wins; one that cannot read it, or is older, is not taken', () => {
    const h = home()
    release(h, 'app', '0.4.0', 4)
    release(h, 'app.failed', '0.6.0', 9) // newer, reads 9
    release(h, 'app.previous', '0.5.5', 8)
    database(h, 8)
    expect(exit75Decision(h)).toMatchObject({ kind: 'forward', to: { version: '0.6.0' } })
    const h2 = home()
    release(h2, 'app', '0.4.0', 4)
    release(h2, 'app.failed', '0.5.5', 8)
    database(h2, 9) // a dev build migrated further: 0.5.5 cannot read it either
    const d = exit75Decision(h2)
    expect(d.kind).toBe('stop')
    if (d.kind !== 'stop') throw new Error('not stop')
    expect(d.message).toContain('0.4.0 reads schema level 4, but the database needs level 9')
    expect(d.message).toContain(`office-install.sh from the ${PRODUCT.officeBundle}-0.5.5 zip or a newer one`)
  })

  test('nothing kept: stop, and the advice is the newest zip (never the old one)', () => {
    const h = home()
    release(h, 'app', '0.4.0', 4)
    database(h, 8)
    const d = exit75Decision(h)
    expect(d.kind).toBe('stop')
    if (d.kind !== 'stop') throw new Error('not stop')
    expect(d.message).toContain('so the server is not started again')
    expect(d.message).toContain('office-install.sh from the newest zip')
    expect(d.message).not.toContain('0.4.0 zip')
  })
})

/** 0.4.0's rollBack (git show v0.4.0:server/src/office/update.ts): stop the agents, then app.previous must be `from` */
async function oldRollBack(h: string, from: string, calls: string[]) {
  calls.push('stop agents')
  const app = path.join(h, 'app'), prev = path.join(h, 'app.previous'), failed = path.join(h, 'app.failed')
  if (version(h) !== from) {
    let prevVersion: string | null = null
    try { prevVersion = fs.readFileSync(path.join(prev, 'VERSION'), 'utf8').trim() } catch {}
    if (prevVersion !== from) throw new Error(`cannot roll back: app.previous is ${prevVersion ?? 'missing'}, not ${from}`)
    fs.rmSync(failed, { recursive: true, force: true })
    fs.renameSync(app, failed)
    fs.renameSync(prev, app)
    calls.push('old install')
  }
}

describe('the new install sets aside an app.previous that cannot read the database', () => {
  test('TC-335: an old updater then cannot roll back; the new app/ stays', async () => {
    const h = home()
    release(h, 'app', '0.5.6', 8)
    release(h, 'app.previous', '0.4.0', 4)
    database(h, 8)
    expect(unreadablePrevious(h)).toMatchObject({ version: '0.4.0', level: 4 })
    expect(setAsideUnreadablePrevious(h)).toContain(`app.previous (0.4.0) reads schema level 4 and the database needs level 8: moved to ${UNREADABLE}`)
    expect(fs.existsSync(path.join(h, 'app.previous'))).toBe(false)
    const calls: string[] = []
    await expect(oldRollBack(h, '0.4.0', calls)).rejects.toThrow('app.previous is missing')
    expect(calls).toEqual(['stop agents']) // the old updater stops the server: the heal below starts it again
    expect(version(h)).toBe('0.5.6')
  })

  test('an app.previous that still reads the database stays (a normal rollback target)', () => {
    const h = home()
    release(h, 'app', '0.5.6', 8)
    release(h, 'app.previous', '0.5.5', 8)
    database(h, 8)
    expect(setAsideUnreadablePrevious(h)).toBe('')
    expect(version(h, 'app.previous')).toBe('0.5.5')
    // no database yet (a first install): level 1, nothing moves
    const h2 = home()
    release(h2, 'app', '0.5.6', 8)
    release(h2, 'app.previous', '0.4.0', 4)
    expect(setAsideUnreadablePrevious(h2)).toBe('')
  })

  test('the updater of a fixed version refuses the rollback itself, before it stops anything', async () => {
    const h = home()
    release(h, 'app', '0.5.7', 9)
    release(h, 'app.previous', '0.5.6', 8)
    database(h, 9)
    const calls: string[] = []
    const d = { stopAgents: async () => { calls.push('stop agents') }, exec: async () => { calls.push('exec'); return { code: 0, out: '' } }, log: () => {} } as unknown as UpdateDeps
    await expect(rollBack(h, '0.5.6', '0.5.7', d, 1000)).rejects.toBeInstanceOf(NoRollback)
    // also when the new install already set it aside
    setAsideUnreadablePrevious(h)
    await expect(rollBack(h, '0.5.6', '0.5.7', d, 1000)).rejects.toThrow('0.5.6 reads schema level 8 and 0.5.7 updated the database to level 9')
    expect(calls).toEqual([])
    expect(version(h)).toBe('0.5.7')
  })
})

test('previousDecision: what office.js install does with app.previous after its wait', () => {
  const b = { underUpdater: true, need: 4, newLevel: 8, prevLevel: 4 }
  // TC-335: migrated to 8, no answer, under 0.4.0's updater: set aside, heal marker, exit 0 (the updater goes on waiting)
  expect(previousDecision({ ...b, up: false, need: 8 })).toEqual({ setAside: true, why: 'the database needs level 8', marker: true, exitZero: true })
  expect(previousDecision({ ...b, up: 'up', need: 8 })).toMatchObject({ setAside: true, marker: true, exitZero: false })
  // still migrating when the install hands over (the migrations commit together, so the database still reads 4):
  // 0.4.0 would roll back after the commit, so set aside now
  expect(previousDecision({ ...b, up: 'migrating' })).toEqual({ setAside: true, why: 'the database is being updated to level 8', marker: true, exitZero: false })
  // never answered, never migrating: nothing was migrated, a rollback is right
  expect(previousDecision({ ...b, up: false })).toMatchObject({ setAside: false, exitZero: false })
  // migrating, but this build raises no level over app.previous: the old build reads the result
  expect(previousDecision({ ...b, up: 'migrating', newLevel: 4 })).toMatchObject({ setAside: false })
  // by hand (no updater): set aside only what cannot read the database now; no marker, the exit code is the install's
  expect(previousDecision({ ...b, underUpdater: false, up: false, need: 8 })).toEqual({ setAside: true, why: 'the database needs level 8', marker: false, exitZero: false })
  expect(previousDecision({ ...b, underUpdater: false, up: 'migrating' })).toMatchObject({ setAside: false })
  expect(previousDecision({ ...b, up: false, need: 8, prevLevel: null })).toMatchObject({ setAside: false })
})

test('extraWaitSeconds: inside the updater\'s 10 minutes, at most 240 s, 0 without a start time', () => {
  const t0 = 1_800_000_000
  expect(extraWaitSeconds(undefined, t0 * 1000)).toBe(0)
  expect(extraWaitSeconds('x', t0 * 1000)).toBe(0)
  expect(extraWaitSeconds(String(t0), (t0 + 100) * 1000)).toBe(240)
  expect(extraWaitSeconds(String(t0), (t0 + 400) * 1000)).toBe(140)
  expect(extraWaitSeconds(String(t0), (t0 + 600) * 1000)).toBe(0)
})

describe('heal after a refused rollback (update run)', () => {
  const marker: HealMarker = { at: '2026-11-15T05:56:00Z', version: '0.5.6', previous: '0.4.0', reason: 'r' }
  const base = { marker, installed: '0.5.6', plist: true, loaded: false, answer: null, updateRunning: false, lastUpdate: { to: '0.5.6', result: 'failed' } }

  test('healDecision', () => {
    expect(healDecision(base)).toMatchObject({ kind: 'start' })
    expect(healDecision({ ...base, marker: null })).toMatchObject({ kind: 'none', drop: false })
    expect(healDecision({ ...base, updateRunning: true })).toMatchObject({ kind: 'none', drop: false })
    expect(healDecision({ ...base, loaded: true })).toMatchObject({ kind: 'none', drop: false })
    expect(healDecision({ ...base, installed: '0.4.0' })).toMatchObject({ kind: 'none', drop: true })
    expect(healDecision({ ...base, plist: false })).toMatchObject({ kind: 'none', drop: true })
    // the owner stopped the server after a good update: it stays stopped
    expect(healDecision({ ...base, lastUpdate: { to: '0.5.6', result: 'updated' } })).toMatchObject({ kind: 'none', drop: true })
    expect(healDecision({ ...base, answer: '0.5.6', lastUpdate: { to: '0.5.6', result: 'updated' } })).toMatchObject({ kind: 'none', drop: true })
    // 0.4.0's updater has not written its result yet (it waits 150 s): wait
    expect(healDecision({ ...base, answer: '0.5.6' })).toMatchObject({ kind: 'none', drop: false })
  })

  test('healAfterRefusedRollback: starts app/\'s install once, clears the old advice and the marker', async () => {
    const h = home()
    release(h, 'app', '0.5.6', 8)
    database(h, 8)
    const s = settingsFrom(h, { TEAMAX_LABEL: 'app.team-ax.test-forward' })
    const agents = path.join(BASE, 'agents')
    fs.mkdirSync(agents, { recursive: true })
    process.env.TEAMAX_AGENTS_DIR = agents
    fs.writeFileSync(path.join(agents, `${s.label}.plist`), 'plist')
    writeHealMarker(h, marker)
    // what 0.4.0's updater wrote after its refused rollback
    const oldAdvice = `0.5.6 did not answer on 127.0.0.1:47830; the rollback to 0.4.0 did not answer either: run teamax status and office-install.sh from the ${PRODUCT.officeBundle}-0.4.0 zip`
    patchUpdateState(h, (x) => { x.last = { kind: 'failed', at: marker.at, version: '0.5.6', message: oldAdvice }; x.lastUpdate = { from: '0.4.0', to: '0.5.6', at: marker.at, result: 'failed', error: oldAdvice } })
    let up = false
    const installs: number[] = []
    const deps = { loaded: () => up, health: async () => (up ? '0.5.6' : null), install: async () => { installs.push(1); up = true; return 0 }, log: () => {} }
    const r = await healAfterRefusedRollback(s, deps)
    expect(r).toContain('0.5.6 runs again')
    expect(installs).toHaveLength(1)
    expect(readHealMarker(h)).toBeNull()
    const st = readUpdateState(h)
    expect(st.last).toMatchObject({ kind: 'updated', version: '0.5.6' })
    expect(st.last?.message).not.toContain('0.4.0 zip')
    expect(st.lastUpdate).toMatchObject({ to: '0.5.6', result: 'updated', error: null })
    // the next run: nothing to do
    expect(await healAfterRefusedRollback(s, deps)).toBe('')
    expect(installs).toHaveLength(1)
    delete process.env.TEAMAX_AGENTS_DIR
  })
})

test('advice and stale advice: the newest kit; a reinstall by hand clears the failed run', () => {
  const h = home()
  release(h, 'app', '0.5.5', 8)
  expect(recoveryAdvice(h, '0.5.5')).toBe(`run office-install.sh from the ${PRODUCT.officeBundle}-0.5.5 zip or a newer one (bash <unzipped folder>/office-install.sh --prefix ${h}); an older zip cannot start this database`)
  patchUpdateState(h, (x) => {
    x.last = { kind: 'failed', at: '2026-11-15T05:59:00Z', version: '0.5.5', message: 'old advice' }
    x.lastUpdate = { from: '0.4.0', to: '0.5.5', at: '2026-11-15T05:59:00Z', result: 'failed', error: 'old advice' }
    x.failed['0.5.5'] = { at: '2026-11-15T05:59:00Z', reason: 'old advice' }
  })
  writeHealMarker(h, { at: 'x', version: '0.5.5', previous: '0.4.0', reason: '' })
  expect(clearStaleFailure(h)).toBe('update status: the failed update to 0.5.5 is cleared (0.5.5 runs)')
  const st = readUpdateState(h)
  expect(st.last).toMatchObject({ kind: 'updated', version: '0.5.5' })
  expect(st.failed).toEqual({})
  expect(st.lastUpdate).toMatchObject({ result: 'updated' })
  expect(fs.existsSync(healFile(h))).toBe(false)
  expect(clearStaleFailure(h)).toBe('')
  // an older version installed by hand does not clear a newer failed update
  const h2 = home()
  release(h2, 'app', '0.4.0', 4)
  patchUpdateState(h2, (x) => { x.lastUpdate = { from: '0.4.0', to: '0.5.5', at: 'x', result: 'failed', error: 'e' } })
  expect(clearStaleFailure(h2)).toBe('')
  expect(releaseIn(h2, 'app')).toMatchObject({ version: '0.4.0', level: 4 })
})
