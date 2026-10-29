// Real-engine setup for stage 1 tests: owner's local subscription logins (owner decision 2026-10-21).
import { requireDeveloperEngineMode } from './engine-mode'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { which } from '../../server/src/config'
import { startServer } from '../../server/src/server'
import { devEngineSandbox } from '../../server/src/context'
import { TurnRunner } from './stage1-runner'
import { writeLockedCatalog, type CodexConf } from '../../server/src/engine/codex'
import type { ClaudeConf } from '../../server/src/engine/claude'
import { makeEnv } from './env'

// Recheck even if engine-mode was previously imported before installed mode was requested.
requireDeveloperEngineMode()
export const CLAUDE_BIN = which('claude', [path.join(os.homedir(), '.local', 'bin')])!
export const CODEX_BIN = process.env.MYCEL_CODEX_BIN ?? which('codex', [path.join(os.homedir(), '.local', 'bin')])

export async function engineEnv(name: string) {
  requireDeveloperEngineMode()
  const env = makeEnv(name)
  env.db.close()
  const claude: ClaudeConf = { bin: CLAUDE_BIN, authMode: 'local-login', agentHome: path.join(env.fx.data, 'agent-home') }
  let codex: CodexConf | undefined
  if (CODEX_BIN) {
    const codexHome = path.join(env.fx.data, 'codex-home')
    const src = fs.existsSync(path.join(codexHome, 'models_cache.json')) ? path.join(codexHome, 'models_cache.json') : path.join(os.homedir(), '.codex', 'models_cache.json')
    const catalog = path.join(env.fx.data, 'codex-catalog.json')
    const models = writeLockedCatalog(src, catalog)
    codex = { bin: CODEX_BIN, codexHome, agentHome: path.join(env.fx.data, 'codex-agent-home'), catalog, model: process.env.MYCEL_CODEX_MODEL ?? models[0], auth: 'dev-owner-symlink' }
  }
  // the same OS sandbox as the dev server (macOS: engine.sb with the owner's login opened)
  const baseSandbox = devEngineSandbox()
  const sandbox = baseSandbox ? { ...baseSandbox, localCodex: !!CODEX_BIN } : undefined
  const srv = await startServer(env.cfg, { launcher: { allowCmds: [CLAUDE_BIN, ...(CODEX_BIN ? [CODEX_BIN] : [])], sessionRoots: [path.join(os.homedir(), '.claude', 'projects')], ...(sandbox ? { sandbox } : {}) } })
  const runner = new TurnRunner(srv, { claude, codex })
  return { env, srv, runner, claude, codex }
}

/** canary strings anywhere in alice-visible output or in files alice can write */
export function leakScan(team: string, texts: string[], re: RegExp) {
  const hits: string[] = texts.filter((t) => re.test(t)).map((t) => 'answer: ' + t.slice(0, 100))
  const walk = (d: string, rel: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const r = rel ? rel + '/' + e.name : e.name; const p = path.join(d, e.name)
    if (e.isDirectory() && !e.isSymbolicLink()) walk(p, r); else if (e.isFile() && /^(shared|groups\/marketing|projects\/falcon|users\/alice)\//.test(r) && !r.startsWith('groups/marketing/salaries')) {
      if (fs.lstatSync(p).nlink > 1) continue
      if (re.test(fs.readFileSync(p, 'latin1')) || re.test(fs.readFileSync(p, 'utf8'))) hits.push('file: ' + r) } } }
  walk(team, '')
  return hits
}
