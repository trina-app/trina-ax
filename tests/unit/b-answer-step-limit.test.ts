// Tool rounds per answer (docs/DECISIONS.md "Tool rounds per answer"): Claude Code's --max-turns comes from Admin >
// Team settings `answerStepLimit` (default 150, 10-500), read when each answer starts. At the limit the answer pauses
// with "continue" as before; sub-agents keep their own 50 rounds each. Fake engine through the real launcher and gate.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, ApiError, DEFAULT_ANSWER_STEP_LIMIT } from '@mycel/shared/api'
import { ask, startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { MAX_SUBAGENT_TURNS } from '../../server/src/chat/subagents'
import { DEFAULT_MAX_ENGINE_TURNS } from '../../server/src/chat/runtime'

setDefaultTimeout(40_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const read = { tool: 'read', args: { file_path: 'users/alice/todo.md' } }

let h: Harness
let alice: TestSocket
beforeAll(async () => {
  h = await startHarness({ name: 'b-step-limit', askUserTimeoutMs: 3000, turnTimeoutMs: 60_000 })
  alice = await h.ws('alice', { windowId: 'win-alice-steps' })
  await alice.next('hello')
})
afterAll(async () => { alice?.close(); await h.close() })

const newChat = async () => h.api('alice').call(API.createChat, { body: {} })
/** the --max-turns the engine of a new answer was started with */
const maxTurnsOfNextAnswer = async (): Promise<string> => {
  const r = await ask(h, alice, 'alice', (await newChat()).id, fake({ echo: 'args' }))
  const argv = JSON.parse(r.done.content) as string[]
  return argv[argv.indexOf('--max-turns') + 1]!
}
const setLimit = (n: unknown) => h.api('carol').call(API.updateSettings, { body: { answerStepLimit: n as number } })
const clear = () => h.ctx.db.query("DELETE FROM settings WHERE key = 'answerStepLimit'").run()

describe('tool rounds per answer', () => {
  test('default 150, in the settings and on the engine command line', async () => {
    clear()
    expect(DEFAULT_ANSWER_STEP_LIMIT).toBe(150)
    expect(DEFAULT_MAX_ENGINE_TURNS).toBe(150)
    expect((await h.api('carol').call(API.settings)).answerStepLimit).toBe(150)
    expect(await maxTurnsOfNextAnswer()).toBe('150')
  })

  test('an admin changes it for the next answer; it is audited; out of range is refused; members cannot', async () => {
    try {
      expect((await setLimit(12)).answerStepLimit).toBe(12)
      expect(await maxTurnsOfNextAnswer()).toBe('12')
      const row = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'settings.update' ORDER BY rowid DESC LIMIT 1").get() as { detail: string }
      expect(JSON.parse(row.detail)).toEqual({ answerStepLimit: 12 })
      for (const bad of [9, 501, 12.5, '100', null]) {
        const e = await setLimit(bad).catch((x) => x)
        expect(e).toBeInstanceOf(ApiError)
        expect((e as ApiError).status).toBe(400)
      }
      expect((await setLimit(500)).answerStepLimit).toBe(500)
      expect((await setLimit(10)).answerStepLimit).toBe(10)
      const member = await h.api('alice').call(API.updateSettings, { body: { answerStepLimit: 400 } }).catch((x) => x)
      expect((member as ApiError).status).toBe(403)
      expect(await maxTurnsOfNextAnswer()).toBe('10')
    } finally { clear() }
  })

  test('a stored value that is not a valid limit falls back to 150', async () => {
    try {
      for (const v of ['"lots"', '3', '100000', '7.5']) {
        h.ctx.db.query("INSERT INTO settings (key, value) VALUES ('answerStepLimit', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(v)
        expect(await maxTurnsOfNextAnswer()).toBe('150')
        expect((await h.api('carol').call(API.settings)).answerStepLimit).toBe(150)
      }
    } finally { clear() }
  })

  test('at the team limit the answer pauses with "continue" as before', async () => {
    try {
      await setLimit(10)
      const reads = Array.from({ length: 11 }, () => read)
      const r = await ask(h, alice, 'alice', (await newChat()).id, fake({ say: 'Working through it.' }, ...reads, { say: 'never said' }))
      expect(r.done).toMatchObject({ status: 'done', error: null, stopReason: 'tool_limit', content: 'Working through it.' })
      expect(r.done.steps.filter((s) => s.tool === 'read')).toHaveLength(10)
      const under = await ask(h, alice, 'alice', (await newChat()).id, fake(...Array.from({ length: 10 }, () => read), { say: 'all ten' }))
      expect(under.done).toMatchObject({ status: 'done', content: 'all ten' })
      expect(under.done.stopReason).toBeUndefined()
    } finally { clear() }
  })

  test('sub-agents keep their own 50 rounds whatever the team limit is', async () => {
    try {
      for (const n of [12, 150, 500]) {
        await setLimit(n)
        const r = await ask(h, alice, 'alice', (await newChat()).id, fake({ echo: 'agents' }))
        const agents = JSON.parse(r.done.content) as Record<string, { maxTurns: number }>
        expect(Object.keys(agents).sort()).toEqual(['Explore', 'general-purpose'])
        for (const a of Object.values(agents)) expect(a.maxTurns).toBe(MAX_SUBAGENT_TURNS)
      }
      expect(MAX_SUBAGENT_TURNS).toBe(50)
    } finally { clear() }
  })
})
