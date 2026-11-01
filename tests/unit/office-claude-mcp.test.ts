// Office test O3 (0.2.19): with this Mac's own Claude login the office server empties the MCP settings of the Mac
// user's ~/.claude.json at every start and after every AI turn (engine/claude-json-guard.ts, security round 4). On a
// Mac its owner also used for Claude Code that silently deleted their MCP servers, and --check-only did not say so.
// Now: a copy of everything removed is saved first (config/claude-mcp-backups, 700/600), `teamax claude-mcp check`
// and office-install.sh list what would go, a new install stops without --remove-claude-mcp, switching back from the
// setup-token mode asks the same, and `teamax claude-mcp restore` puts a copy back. Fake homes only: the real
// ~/.claude.json is never opened.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import {
  claudeMcpBackupDir, findClaudeJsonMcp, guardClaudeJsonFamilyKeep, guardOfficeClaudeJson, listMcpBackups, saveMcpBackup, type McpBackup,
} from '../../server/src/engine/claude-json-guard'
import { claudeMcpCommand, FOUND, mergeBackup } from '../../server/src/office/claude-mcp'
import { configure } from '../../server/src/office/cli'
import { officePaths } from '../../server/src/office/settings'
import { openDb } from '../../server/src/db'
import { silentLogger } from '../../server/src/log'
import { WORK } from '../lib/env'

const BASE = path.join(WORK, 'office-claude-mcp')
const REPO = path.resolve(import.meta.dir, '..', '..')
const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'))
const mode = (f: string) => fs.statSync(f).mode & 0o777

/** what the test Mac had: 2 user MCP servers and MCP settings in 4 projects, next to the login state */
const config = () => ({
  numStartups: 9, oauthAccount: { emailAddress: 'owner@example.com' }, userID: 'u-1',
  mcpServers: { github: { type: 'stdio', command: 'npx', args: ['-y', 'gh-mcp'], env: { GITHUB_TOKEN: 'canary-token' } }, notes: { type: 'http', url: 'https://mcp.example.com/notes' } },
  projects: {
    '/Users/owner/app': { allowedTools: ['Read'], hasTrustDialogAccepted: true, mcpServers: { db: { command: 'db-mcp', args: ['--ro'] } } },
    '/Users/owner/web': { enabledMcpjsonServers: ['browser', 'lint'] },
    '/Users/owner/ops': { enableAllProjectMcpServers: true },
    '/Users/owner/site': { mcpServers: { cms: { command: 'cms-mcp' } }, enabledMcpjsonServers: ['x'] },
    '/Users/owner/empty': { mcpServers: {}, enabledMcpjsonServers: [], enableAllProjectMcpServers: false },
  },
})

let n = 0
/** a fresh fake Mac home with that config, and an office installation folder next to it */
function fakeMac(cfg: Record<string, unknown> | null = config()) {
  const base = path.join(BASE, `m${++n}`)
  fs.rmSync(base, { recursive: true, force: true })
  const home = path.join(base, 'home'), inst = path.join(home, 'TeamAX')
  fs.mkdirSync(path.join(home, '.claude', 'backups'), { recursive: true })
  if (cfg) fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify(cfg), { mode: 0o600 })
  return { base, home, inst, file: path.join(home, '.claude.json'), env: { ...process.env, HOME: home, TEAMAX_AGENTS_DIR: path.join(home, 'Library', 'LaunchAgents') } }
}
const officeCtx = (inst: string, db: ReturnType<typeof openDb>, authMode = 'local-login') =>
  ({ config: { office: true, dataDir: path.join(inst, 'data'), teamRoot: path.join(inst, 'team'), engine: { authMode } } as any, db, log: silentLogger })

beforeAll(() => { fs.rmSync(BASE, { recursive: true, force: true }); fs.mkdirSync(BASE, { recursive: true }) })
afterAll(() => fs.rmSync(BASE, { recursive: true, force: true }))

