// QA TC-3521: the AI could not start on the server (the engine's sandbox could not set up its program: bwrap's
// "Can't find source path …: Permission denied" after an update left the app folder unreadable to the engine account).
// The answer says so in plain words instead of "stopped partway", is not retried, and the owners and admins get one
// Inbox notice per breakage (again only after an answer worked).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API } from '@mycel/shared/api'
import { ask, startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { notificationsOf } from '../../server/src/notifications/service'
import { SANDBOX_START_FAILED } from '../../server/src/chat/turn'
import type { LaunchHandle } from '../../server/src/native'

setDefaultTimeout(30_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')

let h: Harness
let alice: TestSocket
beforeAll(async () => {
  h = await startHarness({ name: 'b-engine-start' })
  alice = await h.ws('alice', { windowId: 'win-alice-start' })
  await alice.next('hello')
})
afterAll(async () => { alice?.close(); await h.close() })

/** the launches the turn made while `fn` ran */
async function counting<T>(fn: () => Promise<T>): Promise<{ r: T; launches: number }> {
  const launcher = (await h.rt().core()).launcher!
  const orig = launcher.launch.bind(launcher)
  let launches = 0
  launcher.launch = ((...a: Parameters<typeof orig>): LaunchHandle => { launches++; return orig(...a) }) as typeof launcher.launch
  try { return { r: await fn(), launches } } finally { launcher.launch = orig }
}
const told = (userId: string) => notificationsOf(h.ctx).list(userId, {}).items.filter((n) => n.code === 'engine.start_failed')

describe('the AI could not start on the server (QA TC-3521)', () => {
  test('the sandbox words are told apart from an engine that crashed while it ran', () => {
    expect(SANDBOX_START_FAILED.test("bwrap: Can't find source path /var/lib/mycel/app/current/native/mycel-bridge: Permission denied\n")).toBe(true)
    expect(SANDBOX_START_FAILED.test("sandbox-exec: execvp() of '/x/claude' failed: Permission denied")).toBe(true)
    expect(SANDBOX_START_FAILED.test('Error: something in the engine said bwrap: later')).toBe(false)
    expect(SANDBOX_START_FAILED.test('Error: ENOSPC: no space left on device, write')).toBe(false)
  })

  test('plain words instead of "stopped partway", no retry, one notice to the owners and admins per breakage', async () => {
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const { r, launches } = await counting(() => ask(h, alice, 'alice', chat.id, fake({ startFail: true })))
    expect(r.done.status).toBe('error')
    expect(r.done.error).toMatchObject({ code: 'engine_unavailable', params: { reason: 'engine_start_failed' } })
    expect(r.done.error?.message).toBe("Trina couldn't start the AI on the server, so nothing was done. Your team's admins have been told. Try again once the server is fixed.")
    expect(launches).toBe(1)
    // the owner (dana) and the admin (carol) are told; a member (alice, who asked) is not
    expect(told('dana')).toHaveLength(1)
    expect(told('carol')).toHaveLength(1)
    expect(told('alice')).toHaveLength(0)
    expect(told('dana')[0]).toMatchObject({ readAt: null, link: null, outcome: null, chatId: null })

    // the next failure is the same breakage: nobody is told again
    await ask(h, alice, 'alice', chat.id, fake({ startFail: true }))
    expect(told('dana')).toHaveLength(1)

    // an answer that works ends it; the next failure is told again
    const ok = await ask(h, alice, 'alice', chat.id, fake({ say: 'fine' }))
    expect(ok.done.status).toBe('done')
    await ask(h, alice, 'alice', chat.id, fake({ startFail: true }))
    expect(told('dana')).toHaveLength(2)
    expect(told('carol')).toHaveLength(2)
  })

  test('an engine that crashed without output is still retried once (not a start failure)', async () => {
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const { r, launches } = await counting(() => ask(h, alice, 'alice', chat.id, fake({ crashOnce: true }, { say: 'after the retry' })))
    expect(r.done.status).toBe('done')
    expect(r.done.content).toContain('after the retry')
    expect(launches).toBe(2)
  })
})
