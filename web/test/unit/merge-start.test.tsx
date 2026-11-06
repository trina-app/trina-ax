// A merge chat made at the end of the welcome steps starts when its person has it on screen (lib/mergeStart.ts,
// docs/DECISIONS.md "W5"; the review of PR #100: queued at the steps' end, its save cards timed out before the owner
// opened the notice): one start call while the page is visible, none for a chat that does not wait or is in the
// trash, none while the tab is hidden (a restored session) until it is shown, never two at once.
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { StrictMode, useState } from 'react'
import type { Chat } from '@mycel/shared/api'
import { useWaitingMerge } from '../../src/lib/mergeStart'
import { FakeEvent, installDom, mount, removeDom } from './dom-host'

const CHAT = '01900000-0000-7000-8000-0000000000c7'
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const realFetch = globalThis.fetch
let calls: string[] = []
let answer: () => Response = () => json(200, { started: true })
beforeAll(() => {
  installDom()
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${String(input).split('?')[0]}`)
    // the answer a moment later, as a real request: a second effect run meanwhile must not ask again
    await new Promise((r) => setTimeout(r, 30))
    return answer()
  }) as unknown as typeof fetch
})
afterEach(() => {
  calls = []
  answer = () => json(200, { started: true })
  ;(globalThis.document as unknown as { visibilityState?: string }).visibilityState = undefined
})
afterAll(() => { globalThis.fetch = realFetch; removeDom() })

type C = Pick<Chat, 'id' | 'mergeWaiting' | 'deletedAt'>
function Page({ chat }: { chat: C }) {
  const [said, setSaid] = useState('')
  useWaitingMerge(chat, { started: (id) => setSaid(`started ${id}`), error: () => setSaid('failed') })
  return <p data-testid="said">{said}</p>
}
const START = `POST /api/skill-shares/merge-chats/${CHAT}/start`

test('a waiting merge chat on screen: one start, even with React\'s double effects; the page hears it started', async () => {
  const m = await mount(<StrictMode><Page chat={{ id: CHAT, mergeWaiting: true, deletedAt: null }} /></StrictMode>)
  try {
    await m.until(() => m.get('said').textContent === `started ${CHAT}`, 'started')
    expect(calls).toEqual([START])
  } finally { await m.unmount() }
})

test('a chat that does not wait, or is in the trash: no call', async () => {
  for (const chat of [{ id: CHAT, deletedAt: null }, { id: CHAT, mergeWaiting: true as const, deletedAt: '2026-11-06T00:00:00.000Z' }]) {
    const m = await mount(<Page chat={chat} />)
    try { await m.settle(80) } finally { await m.unmount() }
  }
  expect(calls).toEqual([])
})

test('a hidden tab waits until it is shown; a refusal (the budget) is said, and the next showing asks again', async () => {
  const doc = globalThis.document as unknown as { visibilityState?: string; dispatchEvent: (e: FakeEvent) => boolean }
  doc.visibilityState = 'hidden'
  answer = () => json(402, { error: { code: 'budget_exceeded', message: 'used up' } })
  const m = await mount(<Page chat={{ id: CHAT, mergeWaiting: true, deletedAt: null }} />)
  try {
    await m.settle(80)
    expect(calls).toEqual([])
    doc.visibilityState = 'visible'
    doc.dispatchEvent(new FakeEvent('visibilitychange'))
    await m.until(() => m.get('said').textContent === 'failed', 'the refusal')
    answer = () => json(200, { started: true })
    doc.dispatchEvent(new FakeEvent('visibilitychange'))
    await m.until(() => m.get('said').textContent === `started ${CHAT}`, 'started')
    expect(calls).toEqual([START, START])
  } finally { await m.unmount() }
})