describe('the server keeps a copy of what it removes', () => {
  test('at a start: the copy holds exactly the removed values (secrets too), owner-only, outside the Claude files; the audit names it', () => {
    const m = fakeMac()
    fs.writeFileSync(path.join(m.home, '.claude', 'backups', '.claude.json.backup.1792575626838'), JSON.stringify(config()))
    const db = openDb(path.join(m.base, 'app.db'))
    try {
      const ctx = officeCtx(m.inst, db)
      const removed = guardOfficeClaudeJson(ctx, 'start', m.home)
      expect(removed).toContain('.claude.json: mcpServers')
      expect(removed).toContain('.claude.json: projects["/Users/owner/ops"].enableAllProjectMcpServers')
      // the config itself: MCP emptied, the login state and everything else as it was
      const j = read(m.file)
      expect(j.mcpServers).toEqual({})
      expect(j.projects['/Users/owner/app']).toEqual({ allowedTools: ['Read'], hasTrustDialogAccepted: true, mcpServers: {} })
      expect(j.oauthAccount).toEqual({ emailAddress: 'owner@example.com' })
      // the copy: <installation>/config/claude-mcp-backups, 700 / 600
      const dir = claudeMcpBackupDir(ctx)
      expect(dir).toBe(path.join(m.inst, 'config', 'claude-mcp-backups'))
      const [copy, ...more] = listMcpBackups(dir)
      expect(more).toEqual([])
      expect(path.basename(copy!)).toMatch(/^claude-mcp-\d{4}-\d\d-\d\dT[\d-]+Z-start\.json$/)
      expect(mode(dir)).toBe(0o700)
      expect(mode(copy!)).toBe(0o600)
      const b = read(copy!) as McpBackup
      expect(b.when).toBe('start')
      expect(b.home).toBe(m.home)
      expect(Object.keys(b.files).sort()).toEqual(['.claude.json', '.claude/backups/.claude.json.backup.1792575626838'])
      const c = config()
      expect(b.files['.claude.json']).toEqual([
        { project: null, key: 'mcpServers', value: c.mcpServers },
        { project: '/Users/owner/app', key: 'mcpServers', value: c.projects['/Users/owner/app'].mcpServers },
        { project: '/Users/owner/web', key: 'enabledMcpjsonServers', value: ['browser', 'lint'] },
        { project: '/Users/owner/ops', key: 'enableAllProjectMcpServers', value: true },
        { project: '/Users/owner/site', key: 'mcpServers', value: { cms: { command: 'cms-mcp' } } },
        { project: '/Users/owner/site', key: 'enabledMcpjsonServers', value: ['x'] },
      ])
      const row = db.query("SELECT detail FROM audit_log WHERE action = 'engine.claude_json_mcp_removed'").get() as { detail: string }
      expect(JSON.parse(row.detail)).toMatchObject({ when: 'start', backup: path.basename(copy!) })
      expect(row.detail).not.toContain('canary-token') // the values stay in the owner-only copy, not in the audit list
      // nothing left: no new copy, the file is not rewritten
      const before = fs.statSync(m.file).mtimeMs
      expect(guardOfficeClaudeJson(ctx, 'turn', m.home)).toEqual([])
      expect(listMcpBackups(dir)).toHaveLength(1)
      expect(fs.statSync(m.file).mtimeMs).toBe(before)
    } finally { db.close() }
  })

  test('a link at ~/.claude.json: the copy holds what it pointed to, which is not changed; the setup-token mode keeps no copy and changes nothing', () => {
    const m = fakeMac(null)
    const target = path.join(m.home, 'dotfiles', 'claude.json')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, JSON.stringify(config()))
    fs.symlinkSync(target, m.file)
    const db = openDb(path.join(m.base, 'app.db'))
    try {
      expect(guardOfficeClaudeJson(officeCtx(m.inst, db, 'subscription'), 'start', m.home)).toEqual([])
      expect(fs.lstatSync(m.file).isSymbolicLink()).toBe(true)
      expect(listMcpBackups(path.join(m.inst, 'config', 'claude-mcp-backups'))).toEqual([])
      const removed = guardOfficeClaudeJson(officeCtx(m.inst, db), 'start', m.home)
      expect(removed[0]).toBe('.claude.json: (link replaced)')
      expect(read(target).mcpServers.github).toBeDefined()
      const [copy] = listMcpBackups(path.join(m.inst, 'config', 'claude-mcp-backups'))
      expect((read(copy!) as McpBackup).files['.claude.json']![0]).toEqual({ project: null, key: 'mcpServers', value: config().mcpServers })
    } finally { db.close() }
  })

  test('a copy that cannot be saved does not keep a planted server (the guard is a security boundary); it is logged', () => {
    const m = fakeMac()
    const elsewhere = path.join(m.base, 'elsewhere')
    fs.mkdirSync(elsewhere)
    fs.mkdirSync(path.join(m.inst, 'config'), { recursive: true })
    fs.symlinkSync(elsewhere, path.join(m.inst, 'config', 'claude-mcp-backups'))
    const r = guardClaudeJsonFamilyKeep(m.home, { backupDir: path.join(m.inst, 'config', 'claude-mcp-backups'), when: 'turn' })
    expect(r.backup).toBeNull()
    expect(r.backupError).toMatch(/is not a folder/)
    expect(read(m.file).mcpServers).toEqual({})
    expect(fs.readdirSync(elsewhere)).toEqual([]) // never written through the link
    const errors: unknown[] = []
    const log = { ...silentLogger, error: (msg: string, o?: unknown) => { errors.push([msg, o]) } }
    fs.writeFileSync(m.file, JSON.stringify(config()))
    const db = openDb(path.join(m.base, 'app.db'))
    try {
      expect(guardOfficeClaudeJson({ ...officeCtx(m.inst, db), log: log as any }, 'turn', m.home).length).toBeGreaterThan(0)
      expect(JSON.stringify(errors)).toContain('could not save a copy')
    } finally { db.close() }
  })

  test('copies after AI turns are kept up to 20 (the newest); copies from a start are never removed; very large values keep only their names', () => {
    const m = fakeMac(null)
    const dir = path.join(m.inst, 'config', 'claude-mcp-backups')
    const plan = [{ file: m.file, taken: [{ project: null, key: 'mcpServers' as const, value: { s: { command: 'x' } } }] }]
    const t0 = Date.parse('2026-11-01T00:00:00Z')
    saveMcpBackup(dir, m.home, plan, 'start', new Date(t0))
    for (let i = 1; i <= 25; i++) saveMcpBackup(dir, m.home, plan, 'turn', new Date(t0 + i * 1000))
    const names = listMcpBackups(dir).map((f) => path.basename(f))
    expect(names.filter((x) => x.endsWith('-start.json'))).toHaveLength(1)
    expect(names.filter((x) => /-turn(-\d+)?\.json$/.test(x))).toHaveLength(20)
    expect(names).not.toContain('claude-mcp-2026-11-01T00-00-01-000Z-turn.json') // the oldest turn copies went
    // the same moment twice: a second file, never over the first
    const a = saveMcpBackup(dir, m.home, plan, 'start', new Date(t0)), b = saveMcpBackup(dir, m.home, plan, 'start', new Date(t0))
    expect(a).not.toBe(b)
    expect(fs.readdirSync(dir).filter((x) => x.startsWith('.tmp'))).toEqual([])
    const huge = { project: null, key: 'mcpServers' as const, value: { big: { command: 'x', args: ['y'.repeat(5 * 1024 * 1024)] }, b2: {} } }
    const c = read(saveMcpBackup(dir, m.home, [{ file: m.file, taken: [huge] }], 'start')) as McpBackup
    expect(c.files['.claude.json']![0]).toMatchObject({ project: null, key: 'mcpServers', names: ['big', 'b2'] })
    expect('value' in c.files['.claude.json']![0]!).toBe(false)
  })
})

