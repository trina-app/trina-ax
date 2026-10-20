// A job that never runs (canceled while queued, server shutting down) gives back what was set aside for it. A
// transcription canceled while it waited behind another one left the person's recording in <data>/work until the
// next day's sweep.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { componentC } from '../../server/src/team-files/component'
import { makeCApp, type CApp } from '../lib/c-app'
import { waitFor } from '../lib/wait'

let A: CApp
beforeAll(async () => { A = await makeCApp('p1-job-discard') })
afterAll(async () => { await A.close() })
const C = () => componentC(A.ctx)

test('canceling a queued transcription removes its recording at once', async () => {
  // one transcription at a time: a stand-in holds the slot until released
  let release!: () => void
  const held = new Promise<void>((r) => { release = r })
  const first = C().jobs.start({ kind: 'transcribe', userId: 'alice', run: async () => { await held; return null } })
  const work = path.join(A.ctx.config.dataDir, 'work')
  fs.mkdirSync(work, { recursive: true })
  const rec = path.join(work, 'upload-recording.webm')
  fs.writeFileSync(rec, 'audio bytes')
  const second = C().startTranscribe('alice', rec, 'meeting.webm')
  await Bun.sleep(20)
  expect(C().jobs.get(second)!.status).toBe('queued')
  const own = fs.readdirSync(work).filter((f) => f.startsWith('stt-in-'))
  expect(own.length).toBe(1) // taken over by the job
  expect(C().jobs.cancel(second)).toBe(true)
  expect(C().jobs.get(second)!.status).toBe('canceled')
  expect(fs.existsSync(path.join(work, own[0]!))).toBe(false)
  release()
  expect((await C().jobs.wait(first))!.status).toBe('done')
})

test('jobs still queued at shutdown are discarded; a discard that throws does not stop the others', async () => {
  let release!: () => void
  const held = new Promise<void>((r) => { release = r })
  const svc = C().jobs
  svc.start({ kind: 'export', userId: 'alice', run: async () => { await held; return null } })
  const discarded: string[] = []
  svc.start({ kind: 'export', userId: 'alice', run: async () => null, discard: () => { discarded.push('a'); throw new Error('boom') } })
  svc.start({ kind: 'export', userId: 'alice', run: async () => null, discard: () => { discarded.push('b') } })
  await Bun.sleep(20)
  const closing = svc.close()
  expect(discarded).toEqual(['a', 'b'])
  release()
  await closing
  expect(await waitFor(() => discarded.length === 2)).toBe(true)
})
