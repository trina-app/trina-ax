// Job progress (TC-154 F1, F2): a job that waits for its turn says nothing until it starts, and then says so at once
// (the voice box goes from "waiting" to "transcribing"); the 500 ms progress throttle never drops a new step label, and
// the last update it holds back still goes out (a stalled update download showed "backing up the database" for 2 min).
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { componentC } from '../../server/src/team-files/component'
import { makeCApp, type CApp } from '../lib/c-app'
import { waitFor } from '../lib/wait'

setDefaultTimeout(30_000)

let A: CApp
beforeAll(async () => { A = await makeCApp('p1-job-steps') })
afterAll(async () => { await A.close() })
const C = () => componentC(A.ctx)
const events = (id: string) => A.hub.of('job.progress', 'alice').map((e) => e.data).filter((d) => d.jobId === id)

test('a queued job is told only when it starts', async () => {
  A.hub.clear()
  let release!: () => void
  const held = new Promise<void>((r) => { release = r })
  const first = C().jobs.start({ kind: 'transcribe', userId: 'alice', run: async () => { await held; return null } })
  const second = C().jobs.start({ kind: 'transcribe', userId: 'alice', run: async () => null })
  await waitFor(() => events(first).length > 0)
  expect(events(first)[0]).toMatchObject({ progress: null, message: null })
  await Bun.sleep(50)
  expect(C().jobs.get(second)!.status).toBe('queued')
  expect(events(second)).toEqual([]) // waiting: no "it runs" for the second one yet
  release()
  await C().jobs.wait(second)
  expect(events(second)[0]).toMatchObject({ progress: null, message: null })
})

test('a new step label goes out at once; the last held-back update goes out after the throttle', async () => {
  A.hub.clear()
  let release!: () => void
  const stalled = new Promise<void>((r) => { release = r })
  const id = C().jobs.start({ kind: 'update', userId: 'alice', run: async (h) => {
    h.progress(0.2, 'backing up')
    h.progress(0.3, 'downloading') // < 500 ms later: a new step, must not be dropped
    h.progress(0.31, 'downloading') // same step: held back …
    h.progress(0.32, 'downloading') // … only the latest is kept
    await stalled // the download stalls: nothing more comes
    return null
  } })
  await waitFor(() => events(id).some((e) => e.message === 'downloading'))
  expect(C().jobs.get(id)).toMatchObject({ status: 'running', message: 'downloading', progress: 0.3 })
  // the held-back 0.32 goes out once the 500 ms are over, though nothing else is reported
  await waitFor(() => events(id).some((e) => e.progress === 0.32), { timeoutMs: 3000 })
  expect(C().jobs.get(id)).toMatchObject({ message: 'downloading', progress: 0.32 })
  expect(events(id).map((e) => [e.progress, e.message])).toEqual([[null, null], [0.2, 'backing up'], [0.3, 'downloading'], [0.32, 'downloading']])
  release()
  const done = (await C().jobs.wait(id))!
  expect(done.status).toBe('done')
})

test('a held-back update is not written after the job settled', async () => {
  A.hub.clear()
  const id = C().jobs.start({ kind: 'export', userId: 'alice', run: async (h) => {
    h.progress(0.5, 'files')
    h.progress(0.6, 'files') // held back, then the job ends
    return null
  } })
  const done = (await C().jobs.wait(id))!
  await Bun.sleep(700)
  expect(C().jobs.get(id)).toMatchObject({ status: 'done', progress: 1 })
  expect(events(id).some((e) => e.progress === 0.6)).toBe(false)
  expect(done.status).toBe('done')
})
