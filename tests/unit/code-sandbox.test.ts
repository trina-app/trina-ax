// Code sandbox (docs/DECISIONS.md "Code sandbox", D1): off by default; the scope (everyone / groups / people) counts
// only with a consent to the current warning; owner or admin only, consent and scope in the audit log; the turn offers
// run_code and asks the launcher for a code turn only when the scope names the person AND the launcher can run code;
// every call checks the scope again. The engine lockdown (Bash denied, --restricted, Codex without a shell) holds in
// both states. The sandbox itself is tested on Linux (tests/linux/driver.ts, tests/install/g-linux-install.ts).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { API, CODE_SANDBOX_WARNING_VERSION } from '@mycel/shared/api'
import type { LauncherStatus } from '@mycel/shared'
import { ask, startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { availabilityOf, codeSandboxBadge, codeSandboxFor, codeSandboxInForce, setCodeSandbox, setCodeSandboxProbe } from '../../server/src/admin/code-sandbox'
import { codeResultText, runCodeTool } from '../../server/src/chat/code-sandbox'
import { buildClaudeLaunch, CLAUDE_BUILTIN_DENIED } from '../../server/src/engine/claude'
import { CODEX_DISABLED_FEATURES } from '../../server/src/engine/codex'
import { PARENT_ONLY_TOOLS } from '../../server/src/chat/subagents'
import { stepLabel } from '@mycel/shared'

setDefaultTimeout(40_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const LINUX_OK: LauncherStatus = { ev: 'status', os: 'linux', sandbox: 'bwrap', codeSandbox: { available: true, runtimes: { bash: true, python3: true, jq: true, unzip: false } } }

let h: Harness
let alice: TestSocket
beforeAll(async () => {
  h = await startHarness({ name: 'code-sandbox', askUserTimeoutMs: 3000, turnTimeoutMs: 60_000 })
  alice = await h.ws('alice', { windowId: 'win-alice-code' })
  await alice.next('hello')
})
afterAll(async () => { setCodeSandboxProbe(null); alice?.close(); await h.close() })

const reset = () => { h.ctx.db.query("DELETE FROM settings WHERE key LIKE 'codeSandbox.%'").run(); setCodeSandboxProbe(null) }
const consent = { by: { id: 'dana', name: 'Dana Choi' }, at: new Date().toISOString(), warningVersion: CODE_SANDBOX_WARNING_VERSION }

describe('the setting', () => {
  test('off by default; a scope counts only with a consent to the current warning', () => {
    reset()
    expect(codeSandboxInForce(h.ctx)).toBe(false)
    expect(codeSandboxFor(h.ctx, 'alice')).toBe(false)
    setCodeSandbox(h.ctx, { mode: 'everyone', groupIds: [], userIds: [] }, null)
    expect(codeSandboxFor(h.ctx, 'alice')).toBe(false) // no consent
    setCodeSandbox(h.ctx, { mode: 'everyone', groupIds: [], userIds: [] }, { ...consent, warningVersion: CODE_SANDBOX_WARNING_VERSION - 1 || 0.5 } as never)
    expect(codeSandboxFor(h.ctx, 'alice')).toBe(false) // an older warning
    setCodeSandbox(h.ctx, { mode: 'everyone', groupIds: [], userIds: [] }, consent)
    expect(codeSandboxFor(h.ctx, 'alice')).toBe(true)
    reset()
  })

  test('selected: the people named and the members of the groups named, owners and admins included only so', () => {
    reset()
    setCodeSandbox(h.ctx, { mode: 'selected', groupIds: [], userIds: ['alice'] }, consent)
    expect(codeSandboxFor(h.ctx, 'alice')).toBe(true)
    expect(codeSandboxFor(h.ctx, 'bob')).toBe(false)
    expect(codeSandboxFor(h.ctx, 'dana')).toBe(false) // the owner is not named
    const g = h.ctx.db.query("SELECT group_id FROM group_members WHERE user_id = 'bob' LIMIT 1").get() as { group_id: string } | null
    if (g) {
      setCodeSandbox(h.ctx, { mode: 'selected', groupIds: [g.group_id], userIds: [] }, null)
      expect(codeSandboxFor(h.ctx, 'bob')).toBe(true)
    }
    h.ctx.db.query("UPDATE users SET status = 'disabled' WHERE id = 'alice'").run()
    setCodeSandbox(h.ctx, { mode: 'everyone', groupIds: [], userIds: [] }, null)
    try { expect(codeSandboxFor(h.ctx, 'alice')).toBe(false) } finally { h.ctx.db.query("UPDATE users SET status = 'active' WHERE id = 'alice'").run() }
    reset()
  })

  test('what the launcher says becomes the availability (fails closed)', () => {
    expect(availabilityOf(null)).toEqual({ available: false, reason: 'launcher' })
    expect(availabilityOf({ ev: 'status', os: 'darwin', sandbox: 'sandbox-exec', codeSandbox: { available: false, reason: 'not supported on macOS yet' } }).reason).toBe('platform')
    expect(availabilityOf({ ev: 'status', os: 'linux', sandbox: 'bwrap' }).reason).toBe('platform') // an older launcher
    expect(availabilityOf({ ev: 'status', os: 'linux', sandbox: 'none', codeSandbox: { available: true } }).available).toBe(false)
    expect(availabilityOf({ ev: 'status', os: 'linux', sandbox: 'bwrap', codeSandbox: { available: false, reason: 'code_sandbox_unavailable: the plan does not include the code sandbox' } }).reason).toBe('plan')
    expect(availabilityOf(LINUX_OK)).toMatchObject({ available: true, runtimes: { python3: true } })
  })
})

describe('Admin > Team settings', () => {
  test('owner or admin only; turning on needs the warning; consent and scope go to the audit log', async () => {
    reset()
    setCodeSandboxProbe(async () => LINUX_OK)
    const scope = { mode: 'everyone' as const, groupIds: [], userIds: [] }
    await expect(h.api('alice').call(API.codeSandbox)).rejects.toMatchObject({ status: 403 })
    await expect(h.api('alice').call(API.updateCodeSandbox, { body: { scope, acceptWarning: CODE_SANDBOX_WARNING_VERSION } })).rejects.toMatchObject({ status: 403 })
    const first = await h.api('carol').call(API.codeSandbox)
    expect(first).toMatchObject({ scope: { mode: 'off' }, consent: null, warningVersion: CODE_SANDBOX_WARNING_VERSION, availability: { available: true } })
    await expect(h.api('carol').call(API.updateCodeSandbox, { body: { scope } })).rejects.toMatchObject({ status: 409, body: { params: { reason: 'code_sandbox_warning' } } })
    expect(codeSandboxInForce(h.ctx)).toBe(false)
    const on = await h.api('carol').call(API.updateCodeSandbox, { body: { scope, acceptWarning: CODE_SANDBOX_WARNING_VERSION } })
    expect(on.consent).toMatchObject({ by: { id: 'carol' }, warningVersion: CODE_SANDBOX_WARNING_VERSION })
    const rows = h.ctx.db.query("SELECT actor_id, action, detail FROM audit_log WHERE action LIKE 'code_sandbox.%' ORDER BY id").all() as { actor_id: string; action: string; detail: string }[]
    expect(rows.map((r) => [r.actor_id, r.action])).toEqual([['carol', 'code_sandbox.consent'], ['carol', 'code_sandbox.scope']])
    expect(JSON.parse(rows[0]!.detail)).toMatchObject({ warningVersion: CODE_SANDBOX_WARNING_VERSION })
    expect(JSON.parse(rows[1]!.detail)).toMatchObject({ before: { mode: 'off' }, after: { mode: 'everyone' } })
    // the badge for the person (GET /api/me user.codeSandbox)
    expect(codeSandboxBadge(h.ctx, 'alice')).toBe(true)
    // later changes need no new acceptance while the warning is the same; off always works
    await h.api('dana').call(API.updateCodeSandbox, { body: { scope: { mode: 'selected', groupIds: [], userIds: ['bob'] } } })
    expect(codeSandboxBadge(h.ctx, 'alice')).toBe(false)
    await h.api('dana').call(API.updateCodeSandbox, { body: { scope: { mode: 'off', groupIds: [], userIds: [] } } })
    expect(codeSandboxInForce(h.ctx)).toBe(false)
    // an installation that cannot run code: refused (turning off still works)
    setCodeSandboxProbe(async () => ({ ev: 'status', os: 'darwin', sandbox: 'sandbox-exec', codeSandbox: { available: false, reason: 'not supported on macOS yet' } }))
    await expect(h.api('dana').call(API.updateCodeSandbox, { body: { scope } })).rejects.toMatchObject({ status: 409, body: { params: { reason: 'code_sandbox_unavailable', why: 'platform' } } })
    await expect(h.api('dana').call(API.updateCodeSandbox, { body: { scope: { mode: 'selected', groupIds: [], userIds: ['nobody-here'] }, acceptWarning: 1 } })).rejects.toMatchObject({ status: 400 })
    reset()
  })
})

describe('the turn', () => {
  test('off: no run_code, no code turn; the lockdown is unchanged', async () => {
    reset()
    setCodeSandboxProbe(async () => LINUX_OK)
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const r = await ask(h, alice, 'alice', chat.id, fake({ echo: 'args' }))
    const args = JSON.parse(r.done.content) as string[]
    expect(args[args.indexOf('--allowedTools') + 1]).not.toContain('run_code')
    expect(args).toContain('--restricted')
    expect(args[args.indexOf('--disallowedTools') + 1]!.split(',')).toContain('Bash')
    reset()
  })

  test('on, but this launcher cannot run code: no run_code offered', async () => {
    reset()
    setCodeSandbox(h.ctx, { mode: 'everyone', groupIds: [], userIds: [] }, consent)
    // the real launcher of this test (macOS stage 1 or Linux without bwrap) says no
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const r = await ask(h, alice, 'alice', chat.id, fake({ echo: 'args' }))
    const args = JSON.parse(r.done.content) as string[]
    expect(args[args.indexOf('--allowedTools') + 1]).not.toContain('run_code')
    reset()
  })

  test('on and (said) available: the turn asks for a code turn, and a launcher without the sandbox refuses it (fails closed)', async () => {
    reset()
    setCodeSandbox(h.ctx, { mode: 'everyone', groupIds: [], userIds: [] }, consent)
    setCodeSandboxProbe(async () => LINUX_OK) // a lie: the launcher of this test has no code sandbox
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const r = await ask(h, alice, 'alice', chat.id, fake({ echo: 'args' }))
    expect(r.done.status).toBe('error')
    expect(r.done.content).not.toContain('--allowedTools')
    reset()
  })
})

describe('the tool', () => {
  const launcher = (answer: (req: any) => unknown) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-'))
    const sock = path.join(dir, 'l.sock')
    const seen: any[] = []
    const srv = net.createServer((c) => {
      let b = ''
      c.on('data', (d) => {
        b += d
        const i = b.indexOf('\n')
        if (i < 0) return
        const req = JSON.parse(b.slice(0, i))
        seen.push(req)
        c.end(JSON.stringify(answer(req)) + '\n')
      })
    })
    srv.listen(sock)
    return { sock, seen, close: () => { srv.close(); fs.rmSync(dir, { recursive: true, force: true }) } }
  }

  test('a call goes to the launcher for this turn; the result is text; the scope is checked on every call', async () => {
    reset()
    setCodeSandbox(h.ctx, { mode: 'everyone', groupIds: [], userIds: [] }, consent)
    const l = launcher(() => ({ ev: 'code_exit', code: 0, signal: '', stdout: '42\n', stderr: '', truncated: false, ms: 120 }))
    try {
      const tool = runCodeTool({ db: h.ctx.db, turnId: 't_code_1', userId: 'alice', signal: new AbortController().signal, sock: async () => l.sock }, LINUX_OK.codeSandbox!.runtimes)
      expect(tool.description).toContain('NO network')
      expect(tool.description).toContain('python3')
      expect(tool.description).not.toContain('unzip')
      const r = await tool.call({ lang: 'python', code: 'print(6*7)' }, null as never)
      expect(r.isError).toBeUndefined()
      expect((r.content[0] as { text: string }).text).toContain('Exit code 0.')
      expect((r.content[0] as { text: string }).text).toContain('42')
      expect(r.summary).toMatch(/^run_code python \(10 bytes\) -> exit 0/)
      expect(l.seen[0]).toEqual({ op: 'code', turnId: 't_code_1', lang: 'python', code: 'print(6*7)', timeoutMs: 60_000 })
      // the admin turns it off during the answer: the next call is refused without asking the launcher
      setCodeSandbox(h.ctx, { mode: 'off', groupIds: [], userIds: [] }, null)
      const off = await tool.call({ lang: 'bash', code: 'id' }, null as never)
      expect(off.isError).toBe(true)
      expect(off.summary).toMatch(/-> off$/)
      expect(l.seen).toHaveLength(1)
      const bad = await tool.call({ lang: 'node', code: '1' }, null as never)
      expect(bad.isError).toBe(true)
    } finally { l.close(); reset() }
  })

  test('result text: limits are said in words', () => {
    expect(codeResultText({ code: -1, signal: 'timeout', stdout: '', stderr: '', truncated: false, ms: 60000 })).toContain('time limit')
    expect(codeResultText({ code: 137, signal: 'oom', stdout: 'a', stderr: 'b', truncated: true, ms: 10 })).toMatch(/memory[\s\S]*--- stdout ---\na[\s\S]*--- stderr ---\nb[\s\S]*64 KiB/)
    expect(codeResultText({ code: 0, signal: 'disk_limit', stdout: '', stderr: '', truncated: false, ms: 10 })).toContain('disk limit')
  })

  test('step label and sub-agents', () => {
    expect(stepLabel('run_code', { lang: 'python', code: '# sum\nprint(sum([1, 2]))' }, 'en', new Set())).toBe('Run code · python3 · print(sum([1, 2]))')
    expect(PARENT_ONLY_TOOLS.has('run_code')).toBe(true)
  })
})

describe('the engine lockdown holds in both states', () => {
  const base = { turnId: 't1', chatDir: '/agent/c1', token: 'x', systemPrompt: 's', message: 'm', sessionId: 's1', resume: false, stash: null, maxTurns: 10, timeoutMs: 1000 }
  const conf = { bin: '/x/claude', authMode: 'managed' as const, agentHome: '/h', modelProxy: { baseUrl: 'http://127.0.0.1:1' } }
  for (const extra of [[], ['run_code']]) {
    test(`Claude Code with team tools [${extra.join(',')}]`, () => {
      const a = buildClaudeLaunch({ ...base, extraTools: extra }, conf).args
      expect(a).toContain('--restricted')
      expect(a[a.indexOf('--tools') + 1]).toBe('WebSearch')
      expect(a[a.indexOf('--disallowedTools') + 1]!.split(',')).toEqual(expect.arrayContaining(['Bash', 'PowerShell', 'Monitor']))
      expect(a[a.indexOf('--allowedTools') + 1]!.split(',').includes('mcp__team__run_code')).toBe(extra.length > 0)
    })
  }
  test('Codex: the shell features stay off', () => {
    expect(CODEX_DISABLED_FEATURES).toEqual(expect.arrayContaining(['shell_tool', 'unified_exec', 'code_mode']))
    expect(CLAUDE_BUILTIN_DENIED).toContain('Bash')

  })
})