describe('what would be removed: read only', () => {
  test('findClaudeJsonMcp changes nothing (the file, a link, a link in place of the backups folder)', () => {
    const m = fakeMac()
    const linkTarget = path.join(m.home, 'old-backups')
    fs.mkdirSync(linkTarget)
    fs.rmSync(path.join(m.home, '.claude', 'backups'), { recursive: true })
    fs.symlinkSync(linkTarget, path.join(m.home, '.claude', 'backups'))
    const before = fs.readFileSync(m.file, 'utf8'), mtime = fs.statSync(m.file).mtimeMs
    const r = findClaudeJsonMcp(m.home)
    expect(r.backupsLink).toBe(true)
    expect(r.findings.map((f) => f.file)).toEqual(['.claude.json'])
    expect(r.findings[0]!.entries).toHaveLength(6)
    expect(fs.readFileSync(m.file, 'utf8')).toBe(before)
    expect(fs.statSync(m.file).mtimeMs).toBe(mtime)
    expect(fs.lstatSync(path.join(m.home, '.claude', 'backups')).isSymbolicLink()).toBe(true)
  })

  test('teamax claude-mcp check: names and counts, exit 3; nothing: exit 0', () => {
    const m = fakeMac()
    fs.writeFileSync(path.join(m.home, '.claude.json.backup'), JSON.stringify(config()))
    const out: string[] = []
    expect(claudeMcpCommand(m.inst, ['check'], m.env, (s) => out.push(s))).toBe(FOUND)
    const text = out.join('\n')
    expect(out[0]).toContain('2 user MCP servers, MCP settings of 4 projects; the same kind of settings in 1 older copy the Claude CLI keeps')
    expect(text).toContain('~/.claude.json: user scope: 2 MCP servers (github, notes)')
    expect(text).toContain('~/.claude.json: project /Users/owner/web: approved .mcp.json servers (browser, lint)')
    expect(text).toContain('~/.claude.json: project /Users/owner/ops: every .mcp.json server approved')
    expect(text).toContain('~/.claude.json.backup (an older copy the Claude CLI keeps): 6 MCP settings')
    expect(text).not.toContain('canary-token') // names only
    expect(text).not.toContain('/Users/owner/empty') // the CLI's own empty values are not a finding
    const one: string[] = []
    expect(claudeMcpCommand(m.inst, ['check', '--summary'], m.env, (s) => one.push(s))).toBe(FOUND)
    expect(one).toHaveLength(1)
    const clean = fakeMac({ numStartups: 1, mcpServers: {} })
    expect(claudeMcpCommand(clean.inst, ['check'], clean.env, () => {})).toBe(0)
    expect(claudeMcpCommand(fakeMac(null).inst, ['check'], fakeMac(null).env, () => {})).toBe(0)
  })
})

