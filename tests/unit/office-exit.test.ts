// The Office safety check where a file a run built leaves it (files/office-exit.ts, docs/decisions/20261124-doc-skills.md):
// a Word, PowerPoint or Excel file with a file: or \\host\share link, an embedded object or a field that runs something is
// refused, unless the file it was made from already held that same item (a company template keeps working). A run that
// writes such a file straight into a project folder or the person's own folder gets it undone (devenv/track.ts).
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { API, DEV_ENV_DEFAULT_LIMITS, uuidv7, type ProjectParticipant } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { _active, setSrtSystem } from '../../server/src/devenv/srt/runner'
import type { SpawnSpec, SrtSystem, UnitInfo } from '../../server/src/devenv/srt/system'
import type { DevEnvPlan } from '../../server/src/devenv/srt/plan'
import { newConsent, saveTeamSetting, teamSetting } from '../../server/src/devenv/setting'
import { boxShellTool, callerOf } from '../../server/src/devenv/tool'
import { officeExitRequest } from '../../server/src/files/office-links-check'
import { officeExitCheck, officeKind } from '../../server/src/files/office-exit'
import { docx, UNC } from '../lib/office-fixture'

setDefaultTimeout(120_000)
const enc = new TextEncoder()
function frame(kind: string, file: Uint8Array, earlier: Uint8Array[] = []): Uint8Array {
  const head = enc.encode(JSON.stringify({ kind, sizes: [file.length, ...earlier.map((e) => e.length)] }))
  const out = new Uint8Array(4 + head.length + file.length + earlier.reduce((n, e) => n + e.length, 0))
  new DataView(out.buffer).setUint32(0, head.length); out.set(head, 4)
  let at = 4 + head.length
  for (const p of [file, ...earlier]) { out.set(p, at); at += p.length }
  return out
}

describe('the exit check', () => {
  test('kinds by name, macro-enabled ones included', () => {
    expect(officeKind('a.DOCX')).toBe('docx'); expect(officeKind('b.xlsm')).toBe('xlsx'); expect(officeKind('c.potx')).toBe('pptx'); expect(officeKind('d.pdf')).toBeNull()
  })
  test('a new \\\\host\\share or file: link is refused; a web link passes', () => {
    expect(() => officeExitRequest(frame('docx', docx({ link: UNC })))).toThrow(/files\.example/)
    expect(() => officeExitRequest(frame('docx', docx({ link: 'file:///etc/passwd' })))).toThrow(/file:/)
    expect(officeExitRequest(frame('docx', docx({ link: 'https://example.com' })))).toBeInstanceOf(Uint8Array)
  })
  test('an edit keeps an item the earlier version already held, and only that one', () => {
    const template = docx({ link: UNC, body: 'Template' })
    expect(officeExitRequest(frame('docx', docx({ link: UNC, body: 'Filled in' }), [template]))).toBeInstanceOf(Uint8Array)
    expect(() => officeExitRequest(frame('docx', docx({ link: 'file:///tmp/other', body: 'Filled in' }), [template]))).toThrow(/file:/)
  })
  test('a damaged file is refused, also with an earlier version', () => {
    expect(() => officeExitRequest(frame('docx', enc.encode('not a zip'), [docx()]))).toThrow()
  })
  test('through the office worker, as the exits call it', async () => {
    await expect(officeExitCheck('report.docx', docx({ link: UNC }), [])).rejects.toThrow(/files\.example/)
    expect((await officeExitCheck('report.docx', docx(), [])).length).toBeGreaterThan(0)
    // not an Office file: passed through untouched
    const pdf = enc.encode('%PDF-1.7')
    expect(await officeExitCheck('a.pdf', pdf, [])).toBe(pdf)
  })
})

