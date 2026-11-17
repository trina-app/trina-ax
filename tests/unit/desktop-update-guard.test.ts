// Quiet desktop updates (desktop/src/common/update-guard.ts): what a start does about an update an earlier run left
// ready, the ShipIt waiter, the page that comes back after an update restart, and when an idle restart is allowed.
// Reproduction behind it (2026-11-16): released 0.5.7 → 0.5.9, "Restart" and a Dock click 0.3 s later made ShipIt log
// "Aborting update attempt because there are 1 running instances of the target app" and keep 0.5.7.
import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  bundleIdOf, bundleOf, FAILED_STARTS_BEFORE_NOTICE, IDLE_RESTART_AFTER_S, idleRestartAllowed, launchctlPid, launchDecision, MAC_WAITER,
  parsePending, parseResume, readOnlyRefusal, RESUME_WITHIN_MS, resumePage, stagedPending, type Pending,
} from '../../desktop/src/common/update-guard'
import { WORK } from '../lib/env'

const NOW = 1_800_000_000_000
const pending = (o: Partial<Pending> = {}): Pending => ({ version: '0.5.11', at: NOW - 60_000, failedStarts: 0, waitedAt: null, ...o })

describe('a start after an update was made ready', () => {
  test('nothing recorded: nothing to do; the new version running: the record is dropped', () => {
    expect(launchDecision({ pending: null, current: '0.5.10', installing: true, now: NOW })).toEqual({ kind: 'none' })
    expect(launchDecision({ pending: pending(), current: '0.5.11', installing: false, now: NOW })).toEqual({ kind: 'updated' })
    expect(launchDecision({ pending: pending(), current: '0.5.12', installing: true, now: NOW })).toEqual({ kind: 'updated' })
  })

  test('ShipIt still installing (a Dock click right after quit): step aside, once per staged version', () => {
    const d = launchDecision({ pending: pending(), current: '0.5.10', installing: true, now: NOW })
    expect(d).toEqual({ kind: 'wait', pending: pending({ waitedAt: NOW }) })
    // the waiter opened the app again and ShipIt is somehow still there: run normally, never a loop of quits or waits
    const again = launchDecision({ pending: pending({ waitedAt: NOW }), current: '0.5.10', installing: true, now: NOW + 60 * 60_000 })
    expect(again).toEqual({ kind: 'failed', pending: pending({ waitedAt: NOW, failedStarts: 1 }), notice: false })
    expect(launchDecision({ pending: pending({ failedStarts: 1 }), current: '0.5.10', installing: true, now: NOW }).kind).toBe('failed')
  })

  test('still the old version and nothing installing: retried quietly once, then one line', () => {
    const first = launchDecision({ pending: pending(), current: '0.5.10', installing: false, now: NOW })
    expect(first).toEqual({ kind: 'failed', pending: pending({ failedStarts: 1 }), notice: false })
    const second = launchDecision({ pending: (first as { pending: Pending }).pending, current: '0.5.10', installing: false, now: NOW })
    expect(second).toEqual({ kind: 'failed', pending: pending({ failedStarts: FAILED_STARTS_BEFORE_NOTICE }), notice: true })
  })

  test('the record: staged again keeps the count for the same version, starts over for a newer one; junk is ignored', () => {
    expect(stagedPending(pending({ failedStarts: 1 }), '0.5.11', NOW)).toEqual({ version: '0.5.11', at: NOW, failedStarts: 1, waitedAt: null })
    expect(stagedPending(pending({ failedStarts: 1 }), '0.5.12', NOW).failedStarts).toBe(0)
    expect(parsePending(JSON.stringify(pending()))).toEqual(pending())
    for (const bad of [null, '', '{', '{"version":"latest","at":1}', '{"version":"0.5.11"}', '[]']) expect(parsePending(bad)).toBeNull()
  })
})

describe('the ShipIt waiter (macOS)', () => {
  test('launchctl output: a PID only while ShipIt runs', () => {
    expect(launchctlPid('{\n\t"LimitLoadToSessionType" = "Aqua";\n\t"Label" = "com.treesoop.mycel.ShipIt";\n\t"PID" = 25290;\n};')).toBe(25290)
    expect(launchctlPid('{\n\t"Label" = "com.treesoop.mycel.ShipIt";\n\t"LastExitStatus" = 0;\n};')).toBeNull()
  })

  test('the bundle and its id', () => {
    expect(bundleOf('/Applications/Trina AX.app/Contents/MacOS/Trina AX')).toBe('/Applications/Trina AX.app')
    expect(bundleOf('C:\\Program Files\\Trina AX\\Trina AX.exe')).toBeNull()
    expect(bundleIdOf('<dict>\n    <key>CFBundleIdentifier</key>\n    <string>com.treesoop.mycel</string>')).toBe('com.treesoop.mycel')
    expect(bundleIdOf('<key>CFBundleIdentifier</key><string>a b</string>')).toBeNull()
  })

  test('the waiter script runs in sh: a label launchd does not know means no wait, then it opens the bundle', () => {
    if (process.platform !== 'darwin') return
    const dir = path.join(WORK, 'desktop-update-guard')
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    const script = MAC_WAITER.replace('/usr/bin/open "$1"', 'echo "open $1" > "$1/opened"')
    const t0 = Date.now()
    execFileSync('/bin/sh', ['-c', script, 'test.mycel.not-a-job.ShipIt', dir])
    expect(fs.readFileSync(path.join(dir, 'opened'), 'utf8').trim()).toBe(`open ${dir}`)
    expect(Date.now() - t0).toBeLessThan(5000)
  })
})