describe('teamax claude-mcp restore', () => {
  /** a copy made by the guard itself */
  function guarded(when: 'start' | 'turn' = 'start') {
    const m = fakeMac()
    const r = guardClaudeJsonFamilyKeep(m.home, { backupDir: path.join(m.inst, 'config', 'claude-mcp-backups'), when })
    return { ...m, copy: r.backup! }
  }

  test('puts the settings back without replacing anything there; again: nothing to do', () => {
    const m = guarded()
    const j = read(m.file)
    j.mcpServers = { github: { command: 'my-new-github' } } // added since: kept
    j.projects['/Users/owner/web'].enabledMcpjsonServers = ['lint', 'other']
    fs.writeFileSync(m.file, JSON.stringify(j))
    fs.chmodSync(m.file, 0o640)
    const out: string[] = []
    expect(claudeMcpCommand(m.inst, ['restore', m.copy], m.env, (s) => out.push(s))).toBe(0)
    const k = read(m.file)
    expect(k.mcpServers).toEqual({ github: { command: 'my-new-github' }, notes: config().mcpServers.notes })
    expect(k.projects['/Users/owner/app'].mcpServers).toEqual({ db: { command: 'db-mcp', args: ['--ro'] } })
    expect(k.projects['/Users/owner/app'].allowedTools).toEqual(['Read'])
    expect(k.projects['/Users/owner/web'].enabledMcpjsonServers).toEqual(['lint', 'other', 'browser'])
    expect(k.projects['/Users/owner/ops'].enableAllProjectMcpServers).toBe(true)
    expect(k.oauthAccount).toEqual({ emailAddress: 'owner@example.com' })
    expect(mode(m.file)).toBe(0o640)
    expect(out.join('\n')).toContain('user scope: MCP server notes (https://mcp.example.com/notes)')
    expect(out.join('\n')).not.toContain('MCP server github')
    const again: string[] = []
    expect(claudeMcpCommand(m.inst, ['restore', m.copy], m.env, (s) => again.push(s))).toBe(0)
    expect(again[0]).toMatch(/^nothing to put back/)
  })

  test('refused while this installation removes them (local-login with its agent); a copy made after an AI turn needs --yes', () => {
    const m = guarded()
    fs.mkdirSync(officePaths(m.inst, m.env).agentsDir, { recursive: true })
    fs.writeFileSync(officePaths(m.inst, m.env).plist('app.team-ax.office'), '<plist/>')
    expect(() => claudeMcpCommand(m.inst, ['restore', m.copy], m.env, () => {})).toThrow(/nothing was put back: .*would remove them again/)
    expect(read(m.file).mcpServers).toEqual({})
    // the setup-token mode: the server no longer touches the file
    fs.mkdirSync(path.join(m.inst, 'config'), { recursive: true })
    fs.writeFileSync(path.join(m.inst, 'config', 'office.env'), 'TEAMAX_CLAUDE_AUTH=subscription\n')
    expect(claudeMcpCommand(m.inst, ['restore', m.copy], m.env, () => {})).toBe(0)
    expect(Object.keys(read(m.file).mcpServers)).toEqual(['github', 'notes'])
    const t = guarded('turn')
    const out: string[] = []
    expect(claudeMcpCommand(t.inst, ['restore', t.copy], t.env, (s) => out.push(s))).toBe(1)
    expect(out[0]).toContain('saved after an AI turn')
    expect(out.join('\n')).toContain('MCP server github (npx -y gh-mcp)')
    expect(read(t.file).mcpServers).toEqual({})
    expect(claudeMcpCommand(t.inst, ['restore', t.copy, '--yes'], t.env, () => {})).toBe(0)
    expect(Object.keys(read(t.file).mcpServers)).toEqual(['github', 'notes'])
  })

  test('a config that is not JSON is left alone; a missing one is created 600', () => {
    const m = guarded()
    fs.writeFileSync(m.file, 'not json{')
    expect(() => claudeMcpCommand(m.inst, ['restore', m.copy], m.env, () => {})).toThrow(/cannot be read as a Claude config/)
    expect(fs.readFileSync(m.file, 'utf8')).toBe('not json{')
    fs.rmSync(m.file)
    expect(claudeMcpCommand(m.inst, ['restore', m.copy], m.env, () => {})).toBe(0)
    expect(mode(m.file)).toBe(0o600)
    expect(read(m.file).projects['/Users/owner/site']).toEqual({ mcpServers: { cms: { command: 'cms-mcp' } }, enabledMcpjsonServers: ['x'] })
  })

  test('mergeBackup skips values left out of a copy', () => {
    const cfg: Record<string, unknown> = {}
    expect(mergeBackup(cfg, [{ project: null, key: 'mcpServers', names: ['big'], omitted: 'too large' }])).toEqual([])
    expect(cfg).toEqual({})
  })
})

