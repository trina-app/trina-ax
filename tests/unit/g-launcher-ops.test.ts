// linux-runtime spec 3.3.2 / 3.8.10 (L11, L18 launcher part): the launcher's status and forget requests, on macOS
// and Linux alike (no OS sandbox needed: the launcher runs as the current user here).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { nativeBinDir } from '../../server/src/config'
import { SocketLauncher, launcherForget, launcherStatus } from '../../server/src/native'
import { WORK } from '../lib/env'

const BIN = path.join(nativeBinDir(), 'mycel-launcher')
const W = path.join(WORK, 'g-launcher-ops')
const AGENT = path.join(W, 'agent')
const SOCK = path.join(W, 'l.sock')
const SLEEP = fs.existsSync('/bin/sleep') ? '/bin/sleep' : '/usr/bin/sleep'
let proc: Bun.Subprocess<'pipe', 'pipe', 'inherit'> | null = null

beforeAll(async () => {
  fs.rmSync(W, { recursive: true, force: true })
  fs.mkdirSync(path.join(AGENT, 'codex-auth'), { recursive: true })
  proc = Bun.spawn([BIN, '--listen', SOCK, '--agent-root', AGENT, '--bridge', '/nonexistent/bridge', '--tools-sock', path.join(W, 'tools.sock'),
    '--allow-cmd', SLEEP, '--codex-auth-dir', path.join(AGENT, 'codex-auth'), '--exit-with-parent'], { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' })
  const r = proc.stdout.getReader()
  expect(new TextDecoder().decode((await r.read()).value)).toContain('ready')
  r.releaseLock()
})
afterAll(() => { proc?.kill() })

describe.skipIf(!fs.existsSync(BIN))('launcher status / forget', () => {
  test('status answers with the OS and the sandbox kind', async () => {
    const s = await launcherStatus(SOCK)
    expect(s).not.toBeNull()
    expect(s!.os).toBe(process.platform)
    expect(s!.sandbox).toBe('none')
    expect(s!.liveTurns).toBe(0)
  })

  test('forget deletes a chat folder (also through a planted link inside), refuses reserved and bad names', async () => {
    const chat = path.join(AGENT, 'c_forget1')
    fs.mkdirSync(path.join(chat, '.claude', 'projects'), { recursive: true })
    const keep = path.join(W, 'outside.txt')
    fs.writeFileSync(keep, 'keep')
    fs.symlinkSync(W, path.join(chat, 'link-out'))
    expect(await launcherForget(SOCK, 'c_forget1')).toEqual({ ok: true })
    expect(fs.existsSync(chat)).toBe(false)
    expect(fs.readFileSync(keep, 'utf8')).toBe('keep')
    // a missing folder is fine
    expect(await launcherForget(SOCK, 'c_never_existed')).toEqual({ ok: true })
    expect((await launcherForget(SOCK, 'codex-auth')).ok).toBe(false)
    expect(fs.existsSync(path.join(AGENT, 'codex-auth'))).toBe(true)
    expect((await launcherForget(SOCK, 'home')).ok).toBe(false)
    await expect(launcherForget(SOCK, '../x')).rejects.toThrow()
  })

  test('forget refuses a chat whose turn is running', async () => {
    const h = new SocketLauncher(SOCK).launch({ op: 'run', turnId: 'tbusy', chatDir: path.join(AGENT, 'c_busy'), cmd: SLEEP, args: ['2'], env: {}, token: 'x', systemPrompt: '', stdin: '', timeoutMs: 10_000 })
    const it = h.events[Symbol.asyncIterator]()
    expect((await it.next()).value?.ev).toBe('started')
    const busy = await launcherForget(SOCK, 'c_busy')
    expect(busy.ok).toBe(false)
    expect(busy.message).toContain('busy')
    expect((await launcherStatus(SOCK))!.liveTurns).toBe(1)
    for (let e = await it.next(); !e.done; e = await it.next()) if (e.value.ev === 'exit') break
    expect(await launcherForget(SOCK, 'c_busy')).toEqual({ ok: true })
    expect((await launcherStatus(SOCK))!.liveTurns).toBe(0)
  })
})
