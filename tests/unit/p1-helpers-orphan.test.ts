// The gate and the launcher the server starts (dev / local-login; the gate also in production) stayed behind as
// orphans when the server died without its shutdown hook (kill -9, a crash, `bun --watch` restarts): every such
// restart left one more pair running for good. Found on the dev machine: two pairs with parent pid 1, 90 minutes old.
// They now exit when the server's end of their stdin pipe closes; the launcher first ends its turns (SIGTERM, SIGKILL
// after 5 s).
import { expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { WORK } from '../lib/env'
import { waitFor } from '../lib/wait'

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

test('kill -9 of the server: gate, launcher and the running engine all go', async () => {
  const dir = path.join(WORK, 'p1-helpers-orphan')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const run = fs.mkdtempSync('/tmp/mycel-p1o-') // unix socket paths must stay short
  const parent = Bun.spawn([process.execPath, path.join(import.meta.dir, '..', 'lib', 'p1-helper-parent.ts'), dir, run], { stdout: 'pipe', stderr: 'inherit' })
  const r = parent.stdout.getReader()
  let line = ''
  while (!line.includes('\n')) { const { value, done } = await r.read(); if (done) break; line += new TextDecoder().decode(value) }
  const p = JSON.parse(line) as { gate: number; launcher: number; engine: number; child: number }
  const all = [p.gate, p.launcher, p.engine, p.child]
  try {
    expect(all.every(alive)).toBe(true)
    parent.kill('SIGKILL')
    await parent.exited
    expect(await waitFor(() => !alive(p.gate), { timeoutMs: 3000 })).toBe(true)
    // the engine ignores SIGTERM: the launcher waits for it up to 5 s, kills the group, then exits
    expect(await waitFor(() => !all.some(alive), { timeoutMs: 10_000 })).toBe(true)
  } finally {
    for (const x of all) try { process.kill(x, 'SIGKILL') } catch {}
    fs.rmSync(run, { recursive: true, force: true })
  }
}, 30_000)