describe('switching back to this Mac\'s login asks first', () => {
  test('configure --claude-auth local-login from the setup-token mode: refused while ~/.claude.json has MCP settings, unless --remove-claude-mcp', () => {
    const m = fakeMac()
    const token = path.join(m.base, 'token.txt')
    fs.writeFileSync(token, 'sk-ant-oat01-' + 'A'.repeat(95) + '\n')
    configure(m.inst, ['--claude-token-file', token, '--run-dir', '/tmp/tx-o3c'], m.env)
    expect(() => configure(m.inst, ['--claude-auth', 'local-login'], m.env)).toThrow(/MCP settings this server removes.*--remove-claude-mcp/)
    expect(fs.readFileSync(officePaths(m.inst, m.env).env, 'utf8')).toContain('TEAMAX_CLAUDE_AUTH=subscription')
    expect(configure(m.inst, ['--claude-auth', 'local-login', '--remove-claude-mcp'], m.env).claudeAuth).toBe('local-login')
    // already local-login (every later configure run, the installer's): no question
    expect(configure(m.inst, ['--lan-port', '18443'], m.env).claudeAuth).toBe('local-login')
    expect(read(m.file).mcpServers.github).toBeDefined() // configure itself never changes the file
  })
})

describe('office-install.sh lists them and a new install stops', () => {
  const B = path.join(BASE, 'bundle')
  const prefixOf = (m: ReturnType<typeof fakeMac>) => path.join(m.base, 'inst')
  beforeAll(() => {
    fs.mkdirSync(path.join(B, 'app', 'bin', 'darwin-arm64'), { recursive: true })
    fs.mkdirSync(path.join(B, 'app', 'server', 'src'), { recursive: true })
    fs.writeFileSync(path.join(B, 'app', 'VERSION'), '9.9.9\n')
    fs.symlinkSync(process.execPath, path.join(B, 'app', 'bin', 'darwin-arm64', 'bun'))
    // never a real LaunchAgent from this test: `install` (and any launchctl) only says it was called
    fs.writeFileSync(path.join(B, 'app', 'server', 'src', 'office.js'), `if (process.argv[2] === 'install') { console.log('FAKE-INSTALL'); process.exit(0) }\nconst { main } = await import(${JSON.stringify(path.join(REPO, 'server', 'src', 'office', 'cli.ts'))}); process.exit(await main(process.argv.slice(2)))\n`)
    fs.copyFileSync(path.join(REPO, 'scripts', 'office', 'office-install.sh'), path.join(B, 'office-install.sh'))
    fs.mkdirSync(path.join(BASE, 'fakebin'), { recursive: true })
    fs.writeFileSync(path.join(BASE, 'fakebin', 'launchctl'), '#!/bin/sh\necho "FAKE-LAUNCHCTL $*"\nexit 1\n', { mode: 0o755 })
    fs.writeFileSync(path.join(BASE, 'claude'), `#!/bin/sh\n[ "$1 $2" = "auth status" ] && echo '{ "loggedIn": true }'\nexit 0\n`, { mode: 0o755 })
  })
  const run = (m: ReturnType<typeof fakeMac>, args: string[]) => {
    const p = Bun.spawnSync(['bash', path.join(B, 'office-install.sh'), '--prefix', prefixOf(m), '--lan-port', '18463', '--app-port', '18450', '--label', 'app.team-ax.office-o3test', '--run-dir', '/tmp/tx-o3', '--no-desktop', ...args], {
      stdout: 'pipe', stderr: 'pipe',
      env: { PATH: `${path.join(BASE, 'fakebin')}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: m.home, TEAMAX_AGENTS_DIR: path.join(m.home, 'Library', 'LaunchAgents'), TEAMAX_TEST_UNAME: 'Darwin', TEAMAX_TEST_OSVERSION: '15.1', TEAMAX_TEST_ARCH: 'arm64', TEAMAX_CLAUDE_BIN: path.join(BASE, 'claude') },
    })
    return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() }
  }

  test('check-only: lists them, says how to keep them, exits non-zero; nothing is changed', () => {
    const m = fakeMac()
    const before = fs.readFileSync(m.file, 'utf8')
    const r = run(m, ['--check-only'])
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('2 user MCP servers, MCP settings of 4 projects')
    expect(r.out).toContain('~/.claude.json: project /Users/owner/app: 1 MCP server (db)')
    expect(r.out).toContain('check only: nothing changed')
    expect(r.out).toContain('the install would stop at the MCP settings above')
    expect(r.out).toContain('--claude-token-file')
    expect(r.out).toContain('--remove-claude-mcp')
    expect(fs.readFileSync(m.file, 'utf8')).toBe(before)
    expect(fs.existsSync(prefixOf(m))).toBe(false)
  })

  test('install: stops before anything is written; with --remove-claude-mcp check-only goes through', () => {
    const m = fakeMac()
    const r = run(m, [])
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('stopped; nothing was changed')
    expect(r.out).not.toContain('FAKE-')
    expect(fs.existsSync(prefixOf(m))).toBe(false)
    expect(read(m.file).mcpServers.github).toBeDefined()
    const ok = run(m, ['--check-only', '--remove-claude-mcp'])
    expect(ok.code).toBe(0)
    expect(ok.out).toContain(`--remove-claude-mcp: the server removes them when it starts; a copy goes to ${path.join(prefixOf(m), 'config', 'claude-mcp-backups')} first`)
    expect(read(m.file).mcpServers.github).toBeDefined()
  })

  test('no question: nothing there, the setup-token mode, an installation that already removes them, the automatic update', () => {
    const clean = fakeMac({ numStartups: 2 })
    const c = run(clean, ['--check-only'])
    expect(c.code).toBe(0)
    expect(c.out).not.toContain('MCP settings')
    const m = fakeMac()
    const token = path.join(m.base, 'token.txt')
    fs.writeFileSync(token, 'sk-ant-oat01-' + 'B'.repeat(95) + '\n')
    const sub = run(m, ['--check-only', '--claude-token-file', token])
    expect(sub.code).toBe(0)
    expect(sub.out).not.toContain('MCP settings')
    // an installation made before this version (it already removes them): goes on, says a copy is kept from now on
    fs.mkdirSync(path.join(prefixOf(m), 'config'), { recursive: true })
    fs.writeFileSync(path.join(prefixOf(m), 'config', 'office.env'), 'TEAMAX_LABEL=app.team-ax.office-o3test\n')
    const again = run(m, ['--check-only'])
    expect(again.code).toBe(0)
    expect(again.out).toContain('2 user MCP servers')
    expect(again.out).toContain('already removes them; from 9.9.9 on it first keeps a copy')
    const up = run(m, ['--check-only', '--update'])
    expect(up.code).toBe(0)
    expect(up.out).toContain('the server keeps a copy of what it removes in')
    expect(read(m.file).mcpServers.github).toBeDefined()
  })
})