// ---------------- a run that writes straight into a team folder ----------------
const PLAN: DevEnvPlan = { format: 1, plan: 'team', maxRunning: 3, cpus: 1, memoryMiB: 1024, pids: 256, diskGiB: 4, network: 'open' }
const fake: SrtSystem = {
  spawn(spec: SpawnSpec) {
    const p = Bun.spawn(['bash', '-c', spec.command], { cwd: spec.cwd, env: { ...spec.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, stdout: 'pipe', stderr: 'pipe' })
    const exited = (async () => {
      const [o, e, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
      fs.writeFileSync(spec.stdoutFile, o); fs.writeFileSync(spec.stderrFile, e); fs.writeFileSync(spec.exitFile, `${code}\n`)
      return { code, signal: null }
    })()
    return { pid: p.pid, exited }
  },
  async stop() {},
  async unit(): Promise<UnitInfo> { return { state: '', result: '', memoryBytes: null } },
  async units() { return [] as string[] },
  async forget() {},
  oomKills() { return 0 }, cpuUsec() { return 0 }, procs() { return [] }, async selfTest() { return '' },
}
let h: Harness, base = '', team = '', stage = ''
const ws: Record<string, TestSocket> = {}
let P: { id: string; folderPath: string; name: string }
let projectChat = '', ownChat = ''
const abs = (rel: string) => path.join(team, ...rel.split('/'))
const out = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? '').join('\n')
function shell(o: { project?: boolean } = {}) {
  const tool = boxShellTool({ ctx: h.ctx, project: o.project ? P : null, userId: 'alice', turnId: uuidv7(), chatId: o.project ? projectChat : ownChat, signal: new AbortController().signal, redact: (s) => s,
    confirm: async () => 'run', caller: (f) => callerOf(f, {}) })
  return (command: string) => tool.call({ command, timeout_sec: 120 })
}

beforeAll(async () => {
  process.env.MYCEL_DEV_ENV = '1'
  h = await startHarness({ name: 'office-exit', askUserTimeoutMs: 4000, stallTimeoutMs: 60_000 })
  for (const u of ['alice']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'oex-'))
  stage = fs.mkdtempSync(path.join(os.tmpdir(), 'oex-in-'))
  team = h.ctx.files.fx.root
  setSrtSystem(fake, { base, id: 'mycel', plan: PLAN })
  const user = (id: string): ProjectParticipant => ({ subjectType: 'user', subjectId: id })
  const p = await h.api('dana').call(API.createProject, { body: { name: 'Office Exit', participants: [user('alice')], instructions: '' } })
  P = { id: p.id, folderPath: p.folderPath, name: p.name }
  projectChat = (await h.api('alice').call(API.createChat, { body: { projectId: P.id } })).id
  ownChat = (await h.api('alice').call(API.createChat, { body: {} })).id
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); setSrtSystem(null); delete process.env.MYCEL_DEV_ENV; await h.close(); fs.rmSync(base, { recursive: true, force: true }); fs.rmSync(stage, { recursive: true, force: true }) })
beforeEach(() => {
  _active().clear()
  setSrtSystem(fake, { base, id: 'mycel', plan: PLAN })
  h.ctx.db.query('DELETE FROM dev_env_runs').run()
  saveTeamSetting(h.ctx.db, { ...teamSetting(h.ctx.db), enabled: true, scope: { mode: 'writers', groupIds: [], userIds: [] }, network: 'open', limits: DEV_ENV_DEFAULT_LIMITS, extraDomains: [], consent: newConsent({ id: 'dana', name: 'Dana' }) })
})
const put = (name: string, b: Uint8Array) => { const f = path.join(stage, name); fs.writeFileSync(f, b); return f }

describe('a run writes an Office file straight into a team folder', () => {
  test('a project run makes a Word file with a share link: it is not kept, and the AI is told', async () => {
    await shell({ project: true })('true') // the project's baseline
    const bad = put('bad.docx', docx({ link: UNC }))
    const r = await shell({ project: true })(`cp "${bad}" report.docx`)
    expect(fs.existsSync(abs(`${P.folderPath}/report.docx`))).toBe(false)
    expect(out(r)).toContain('Office safety check refused')
    expect(out(r)).toContain('report.docx')
  })
  test('a project run edits a template that already had the link: kept; adding a new risky link puts the template back', async () => {
    const rel = `${P.folderPath}/template.docx`
    // the company's template, uploaded on the Files screen between two commands: its own link is the company's
    await h.api('alice').call(API.upload, { body: { fields: { folder: P.folderPath, name: 'template.docx', onExists: 'replace' }, file: new Blob([Buffer.from(docx({ link: UNC, body: 'Template' }))]) } } as never)
    expect(fs.existsSync(abs(rel))).toBe(true)
    await shell({ project: true })('true')
    const ok = put('ok.docx', docx({ link: UNC, body: 'Filled' }))
    await shell({ project: true })(`cp "${ok}" template.docx`)
    expect(fs.readFileSync(abs(rel))).toEqual(Buffer.from(docx({ link: UNC, body: 'Filled' })))
    const worse = put('worse.docx', docx({ link: 'file:///etc/shadow', body: 'Filled' }))
    const r = await shell({ project: true })(`cp "${worse}" template.docx`)
    expect(out(r)).toContain('the version before is back')
    expect(fs.readFileSync(abs(rel))).toEqual(Buffer.from(docx({ link: UNC, body: 'Filled' })))
  })
  test('a file a job wrote between two commands is checked at the next one', async () => {
    await shell({ project: true })('true')
    fs.writeFileSync(abs(`${P.folderPath}/by-job.docx`), docx({ link: UNC }))
    const r = await shell({ project: true })('true')
    expect(fs.existsSync(abs(`${P.folderPath}/by-job.docx`))).toBe(false)
    expect(out(r)).toContain('by-job.docx')
  })
  test('a run in the person\'s own chat writes into her own folder: refused the same way', async () => {
    fs.mkdirSync(abs('users/alice'), { recursive: true })
    await shell()('true')
    const bad = put('own.docx', docx({ link: UNC }))
    const r = await shell()(`cp "${bad}" "$TRINA_TEAM/users/alice/own.docx"`)
    expect(fs.existsSync(abs('users/alice/own.docx'))).toBe(false)
    expect(out(r)).toContain('Office safety check refused')
  })
})
