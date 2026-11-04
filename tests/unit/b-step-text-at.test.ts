// Where a step started in the answer (Step.textAt): the chat shows an artifact's card at that point of the text
// (web/src/components/chat/Messages.tsx), so "caption → preview → three options" reads in that order. Through the real
// runtime and launcher with the fake engine. Needs `bun run build:native`.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { API, type Step } from '@mycel/shared/api'
import { ask, startHarness, type Harness, type TestSocket } from '../lib/b-harness'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')

let h: Harness
let alice: TestSocket
beforeAll(async () => {
  h = await startHarness({ name: 'b-step-text-at' })
  alice = await h.ws('alice', { windowId: 'win-text-at-1' })
})
afterAll(async () => { alice?.close(); await h?.close() })

const artifactStep = (steps: Step[]) => steps.find((s) => s.kind === 'artifact')

test('a step records how much answer text came before it; the stored message keeps it', async () => {
  const chat = await h.api('alice').call(API.createChat, { body: {} })
  const caption = '추천 2안을 인스타그램 피드에 올리면 이렇게 보여요.'
  const r = await ask(h, alice, 'alice', chat.id, fake(
    { say: caption },
    { tool: 'artifact', args: { action: 'create', key: 'preview', type: 'html', title: '미리보기', content: '<p>2안</p>' } },
    { say: '\n\n> 1안' },
  ))
  const step = artifactStep(r.done.steps)
  expect(step?.textAt).toBe(caption.length)
  expect(r.done.content.slice(0, step!.textAt)).toBe(caption)
  // read back from the server, as a reload would
  const page = await h.api('alice').call(API.listMessages, { params: { id: chat.id }, query: {} })
  const stored = page.items.find((m) => m.id === r.done.id)!
  expect(artifactStep(stored.steps)?.textAt).toBe(caption.length)
})

test('a step before any text is at 0', async () => {
  const chat = await h.api('alice').call(API.createChat, { body: {} })
  const r = await ask(h, alice, 'alice', chat.id, fake(
    { tool: 'artifact', args: { action: 'create', key: 'first', type: 'html', content: '<p>x</p>' } },
    { say: 'after' },
  ))
  expect(artifactStep(r.done.steps)?.textAt).toBe(0)
})
