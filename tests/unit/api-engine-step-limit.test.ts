// The API engine's tool rounds per answer (limits audit 1 #31): the team's answerStepLimit, as Claude Code's
// --max-turns, not a fixed 30. A fake OpenAI-compatible server stands in for the model; the turn is a real chat turn.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, type EngineId } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { writeApiEngine } from '../../server/src/engine/api-agent'

setDefaultTimeout(90_000)

/** SSE body of one Chat Completions answer: text and tool calls */
function sse(o: { text?: string; calls?: { id: string; name: string; args: string }[] }): string {
  const lines: unknown[] = []
  if (o.text) lines.push({ choices: [{ delta: { content: o.text } }] })
  for (const [i, c] of (o.calls ?? []).entries()) lines.push({ choices: [{ delta: { tool_calls: [{ index: i, id: c.id, function: { name: c.name, arguments: c.args } }] } }] })
  lines.push({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } })
  return lines.map((l) => `data: ${JSON.stringify(l)}\n\n`).join('') + 'data: [DONE]\n\n'
}

let h: Harness
let alice: TestSocket
let mock: ReturnType<typeof Bun.serve>
const script: string[] = []
const rounds = (n: number, last: string) => {
  for (let i = 0; i < n; i++) script.push(sse({ calls: [{ id: `c${i}`, name: 'list', args: '{"path":"shared"}' }] }))
  script.push(sse({ text: last }))
}
const setLimit = (n: number) => h.api('carol').call(API.updateSettings, { body: { answerStepLimit: n } })
const clear = () => h.ctx.db.query("DELETE FROM settings WHERE key = 'answerStepLimit'").run()

beforeAll(async () => {
  mock = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) { if (req.method === 'GET') return Response.json({ data: [{ id: 'm-1' }] }); await req.json(); return new Response(script.shift() ?? sse({ text: '(no script)' })) } })
  h = await startHarness({ name: 'api-engine-step-limit', concurrency: 2 })
  writeApiEngine(h.ctx.config.dataDir, { baseUrl: `http://127.0.0.1:${mock.port}/v1`, model: 'm-1', label: 'M1' })
  const confs = h.rt().engines.get()
  confs.api = { baseUrl: `http://127.0.0.1:${mock.port}/v1`, model: 'm-1', label: 'M1', key: null }
  delete confs.problems.api
  alice = await h.ws('alice'); await alice.next('hello')
})
afterAll(async () => { clear(); await h.close(); mock.stop(true) })

async function answer(content: string) {
  const chat = await h.api('alice').call(API.createChat, { body: { engine: 'api' as EngineId } })
  const r = await h.api('alice').call(API.sendMessage, { params: { id: chat.id }, body: { content, clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [], engine: 'api' as EngineId } })
  const done = (await alice.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 60_000)).data.message
  const lists = (h.ctx.db.query("SELECT COUNT(*) AS n FROM tool_events WHERE turn_id = ? AND tool = 'list'").get(r.turnId) as { n: number }).n
  return { done, lists }
}

describe('API engine: tool rounds per answer', () => {
  test('35 rounds with the team limit at 40: the answer finishes (before: it paused at 30)', async () => {
    try {
      await setLimit(40)
      rounds(35, 'all 35 done')
      const { done, lists } = await answer('go through them')
      expect(done).toMatchObject({ status: 'done', content: 'all 35 done' })
      expect(done.stopReason).toBeUndefined()
      expect(lists).toBe(35)
    } finally { clear(); script.length = 0 }
  })

  test('at the team limit the answer pauses with "continue", as with Claude Code', async () => {
    try {
      await setLimit(10)
      rounds(12, 'never said')
      const { done, lists } = await answer('go through them')
      expect(done).toMatchObject({ status: 'done', stopReason: 'tool_limit' })
      expect(done.content).not.toContain('never said')
      expect(lists).toBe(10)
    } finally { clear(); script.length = 0 }
  })
})
