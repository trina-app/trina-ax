// `bun run demo:trina`: the fictional company "트리나" (scripts/demo/trina/README.md) on a development server of its own,
// seeded, with real AI from this Mac's Claude Code / Codex login (dev mode, local-login), open to phones on the same
// Wi-Fi. The viewer starts as 한지우, a new hire of the 마케팅팀, and can switch to the team lead or the CEO to ask the
// same question (demo mode, MYCEL_DEMO: docs/DECISIONS.md "Demo company: a new hire at 트리나").
//
//   bun run demo:trina [--port 19830] [--relay-port 19831] [--data ~/.trinademo] [--local]
//
// The data folder is kept between runs: starting again opens the same team (the seed only fills in what is missing).
// Start over: stop it, delete that folder (only that one), start again. --local listens on this Mac only.
// Ctrl-C stops the server, the relay and this script.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkDataDir, checkPorts } from '../../dev-checks'
import { DEMO_PASSWORD, seedDemo } from '../seed'
import { ensureOwnerPassword, TRINA, TRINA_CEO, TRINA_LEADS, TRINA_NEW_HIRE, TRINA_OWNER, TRINA_RECORDINGS, trinaDemoFile } from './company'
import { seedHistory } from './history'

const ROOT = path.resolve(import.meta.dir, '..', '..', '..')
/** said at start and in the demo bar's sheet (web i18n demo.sheet.network) */
export const NETWORK_WARNING = "anyone on any network this Mac is on (Wi-Fi, VPN, Tailscale) can use this demo with this Mac's Claude login: stop it (Ctrl-C) when the demo is over."
export const USAGE = 'Usage: bun run demo:trina [--port 19830] [--relay-port 19831] [--data <folder>] [--local] [--record]'

export interface DemoOptions { port: number; relayPort: number; home: string; local: boolean; record: boolean }

export function options(args: string[], home = os.homedir()): DemoOptions {
  const o: DemoOptions = { port: 19830, relayPort: 19831, home: path.join(home, '.trinademo'), local: false, record: false }
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!
    if (key === '--local') { o.local = true; continue }
    // recording the real answers (record.ts): no replays and no past chats, every prompt goes to the real AI
    if (key === '--record') { o.record = true; continue }
    if (!['--port', '--relay-port', '--data'].includes(key)) throw new Error(`unknown option ${key}. ${USAGE}`)
    const value = args[++i]
    if (!value) throw new Error(`${key}: a value is missing. ${USAGE}`)
    if (key === '--port') o.port = Number(value)
    else if (key === '--relay-port') o.relayPort = Number(value)
    else o.home = path.resolve(value)
  }
  for (const p of [o.port, o.relayPort]) if (!Number.isInteger(p) || p < 1024 || p > 65535) throw new Error(`choose ports from 1024 to 65535. ${USAGE}`)
  if (o.port === o.relayPort) throw new Error('the server and the relay need two different ports')
  return o
}

/** a private (home or office network) IPv4 address */
const isPrivate = (a: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a)

