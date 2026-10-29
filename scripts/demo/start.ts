// Isolated, foreground, model-free evaluator walkthrough. Never reuses a team directory.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkDataDir, checkPorts } from '../dev-checks'
import { seedDemo } from './seed'

export function options(args: string[]) {
  let port = 19760, data: string | undefined, locale: 'en' | 'ko' = 'en'
  for (let i = 0; i < args.length; i++) {
    const key = args[i], value = args[++i]
    if (!value) throw new Error(`Missing value for ${key}`)
    if (key === '--port') port = Number(value)
    else if (key === '--data') data = path.resolve(value)
    else if (key === '--locale' && (value === 'en' || value === 'ko')) locale = value
    else throw new Error('Usage: bun run demo [--port N] [--data NEW_DIRECTORY] [--locale en|ko]')
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Choose a port from 1024 to 65535')
  return { port, data, locale }
}

export async function start(args: string[]) {
  const o = options(args)
  const problems = await checkPorts([{ port: o.port, what: 'local demo' }])
  if (problems.length) throw new Error(problems.join('\n'))
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('The source demo needs macOS or Linux.')
  // A new directory, even for a repeat run: no existing database can be seeded or overwritten.
  const home = o.data ?? path.join(os.homedir(), `.trina-demo-${Date.now()}`)
  const checks = checkDataDir(path.join(home, 'data'))
  if (checks.errors.length) throw new Error(checks.errors.join('\n'))
  fs.mkdirSync(home, { mode: 0o700 }) // deliberately not recursive; EEXIST is a refusal
  const config = path.join(home, 'demo.json')
  fs.writeFileSync(config, JSON.stringify({
    mode: 'dev', listen: { host: '127.0.0.1', port: o.port },
    engine: { authMode: 'local-login', claudeBin: '/nonexistent/trina-demo-no-ai', codexBin: '' },
    relay: { url: null, officialAvailable: false }, update: { feedUrl: null, auto: false },
  }), { mode: 0o600 })
  // Do not inherit a production config, alternate data directory or provider credentials.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !/^(MYCEL_|TEAM_AX_|ANTHROPIC_|OPENAI_|CLAUDE_|CODEX_)/.test(k))) as Record<string, string>
  Object.assign(env, { MYCEL_CONFIG: config, MYCEL_HOST: '127.0.0.1', MYCEL_LOG_LEVEL: 'error', TEAM_AX_DEV_DIR: home, TEAM_AX_DEV_PORT: String(o.port), NO_COLOR: '1' })
  const child = Bun.spawn([process.execPath, 'scripts/dev.ts', '--no-relay'], { cwd: path.resolve(import.meta.dir, '../..'), env, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' })
  let stopping = false
  const stop = () => { stopping = true; child.kill('SIGTERM') }
  process.on('SIGINT', stop); process.on('SIGTERM', stop)
  try {
    const baseUrl = `http://127.0.0.1:${o.port}`
    let ready = false
    for (let i = 0; i < 600 && !stopping; i++) {
      if (child.exitCode !== null) throw new Error('Development server stopped; inspect the build error above.')
      try { ready = (await fetch(`${baseUrl}/api/setup`)).ok } catch {}
      if (ready && fs.existsSync(path.join(home, 'data/setup-token'))) break
      await Bun.sleep(500)
    }
    if (stopping) return
    if (!ready) throw new Error('Server did not become ready within five minutes.')
    const setupToken = fs.readFileSync(path.join(home, 'data/setup-token'), 'utf8').trim()
    await seedDemo({ baseUrl, setupToken, locale: o.locale })
    const examples = path.resolve(import.meta.dir, '../../examples')
    const extra = path.join(home, 'seed-examples')
    fs.cpSync(path.join(examples, 'skills'), path.join(extra, 'skills'), { recursive: true })
    fs.cpSync(path.join(examples, 'data'), path.join(extra, 'shared/demo'), { recursive: true })
    await seedDemo({ baseUrl, setupToken: null, locale: o.locale, filesDir: extra })
    console.log(`\n[demo] Ready: ${baseUrl}\n[demo] Fictional accounts: alice, bob, admin1, dion; public demo password: teamax-demo-1\n[demo] Files → shared → 팀-용어집.md is your first result. Compare alice and bob in separate browsers.\n[demo] AI is disabled. This is not a production install. Ctrl-C stops the server.\n[demo] Retained demo directory: ${home}; delete only this directory after stopping.\n[demo] Supervisor PID: ${child.pid}`)
    const code = await child.exited
    if (!stopping && code !== 0) throw new Error(`Demo server exited (${code})`)
  } finally {
    stop(); await child.exited
    process.off('SIGINT', stop); process.off('SIGTERM', stop)
  }
}
if (import.meta.main) start(process.argv.slice(2)).catch(e => { console.error(`[demo] ${e.message}`); process.exitCode = 1 })