describe('the page that comes back after an update restart', () => {
  test('the path of the team page, same origin only, fresh only; the window as it was', () => {
    const page = resumePage('t1', 'https://acme.trina.app/chat/abc?x=1#m', ['https://acme.trina.app'])
    expect(page).toEqual({ teamId: 't1', path: '/chat/abc?x=1#m' })
    expect(resumePage('t1', 'https://evil.example/chat', ['https://acme.trina.app'])).toBeNull()
    expect(resumePage('t1', 'not a url', ['https://acme.trina.app'])).toBeNull()
    const r = { page, window: 'minimized' as const, at: NOW }
    expect(parseResume(JSON.stringify(r), NOW + 1000)).toEqual(r)
    expect(parseResume(JSON.stringify(r), NOW + RESUME_WITHIN_MS + 1)).toBeNull()
    expect(parseResume(JSON.stringify({ ...r, page: { teamId: 't1', path: '//evil.example/x' } }), NOW)).toEqual({ page: null, window: 'minimized', at: NOW })
    expect(parseResume(JSON.stringify({ page: null, window: 'odd', at: NOW }), NOW)).toEqual({ page: null, window: 'shown', at: NOW })
    expect(parseResume('{', NOW)).toBeNull()
  })
})

describe('an idle restart', () => {
  const quiet = { ready: true, focused: false, idleSeconds: IDLE_RESTART_AFTER_S, locked: false, pageBusy: false, browserTabs: 0 }
  test('only when nobody uses the app and nothing would be lost', () => {
    expect(idleRestartAllowed(quiet)).toBe(true)
    expect(idleRestartAllowed({ ...quiet, idleSeconds: 0, locked: true })).toBe(true)
    expect(idleRestartAllowed({ ...quiet, ready: false })).toBe(false)
    expect(idleRestartAllowed({ ...quiet, focused: true })).toBe(false)
    expect(idleRestartAllowed({ ...quiet, idleSeconds: IDLE_RESTART_AFTER_S - 1 })).toBe(false)
    expect(idleRestartAllowed({ ...quiet, pageBusy: true })).toBe(false)
    expect(idleRestartAllowed({ ...quiet, pageBusy: null })).toBe(false)
    expect(idleRestartAllowed({ ...quiet, browserTabs: 1 })).toBe(false)
  })
})

test("Squirrel's refusal for an app on a read-only place", () => {
  expect(readOnlyRefusal('Cannot update while running on a read-only volume. The application is on a read-only volume. Please move the application and try again.')).toBe(true)
  expect(readOnlyRefusal('Code signature at URL did not pass validation')).toBe(false)
})

describe('the start check on disk (desktop/src/main/update-launch.ts)', async () => {
  const { onLaunch, readPending, takeResume, writePending, writeResume } = await import('../../desktop/src/main/update-launch')
  const dir = path.join(WORK, 'desktop-update-launch')
  const fresh = () => { fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true }) }

  test('the new version running: the record goes; still the old one (Windows, or no ShipIt): counted, then the line', () => {
    fresh()
    expect(onLaunch({ userData: dir, version: '0.5.10', platform: 'win32', execPath: 'C:\\Trina AX\\Trina AX.exe' })).toEqual({ kind: 'none' })
    writePending(dir, pending())
    expect(onLaunch({ userData: dir, version: '0.5.10', platform: 'win32', execPath: 'C:\\Trina AX\\Trina AX.exe' }).kind).toBe('failed')
    expect(readPending(dir)?.failedStarts).toBe(1)
    // a Mac app whose ShipIt job is not loaded (no such bundle id here): never steps aside
    const d = onLaunch({ userData: dir, version: '0.5.10', platform: 'darwin', execPath: path.join(dir, 'Nope.app/Contents/MacOS/Nope') })
    expect(d).toEqual({ kind: 'failed', pending: pending({ failedStarts: 2 }), notice: true })
    expect(onLaunch({ userData: dir, version: '0.5.11', platform: 'darwin', execPath: '/Applications/Trina AX.app/Contents/MacOS/Trina AX' })).toEqual({ kind: 'updated' })
    expect(readPending(dir)).toBeNull()
  })

  test('the page to come back to is read once', () => {
    fresh()
    writeResume(dir, { page: { teamId: 't1', path: '/files' }, window: 'shown', at: Date.now() })
    expect(takeResume(dir)?.page).toEqual({ teamId: 't1', path: '/files' })
    expect(takeResume(dir)).toBeNull()
  })
})
