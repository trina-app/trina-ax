// lib/devEnvQueue.ts: the live place in line of a waiting dev environment run. A run that is not in the waiting list
// any more (started or ended) never waits again, so it stops the poll: an old chat with a stored waiting job step does
// not read GET /api/dev-env/runs every few seconds for as long as it is open.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { QUEUE_POLL_MS, _resetQueueStore, useQueuePlace } from '../../src/lib/devEnvQueue'
import { installDom, mount, removeDom } from './dom-host'

function Probe({ id }: { id: string }) {
  const place = useQueuePlace(id)
  return <span data-testid="place">{place === undefined ? 'unread' : String(place)}</span>
}

describe('the queue store', () => {
  const realFetch = globalThis.fetch
  let reads = 0
  let waiting: { id: string; position: number }[] = []
  beforeAll(() => {
    installDom()
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).split('?')[0] !== '/api/dev-env/runs') return new Response('{}', { status: 404 })
      reads++
      const body = { running: [], waiting: waiting.map((w) => ({ id: w.id, kind: 'job', name: 'x', by: { id: 'u', name: 'U' }, startedAt: '2026-11-06T00:00:00.000Z', runAt: null, position: w.position, memoryMiB: null, lastLine: '', chatId: null, projectId: null })) }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
  })
  afterAll(() => { globalThis.fetch = realFetch; _resetQueueStore(); removeDom() })

  test('a waiting run shows its place; once it is gone the poll stops', async () => {
    _resetQueueStore(); reads = 0
    waiting = [{ id: 'run-1', position: 2 }]
    const m = await mount(<Probe id="run-1" />)
    try {
      await m.until(() => m.find('place')?.textContent === '2', 'the place')
      waiting = []
      await m.until(() => m.find('place')?.textContent === 'gone', 'gone', QUEUE_POLL_MS + 2000)
      const n = reads
      await m.settle(QUEUE_POLL_MS + 500)
      expect(reads).toBe(n)
    } finally { await m.unmount() }
  }, 15_000)
})
