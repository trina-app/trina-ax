import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildCodexLaunch, prepareCodexTurn, type CodexConf } from '../../server/src/engine/codex'
import { nativeBinDir } from '../../server/src/config'
import { SocketLauncher, startLauncher } from '../../server/src/native'
import { checkEngine, engineEnv, runCli } from '../../server/src/admin/engines'
import { LocalEngines } from '../../server/src/chat/engines'
import { createContext, startLocalCore, type AppContext } from '../../server/src/context'
import { codexCatalogFor, writeLockedCatalog } from '../../server/src/engine/codex'
import { openDb } from '../../server/src/db'
import { silentLogger } from '../../server/src/log'
import * as coreServer from '../../server/src/server'
import { testConfig } from './a-lib'
import { OpsService } from '../../server/src/system/ops'
import * as systemEngines from '../../server/src/system/engines'

// Real launcher, synthetic login only. The server-prepared home must survive until exec,
// while switching to another engine must still clear any leftover Codex login.
test('local-login Codex keeps its prepared home; the next other-engine turn clears it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-local-'))
  const bin = path.join(dir, 'engine'), sock = path.join(dir, 'l.sock')
  const agent = path.join(dir, 'agent'), chat = path.join(agent, 'chat')
  const auth = path.join(dir, 'synthetic-auth.json'), catalog = path.join(dir, 'catalog.json')
  fs.writeFileSync(auth, '{}')
  fs.writeFileSync(catalog, '{"models":[]}')
  fs.writeFileSync(bin, '#!/bin/sh\nif [ -n "$CODEX_HOME" ]; then test -L "$CODEX_HOME/auth.json" && test -f "$CODEX_HOME/catalog.json" || exit 9; else test ! -e .codex || exit 10; fi\nprintf "HOME-OK\\n"\n', { mode: 0o700 })
  const conf: CodexConf = { bin, codexHome: '', agentHome: '', catalog, model: 'fake', auth: 'dev-owner-symlink' }
  const p = await startLauncher(nativeBinDir(), { listen: sock, agentRoot: agent, toolsSock: path.join(dir, 't.sock'), allowCmds: [bin], sandbox: { profile: '', localLogin: true, localCodex: true } })
  try {
    const launcher = new SocketLauncher(sock)
    prepareCodexTurn(conf, chat, auth)
    const req = buildCodexLaunch({ turnId: 'local', chatDir: chat, token: 'test', systemPrompt: '', message: 'hello', timeoutMs: 5000 }, conf)
    for (const lr of [req, { ...req, turnId: 'other', env: { PATH: '/usr/bin:/bin' }, args: [] }]) {
      const events = []
      for await (const e of launcher.launch(lr).events) events.push(e)
      expect(events.find(e => e.ev === 'exit')).toMatchObject({ code: 0 })
      expect(events.some(e => e.ev === 'error')).toBe(false)
    }
    expect(fs.existsSync(path.join(chat, '.codex'))).toBe(false)
    expect(fs.readFileSync(auth, 'utf8')).toBe('{}')
  } finally { p.kill(); await p.exited; fs.rmSync(dir, { recursive: true, force: true }) }
}, 15000)

