// Keeps `bun run dev` running in the background as a per-user LaunchAgent (macOS), so the product stays up after the
// terminal closes and comes back after a crash or a restart of the Mac (once the user signs in).
//
//   bun run dev:service install     write ~/Library/LaunchAgents/app.team-ax.dev.plist and start it
//   bun run dev:service stop        stop it (and keep it stopped until `start`; also after a reboot)
//   bun run dev:service start       start it again
//   bun run dev:service restart     stop + start (e.g. after `git pull`)
//   bun run dev:service status      is it loaded, its pid, do the two addresses answer
//   bun run dev:service logs        the last lines of the log (~/Library/Logs/team-ax-dev/dev.log)
//   bun run dev:service uninstall   stop it and remove the plist (the data in ~/.team-ax-dev stays)
//
// The job runs `bun run dev` in this checkout with the same data folder (~/.team-ax-dev, or TEAM_AX_DEV_DIR at
// install time) and a PATH that finds bun, Node 25 (relay), Go, rg, pandoc and the claude / codex CLIs.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const LABEL = 'app.team-ax.dev'
const ROOT = path.resolve(import.meta.dir, '..')
const HOME = os.homedir()
export const PLIST = path.join(HOME, 'Library', 'LaunchAgents', `${LABEL}.plist`)
export const LOG_DIR = path.join(HOME, 'Library', 'Logs', 'team-ax-dev')
export const LOG = path.join(LOG_DIR, 'dev.log')
const DOMAIN = `gui/${process.getuid?.() ?? 501}`

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** PATH for the job: the directories of the tools the product needs, then the system ones. */
export function jobPath(env: Record<string, string | undefined> = process.env): string {
  const dirs: string[] = []
  for (const tool of ['bun', 'node', 'go', 'rg', 'pandoc', 'pdftotext', 'ffmpeg', 'claude', 'codex']) {
    const p = Bun.which(tool, { PATH: env.PATH ?? '' })
    if (p) dirs.push(path.dirname(p))
  }
  dirs.push(path.join(HOME, '.bun', 'bin'), path.join(HOME, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin')
  return [...new Set(dirs)].join(':')
}

export function plist(o: { bun: string; root: string; path: string; home: string; devDir?: string; log: string }): string {
  const env: Record<string, string> = { PATH: o.path, HOME: o.home, LANG: 'ko_KR.UTF-8', NO_COLOR: '1' }
  if (o.devDir) env.TEAM_AX_DEV_DIR = o.devDir
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(o.bun)}</string><string>run</string><string>dev</string></array>
  <key>WorkingDirectory</key><string>${xml(o.root)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env).map(([k, v]) => `    <key>${k}</key><string>${xml(v)}</string>`).join('\n')}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${xml(o.log)}</string>
  <key>StandardErrorPath</key><string>${xml(o.log)}</string>
</dict>
</plist>
`
}

function launchctl(...a: string[]) {
  const p = Bun.spawnSync(['launchctl', ...a], { stdout: 'pipe', stderr: 'pipe' })
  return { code: p.exitCode, out: (p.stdout.toString() + p.stderr.toString()).trim() }
}
const loaded = () => launchctl('print', `${DOMAIN}/${LABEL}`).code === 0

async function answers(url: string): Promise<boolean> {
  try { return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok } catch { return false }
}

async function status(): Promise<string> {
  const lines: string[] = []
  if (!fs.existsSync(PLIST)) return `not installed (run: bun run dev:service install)`
  if (!loaded()) lines.push('installed, stopped (run: bun run dev:service start)')
  else {
    const p = launchctl('print', `${DOMAIN}/${LABEL}`).out
    const pid = /\bpid = (\d+)/.exec(p)?.[1]
    lines.push(`running${pid ? ` (pid ${pid})` : ' (starting)'}`)
  }
  lines.push(`  http://localhost:19100        ${(await answers('http://localhost:19100/api/health')) ? 'answers' : 'no answer'}`)
  lines.push(`  http://demo.localhost:19161   ${(await answers('http://demo.localhost:19161/api/health')) ? 'answers' : 'no answer'}`)
  lines.push(`  log: ${LOG}`)
  return lines.join('\n')
}

function start() {
  if (loaded()) return 'already running'
  const r = launchctl('bootstrap', DOMAIN, PLIST)
  if (r.code !== 0) throw new Error(`launchctl bootstrap failed: ${r.out}`)
  return 'started'
}
function stop() {
  if (!loaded()) return 'not running'
  const r = launchctl('bootout', `${DOMAIN}/${LABEL}`)
  if (r.code !== 0) throw new Error(`launchctl bootout failed: ${r.out}`)
  return 'stopped'
}

if (import.meta.main) {
  if (process.platform !== 'darwin') { console.error('dev:service is for macOS (launchd); elsewhere run `bun run dev` under your own service manager'); process.exit(1) }
  const cmd = process.argv[2] ?? 'status'
  try {
    switch (cmd) {
      case 'install': {
        fs.mkdirSync(LOG_DIR, { recursive: true })
        fs.mkdirSync(path.dirname(PLIST), { recursive: true })
        const bun = Bun.which('bun') ?? process.execPath
        if (loaded()) stop()
        fs.writeFileSync(PLIST, plist({ bun, root: ROOT, path: jobPath(), home: HOME, devDir: process.env.TEAM_AX_DEV_DIR, log: LOG }))
        console.log(`wrote ${PLIST}`)
        console.log(start())
        break
      }
      case 'start': console.log(start()); break
      case 'stop': console.log(stop()); break
      case 'restart': stop(); await Bun.sleep(1000); console.log(start()); break
      case 'uninstall': console.log(stop()); fs.rmSync(PLIST, { force: true }); console.log(`removed ${PLIST} (data in ~/.team-ax-dev kept)`); break
      case 'logs': {
        const text = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : ''
        console.log(text.split('\n').slice(-Number(process.argv[3] ?? 60)).join('\n') || '(no log yet)')
        break
      }
      case 'status': console.log(await status()); break
      default: console.error('usage: bun run dev:service install | start | stop | restart | status | logs [n] | uninstall'); process.exit(2)
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  }
}
