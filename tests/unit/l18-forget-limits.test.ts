// linux-runtime L18, the server's side: a permanently deleted chat's engine folder is forgotten through the launcher
// (op forget; the folder is the engine account's), best effort with a retry list; and a turn the Linux launcher ended
// at its memory ("oom") or chat-folder size ("disk_limit") limit gets its own error with the plan's number.
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API } from '@mycel/shared/api'
import type { LaunchEvent, LaunchRequest } from '@mycel/shared'
import { ask, startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { FORGET_PENDING_KEY, launcherSockOf, retryPendingForgets } from '../../server/src/chat/forget'
import { getSetting } from '../../server/src/admin/settings'
import { Plan, planLimits, setPlanForTests } from '../../server/src/system/limits'
import { lastSweepForget, sweep } from '../../server/src/auth/sweeper'
import type { LaunchHandle } from '../../server/src/native'

setDefaultTimeout(30_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')

let h: Harness
let alice: TestSocket
beforeAll(async () => {
  h = await startHarness({ name: 'l18' })
  alice = await h.ws('alice', { windowId: 'win-alice-l18' })
  await alice.next('hello')
})
afterAll(async () => { alice?.close(); await h.close() })

/** A launcher socket that answers forget requests and records them. */
function fakeLauncher(sock: string) {
  const got: { op: string; chatId: string }[] = []
  fs.rmSync(sock, { force: true })
  const srv = Bun.listen({
    unix: sock,
    socket: {
      data(s, d) {
        for (const l of d.toString().split('\n').filter(Boolean)) {
          const req = JSON.parse(l)
          got.push(req)
          s.write(JSON.stringify(req.chatId === 'busy-chat' ? { ev: 'error', message: 'busy: a turn of this chat is running' } : { ev: 'forgot', ok: true }) + '\n')
        }
      },
    },
  })
  return { got, stop: () => { srv.stop(true); fs.rmSync(sock, { force: true }) } }
}

const trashedChat = async (daysAgo: number) => {
  const chat = await h.api('alice').call(API.createChat, { body: {} })
  await h.api('alice').call(API.deleteChat, { params: { id: chat.id } })
  h.ctx.db.query('UPDATE chats SET deleted_at = ? WHERE id = ?').run(new Date(Date.now() - daysAgo * 86400_000).toISOString(), chat.id)
  return chat.id
}

describe('forget the engine folders of purged chats (launcher op forget)', () => {
  const sock = `/tmp/mycel-l18-${process.pid}.sock`
  afterEach(() => { delete (h.ctx.config.engine as { launcherSock?: string }).launcherSock; h.ctx.db.query('DELETE FROM settings WHERE key = ?').run(FORGET_PENDING_KEY) })

  test('dev without a launcher socket: the folder is removed directly, no launcher request', async () => {
    expect(launcherSockOf(h.ctx)).toBeNull()
    const id = await trashedChat(8)
    const dir = path.join(h.ctx.engineConfig.agentRoot, id)
    fs.mkdirSync(path.join(dir, '.tmp'), { recursive: true })
    h.rt().purgeTrash()
    await h.rt().lastForget
    expect(fs.existsSync(dir)).toBe(false)
  })

  test('with a launcher: only chats that are gone are forgotten, never one in the trash or still open', async () => {
    const l = fakeLauncher(sock)
    try {
      h.ctx.config.engine.launcherSock = sock
      const gone = await trashedChat(8)
      const trashed = await trashedChat(1)
      const open = (await h.api('alice').call(API.createChat, { body: {} })).id
      h.rt().purgeTrash()
      await h.rt().lastForget
      expect(l.got).toEqual([{ op: 'forget', chatId: gone }])
      expect(h.ctx.db.query('SELECT id FROM chats WHERE id IN (?, ?, ?)').all(gone, trashed, open).map((r) => (r as { id: string }).id).sort()).toEqual([open, trashed].sort())
      expect(getSetting(h.ctx.db, FORGET_PENDING_KEY) ?? []).toEqual([])
    } finally { l.stop() }
  })

  test('launcher down: the purge goes on, the ids wait on the retry list and go at the next run', async () => {
    h.ctx.config.engine.launcherSock = sock // nothing listens
    const a = await trashedChat(9)
    const b = await trashedChat(9)
    expect(h.rt().purgeTrash()).toBe(2)
    await h.rt().lastForget
    expect(h.ctx.db.query('SELECT COUNT(*) AS n FROM chats WHERE id IN (?, ?)').get(a, b)).toEqual({ n: 0 })
    expect([...(getSetting<string[]>(h.ctx.db, FORGET_PENDING_KEY) ?? [])].sort()).toEqual([a, b].sort())
    const l = fakeLauncher(sock)
    try {
      await retryPendingForgets(h.ctx)
      expect(l.got.map((r) => r.chatId).sort()).toEqual([a, b].sort())
      expect(getSetting<string[]>(h.ctx.db, FORGET_PENDING_KEY)).toEqual([])
    } finally { l.stop() }
  })

  test('a busy chat stays on the list; a deleted account\'s chats are forgotten by the sweep', async () => {
    const l = fakeLauncher(sock)
    try {
      h.ctx.config.engine.launcherSock = sock
      h.ctx.db.query('INSERT INTO settings (key, value) VALUES (?, ?)').run(FORGET_PENDING_KEY, JSON.stringify(['busy-chat']))
      await retryPendingForgets(h.ctx)
      expect(getSetting<string[]>(h.ctx.db, FORGET_PENDING_KEY)).toEqual(['busy-chat'])
      h.ctx.db.query('DELETE FROM settings WHERE key = ?').run(FORGET_PENDING_KEY)
      // an account deleted long ago: its chats go with the sweep
      const chat = await h.api('bob').call(API.createChat, { body: {} })
      h.ctx.db.query('UPDATE users SET deleted_at = ? WHERE id = ?').run(new Date(Date.now() - 400 * 86400_000).toISOString(), 'bob')
      try {
        expect(sweep(h.ctx).purgedUsers).toBe(1)
        await lastSweepForget
        expect(l.got.map((r) => r.chatId)).toContain(chat.id)
      } finally { h.ctx.db.query('UPDATE users SET deleted_at = NULL WHERE id = ?').run('bob') }
    } finally { l.stop() }
  })
})

describe('a turn stopped at the Linux launcher\'s limits', () => {
  /** the real launcher answers; its exit event says the turn cgroup hit a limit */
  async function withSignal<T>(signal: string, fn: () => Promise<T>): Promise<T> {
    const core = await h.rt().core()
    const launcher = core.launcher!
    const orig = launcher.launch.bind(launcher)
    launcher.launch = (req: LaunchRequest): LaunchHandle => {
      const hd = orig(req)
      return {
        kill: () => hd.kill(),
        events: (async function* () { for await (const e of hd.events) yield (e.ev === 'exit' && signal ? { ...e, code: 137, signal } : e) as LaunchEvent })(),
      }
    }
    try { return await fn() } finally { launcher.launch = orig }
  }
  afterEach(() => setPlanForTests(undefined))

  test('oom: its own error (no retry), with the plan\'s memory per answer when there is a plan', async () => {
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const r = await withSignal('oom', () => ask(h, alice, 'alice', chat.id, fake({ say: 'partial' })))
    expect(r.done.status).toBe('error')
    expect(r.done.error).toMatchObject({ code: 'payload_too_large', params: { reason: 'turn_memory_limit' } })
    expect(r.done.error?.message).toContain('more memory than one answer may use') // alice reads English
    const plan = Plan.parse({ format: 1, plan: 'basic', maxConcurrency: 2, memoryMiB: 2048, cpuCores: 2, diskGiB: 20 })
    setPlanForTests(plan)
    const r2 = await withSignal('oom', () => ask(h, alice, 'alice', chat.id, fake({ say: 'again' })))
    expect(r2.done.error?.params).toEqual({ reason: 'turn_memory_limit', limitMiB: planLimits(plan).turnMaxMiB })
    expect(r2.done.error?.message).toContain(`about ${planLimits(plan).turnMaxMiB} MB`)
  })

  test('disk_limit: its own error with the plan\'s size, for Codex too; an ordinary end is not a limit', async () => {
    const chat = await h.api('alice').call(API.createChat, { body: { engine: 'codex' } })
    setPlanForTests(Plan.parse({ format: 1, plan: 'team', maxConcurrency: 3, memoryMiB: 4096, cpuCores: 3, diskGiB: 50, turnDiskMaxMiB: 512 }))
    const r = await withSignal('disk_limit', () => ask(h, alice, 'alice', chat.id, fake({ say: 'x' })))
    expect(r.done.status).toBe('error')
    expect(r.done.error).toMatchObject({ code: 'payload_too_large', params: { reason: 'turn_disk_limit', limitMiB: 512 } })
    expect(r.done.error?.message).toContain('(512 MB)')
    // an ordinary exit is not a limit
    setPlanForTests(undefined)
    const ok = await withSignal('', () => ask(h, alice, 'alice', chat.id, fake({ say: 'fine' })))
    expect(ok.done.status).toBe('done')
  })
})