// Synthetic homes and executables only: never inspect the developer's login or config.
describe('Codex executable selection across diagnostics, runtime and launcher', () => {
  let dir: string
  let local: string
  let brew: string
  let claude: string
  let ctx: AppContext
  let oldPath: string | undefined
  let homeSpy: ReturnType<typeof spyOn<typeof os, 'homedir'>>
  let accessSpy: ReturnType<typeof spyOn<typeof fs, 'accessSync'>>

  function executable(file: string, version: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `#!/bin/sh\ncase "$1" in\n--version) echo '${version}';;\nlogin) echo 'Logged in using ChatGPT';;\nauth) echo '{"loggedIn":true}';;\nesac\n`, { mode: 0o700 })
    return file
  }

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cx-path-')))
    local = executable(path.join(dir, 'home/.local/bin/codex'), 'codex-cli 0.162.0-alpha.3')
    brew = executable(path.join(dir, 'opt/homebrew/bin/codex'), 'codex-cli 0.164.0')
    claude = executable(path.join(dir, 'home/.local/bin/claude'), '2.1.305 (Claude Code)')
    oldPath = process.env.PATH
    process.env.PATH = `${path.dirname(brew)}:${oldPath ?? ''}`
    homeSpy = spyOn(os, 'homedir').mockReturnValue(path.join(dir, 'home'))
    // Hide machine-specific installations without changing the filesystem. The synthetic
    // Homebrew directory is first on PATH, while .local/bin is the resolver's extra directory.
    const access = fs.accessSync
    accessSpy = spyOn(fs, 'accessSync').mockImplementation((file, mode) => {
      if (['codex', 'claude'].includes(path.basename(String(file))) && !String(file).startsWith(dir + '/')) throw new Error('fixture: not installed')
      return access(file, mode)
    })
    fs.mkdirSync(path.join(dir, 'home/.codex'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'home/.codex/models_cache.json'), JSON.stringify({ models: [{ slug: 'gpt-test' }] }))
    const config = testConfig('codex-resolution', { teamRoot: path.join(dir, 'team'), dataDir: path.join(dir, 'data') })
    ctx = createContext({ config, db: openDb(path.join(dir, 'data/app.db')), log: silentLogger })
  })

  afterEach(async () => {
    await ctx.close()
    ctx.db.close()
    accessSpy.mockRestore()
    homeSpy.mockRestore()
    if (oldPath === undefined) delete process.env.PATH
    else process.env.PATH = oldPath
    fs.rmSync(dir, { recursive: true, force: true })
  })

  async function launcherCommands() {
    // Exercise startLocalCore's actual options, without running an engine or opening a login.
    const start = spyOn(coreServer, 'startServer').mockResolvedValue({} as coreServer.Running)
    try {
      await startLocalCore(ctx)
      return start.mock.calls[0]![1]!.launcher!.allowCmds
    } finally { start.mockRestore() }
  }

  async function diagnosticBin() {
    // Inspect the real System diagnostics selection without touching any account login.
    const check = spyOn(systemEngines, 'checkEngines').mockResolvedValue([])
    try {
      await new OpsService(ctx).engines()
      return check.mock.calls[0]![0].codexBin
    } finally { check.mockRestore() }
  }

  async function selected(bin: string, version: string, status: 'ok' | 'version_unsupported') {
    const env = engineEnv(ctx)
    expect(env.codexBin).toBe(bin)
    expect(await diagnosticBin()).toBe(bin)
    expect(new LocalEngines(ctx).get().codex?.bin).toBe(bin)
    expect(await launcherCommands()).toEqual([claude, bin])
    expect(await checkEngine('codex', env, true, 'en')).toMatchObject({ installed: true, version, status })
  }

  test('PATH Homebrew cannot diagnose a supported version while runtime selects .local/bin', async () => {
    expect((await runCli(brew, ['--version'])).stdout.trim()).toBe('codex-cli 0.164.0')
    await selected(local, '0.162.0-alpha.3', 'version_unsupported')
    // Claude keeps its existing .local/bin preference too.
    expect(engineEnv(ctx).claudeBin).toBe(claude)
    expect(new LocalEngines(ctx).get().claude?.bin).toBe(claude)
    expect(await checkEngine('claude-code', engineEnv(ctx), true, 'en')).toMatchObject({ status: 'ok' })
  })

  test('a prerelease of a compatible version shows its real version and is not tested', async () => {
    executable(local, 'codex-cli 0.164.0-alpha.1')
    await selected(local, '0.164.0-alpha.1', 'version_unsupported')
  })

  test('without .local/bin all three use the executable found on PATH', async () => {
    fs.rmSync(local)
    await selected(brew, '0.164.0', 'ok')
  })

  test('an explicit executable overrides .local/bin and PATH', async () => {
    const explicit = executable(path.join(dir, 'override/codex'), 'codex-cli 0.163.0')
    ctx.config.engine.codexBin = explicit
    await selected(explicit, '0.163.0', 'ok')
  })

  test('a missing explicit executable never falls back to a supported PATH executable', async () => {
    ctx.config.engine.codexBin = path.join(dir, 'missing/codex')
    expect(engineEnv(ctx).codexBin).toBe(ctx.config.engine.codexBin)
    expect(await diagnosticBin()).toBe(ctx.config.engine.codexBin!)
    expect(new LocalEngines(ctx).get()).toMatchObject({ codex: null, problems: { codex: 'engine_missing' } })
    expect(await checkEngine('codex', engineEnv(ctx), true, 'en')).toMatchObject({ installed: false, status: 'not_installed' })
    expect(await launcherCommands()).not.toContain(brew)
  })

  for (const disabled of [false, true]) test(disabled ? 'explicit empty string disables Codex despite installed executables' : 'missing executable is reported consistently', async () => {
    if (disabled) ctx.config.engine.codexBin = ''
    else { fs.rmSync(local); fs.rmSync(brew) }
    expect(engineEnv(ctx).codexBin).toBe('')
    expect(await diagnosticBin()).toBeNull()
    expect(new LocalEngines(ctx).get()).toMatchObject({ codex: null, problems: { codex: 'engine_missing' } })
    expect(await launcherCommands()).toEqual([claude])
    expect(await checkEngine('codex', engineEnv(ctx), true, 'en')).toMatchObject({ installed: false, status: 'not_installed' })
  })

  test('production uses only its configured installer executable and locked catalog', async () => {
    ctx.config.mode = 'prod'
    ctx.config.engine.codexBin = brew
    writeLockedCatalog(path.join(dir, 'home/.codex/models_cache.json'), codexCatalogFor(brew))
    expect(engineEnv(ctx)).toMatchObject({ codexBin: brew, codexCatalogs: [codexCatalogFor(brew)] })
    expect(await diagnosticBin()).toBe(brew)
    expect(new LocalEngines(ctx).get().codex).toMatchObject({ bin: brew, auth: 'managed' })
    for (const explicit of [undefined, '', path.join(dir, 'missing/codex')]) {
      ctx.config.engine.codexBin = explicit
      expect(engineEnv(ctx).codexBin).toBe(explicit ?? '')
      expect(await diagnosticBin()).toBe(explicit ?? null)
      expect(new LocalEngines(ctx).get()).toMatchObject({ codex: null, problems: { codex: 'engine_missing' } })
      expect(await checkEngine('codex', engineEnv(ctx), true, 'en')).toMatchObject({ installed: false, status: 'not_installed' })
    }
  })
})
