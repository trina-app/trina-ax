// An update waits for running work before the server restarts (docs/DECISIONS.md "Updates wait for running work"):
// this server's own run (Update now, the automatic update) and root's `mycel-ctl update` (root/update-waiting.json,
// the dev server's timer included) both say so, the wait is capped, and "Update now anyway" does not wait.
import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { UPDATE_WAIT_MS, runUpdate, waitingTasks } from '../../server/src/system/update-job'
import { ROOT_WAIT_GRACE_MS, _resetUpdateWait, beginUpdateWait, skipUpdateWait, updateWaiting } from '../../server/src/system/update-wait'
import type { UpdateManager } from '../../server/src/system/update'
import type { BackupManager } from '../../server/src/system/backup'

afterEach(() => _resetUpdateWait())

function deps(running: number[]) {
  const did: string[] = []
  const progress: (string | null)[] = []
  const waitingSeen: boolean[] = []
  const updates = { canRead: () => true, switchTo: async (v: string) => { did.push(`switch ${v}`); return { from: '1.0.0', to: v } } } as unknown as UpdateManager
  const backups = { run: async () => { did.push('backup') } } as unknown as BackupManager
  let clock = 0
  return {
    did, progress, waitingSeen,
    d: {
      updates, backups, locale: 'en' as const,
      running: () => { did.push('count'); return running.length > 1 ? running.shift()! : running[0]! },
      restart: () => { did.push('restart') },
      progress: (_f: number | null, m: string | null) => { progress.push(m) },
      sleep: async (ms: number) => { clock += ms; waitingSeen.push(!!updateWaiting()) },
      get clock() { return clock },
    },
  }
}

test('the cap is 30 minutes, and the line says how many tasks it waits for', () => {
  expect(UPDATE_WAIT_MS).toBe(30 * 60_000)
  expect(waitingTasks(1).en).toBe('An update is waiting for 1 running task to finish')
  expect(waitingTasks(3).en).toBe('An update is waiting for 3 running tasks to finish')
})

test('runUpdate waits for running tasks before the restart; the mark stays until the restart, and a failure clears it', async () => {
  const t = deps([2, 2, 1, 0])
  let atBackup: ReturnType<typeof updateWaiting> = null
  t.d.backups.run = (async () => { atBackup = updateWaiting(); t.did.push('backup') }) as never
  await runUpdate(t.d, '1.1.0', { staged: true, rollback: false })
  expect(t.progress.slice(0, 3)).toEqual([waitingTasks(2).en, waitingTasks(2).en, waitingTasks(1).en])
  expect(t.waitingSeen).toEqual([true, true, true])
  expect(t.did.filter((x) => x !== 'count')).toEqual(['backup', 'switch 1.1.0', 'restart'])
  expect(t.did.lastIndexOf('count')).toBeLessThan(t.did.indexOf('backup'))
  // the backup and the download after the wait are covered too; the wait is over, so its end is now
  expect(atBackup).toMatchObject({ skippable: false })
  expect(Date.parse(atBackup!.until)).toBeLessThanOrEqual(Date.now())
  // switched: kept until the restart it asked for
  expect(updateWaiting()).toMatchObject({ skippable: false })
  _resetUpdateWait()
  const failing = deps([0])
  failing.d.backups.run = (async () => { throw new Error('disk full') }) as never
  await expect(runUpdate(failing.d, '1.1.0', { staged: true, rollback: false })).rejects.toThrow('disk full')
  expect(updateWaiting()).toBeNull()
})

test('"Update now anyway" during the wait ends it: the update goes on with tasks still running', async () => {
  const t = deps([1])
  let looks = 0
  const sleep = async () => { looks++; expect(updateWaiting()).toMatchObject({ skippable: looks === 1 }); if (looks === 1) expect(skipUpdateWait()).toBe(true) }
  await runUpdate({ ...t.d, sleep }, '1.1.0', { staged: true, rollback: false })
  expect(looks).toBe(1)
  expect(t.did.filter((x) => x !== 'count')).toEqual(['backup', 'switch 1.1.0', 'restart'])
  // nothing waits now
  expect(skipUpdateWait()).toBe(false)
})

test('"Update now anyway" (force) does not wait; nothing running does not wait either', async () => {
  const forced = deps([3])
  await runUpdate({ ...forced.d, force: true }, '1.1.0', { staged: true, rollback: false })
  expect(forced.waitingSeen).toEqual([])
  _resetUpdateWait()
  expect(forced.did.filter((x) => x !== 'count')).toEqual(['backup', 'switch 1.1.0', 'restart'])
  const idle = deps([0])
  await runUpdate(idle.d, '1.1.0', { staged: true, rollback: false })
  expect(idle.waitingSeen).toEqual([])
})

test('the wait ends at its cap even with tasks still running (they stop and say so)', async () => {
  const t = deps([1])
  const real = Date.now
  let now = real()
  Date.now = () => now
  try {
    await runUpdate({ ...t.d, waitMs: 10_000, sleep: async (ms: number) => { now += ms } }, '1.1.0', { staged: true, rollback: false })
  } finally { Date.now = real }
  expect(t.did.filter((x) => x !== 'count')).toEqual(['backup', 'switch 1.1.0', 'restart'])
})

test("root's wait (root/update-waiting.json): read until its own deadline; a link, a past or far deadline is none", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-wait-'))
  try {
    const now = new Date('2026-11-14T10:00:00Z')
    const f = path.join(root, 'update-waiting.json')
    expect(updateWaiting({ rootDir: root, now })).toBeNull()
    fs.writeFileSync(f, JSON.stringify({ since: '2026-11-14T09:55:00Z', until: '2026-11-14T10:25:00Z' }))
    expect(updateWaiting({ rootDir: root, now })).toEqual({ since: '2026-11-14T09:55:00Z', until: '2026-11-14T10:25:00Z', skippable: false })
    // past its until the run still switches and restarts (then removes it): it counts for a grace, not for ever
    expect(updateWaiting({ rootDir: root, now: new Date('2026-11-14T10:26:00Z') })).not.toBeNull()
    expect(updateWaiting({ rootDir: root, now: new Date(Date.parse('2026-11-14T10:25:00Z') + ROOT_WAIT_GRACE_MS) })).toBeNull()
    fs.writeFileSync(f, JSON.stringify({ since: '2026-11-14T09:55:00Z', until: '2026-11-15T10:25:00Z' }))
    expect(updateWaiting({ rootDir: root, now })).toBeNull()
    fs.writeFileSync(f, 'not json')
    expect(updateWaiting({ rootDir: root, now })).toBeNull()
    fs.rmSync(f)
    const other = path.join(root, 'other.json')
    fs.writeFileSync(other, JSON.stringify({ since: '2026-11-14T09:55:00Z', until: '2026-11-14T10:25:00Z' }))
    fs.symlinkSync(other, f)
    expect(updateWaiting({ rootDir: root, now })).toBeNull()
    // this server's own wait counts without root
    beginUpdateWait(now, new Date(now.getTime() + 60_000))
    expect(updateWaiting({ rootDir: null, now })).not.toBeNull()
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