/** This Mac's addresses on the local network (IPv4, private ranges first): what a phone on the same Wi-Fi opens. */
export function lanAddresses(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string[] {
  const all = Object.values(ifaces).flatMap((l) => l ?? []).filter((i) => i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.')).map((i) => i.address)
  return [...new Set([...all.filter(isPrivate), ...all.filter((a) => !isPrivate(a))])]
}

/** The environment of the dev runner: nothing of another server's configuration (MYCEL_*, TEAM_AX_*) comes along;
 * the AI logins of this Mac do (dev mode runs the engines as this user). */
export function demoEnv(o: DemoOptions, demoFile: string, lan: string[], base: Record<string, string | undefined> = process.env): Record<string, string> {
  const env = Object.fromEntries(Object.entries(base).filter(([k, v]) => v !== undefined && !/^(MYCEL_|TEAM_AX_)/.test(k))) as Record<string, string>
  const origins = [`http://localhost:${o.port}`, `http://127.0.0.1:${o.port}`, `http://trina.localhost:${o.relayPort}`, ...(o.local ? [] : lan.map((a) => `http://${a}:${o.port}`))]
  return {
    ...env,
    TEAM_AX_DEV_DIR: o.home,
    TEAM_AX_DEV_PORT: String(o.port),
    TEAM_AX_DEV_RELAY_PORT: String(o.relayPort),
    MYCEL_HOST: o.local ? '127.0.0.1' : '0.0.0.0',
    MYCEL_PUBLIC_ORIGINS: origins.join(','),
    MYCEL_DEMO: demoFile,
  }
}

export async function start(args: string[]) {
  const o = options(args)
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('the demo server needs macOS or Linux')
  const problems = await checkPorts([{ port: o.port, what: 'demo server' }, { port: o.relayPort, what: 'demo relay' }])
  if (problems.length) throw new Error(problems.join('\n'))
  const checks = checkDataDir(path.join(o.home, 'data'))
  if (checks.errors.length) throw new Error(checks.errors.join('\n'))
  fs.mkdirSync(o.home, { recursive: true, mode: 0o700 })
  const demoFile = path.join(o.home, 'demo.json')
  fs.writeFileSync(demoFile, JSON.stringify(trinaDemoFile({ replays: o.record ? null : TRINA_RECORDINGS }), null, 2) + '\n', { mode: 0o600 })
  const lan = lanAddresses()
  const child = Bun.spawn([process.execPath, 'scripts/dev.ts', '--team', 'trina'], {
    cwd: ROOT, env: demoEnv(o, demoFile, lan), stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
  })
  let stopping = false
  const stop = () => { stopping = true; child.kill('SIGTERM') }
  process.on('SIGINT', stop); process.on('SIGTERM', stop)
  try {
    const baseUrl = `http://127.0.0.1:${o.port}`
    let ready = false
    for (let i = 0; i < 600 && !stopping && !ready; i++) {
      if (child.exitCode !== null) throw new Error('the development server stopped; see the lines above')
      try { ready = (await fetch(`${baseUrl}/api/setup`)).ok } catch {}
      if (!ready) await Bun.sleep(500)
    }
    if (stopping) return
    if (!ready) throw new Error('the server did not answer within five minutes')
    // a new team: the server writes the setup token a moment after it answers
    let setupToken: string | null = null
    for (let i = 0; i < 20 && !setupToken; i++) {
      try { setupToken = fs.readFileSync(path.join(o.home, 'data', 'setup-token'), 'utf8').trim() || null } catch {}
      if (!setupToken) {
        const s = await (await fetch(`${baseUrl}/api/setup`)).json() as { needed?: boolean }
        if (!s.needed) break
        await Bun.sleep(250)
      }
    }
    // the owner is not a demo person: a random password of its own, shown once and kept in the data folder (0600)
    const owner = ensureOwnerPassword(o.home)
    if (owner.created) console.log(`[trina] owner account ${TRINA_OWNER}: password ${owner.password} (shown once; kept in ${owner.file}, readable by you only)`)
    const r = await seedDemo({ baseUrl, setupToken, company: TRINA, ownerPassword: owner.password, log: (s) => console.log(`[trina] ${s}`) })
    // the demo people's past chats: their recorded real answers, replayed at once (history.ts)
    if (!o.record) {
      const h = await seedHistory({ baseUrl, dir: TRINA_RECORDINGS, log: (s) => console.log(`[trina] ${s}`) })
      if (h.made || h.failed) console.log(`[trina] past chats: ${h.made} made, ${h.kept} already there${h.failed ? `, ${h.failed} failed` : ''}`)
    }
    const name = (u: string) => TRINA.people.find((p) => p.username === u)!.name
    const urls = o.local ? [] : lan.map((a) => `[trina] ${isPrivate(a) ? 'phone:    ' : 'other:    '} http://${a}:${o.port}   (${isPrivate(a) ? 'same Wi-Fi' : 'another network this Mac is on, e.g. a VPN'})`)
    console.log([
      '',
      `[trina] ready${r.createdTeam ? ' (new team seeded)' : ''}: ${r.people.filter((p) => p.role !== 'owner').length} people and the owner account, ${r.files.length} sample files. Everything in it is fictional.`,
      `[trina] this Mac:   http://localhost:${o.port}`,
      ...urls,
      `[trina] open it and press "${name(TRINA_NEW_HIRE)} 님으로 시작하기": you are the new hire of the 마케팅팀.`,
      `[trina] the bar at the top switches to ${name(TRINA_LEADS.마케팅팀)} (팀장) or ${name(TRINA_CEO)} (대표) for the same question.`,
      `[trina] demo people: ${r.people.filter((p) => p.role !== 'owner').map((p) => p.username).join(', ')}; password ${DEMO_PASSWORD} (public). Owner ${TRINA_OWNER}: password in ${owner.file}.`,
      o.local ? '[trina] --local: only this Mac can open it.' : `[trina] ${NETWORK_WARNING}`,
      `[trina] data: ${o.home} (kept; delete only this folder to start over). Ctrl-C stops it. Runner pid ${child.pid}.`,
      '',
    ].join('\n'))
    const code = await child.exited
    if (!stopping && code !== 0) throw new Error(`the development server exited (${code})`)
  } finally {
    stop(); await child.exited
    process.off('SIGINT', stop); process.off('SIGTERM', stop)
  }
}

if (import.meta.main) start(process.argv.slice(2)).catch((e) => { console.error(`[trina] ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1 })
