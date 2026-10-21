// `teamax update …` (docs/OFFICE.md "자동 업데이트") and the update LaunchAgent's own entry (`update run`).
//
//   teamax update [status]          version, channel, next night window, last check / update
//   teamax update check             look at the feed now (installs nothing)
//   teamax update now [--inline]    install the newest version now (through the agent; --inline runs it here)
//   teamax update pause | resume    automatic updates off / on (the web's "자동 업데이트 끄기" is the same)
//   teamax update channel stable|beta
//   teamax update time HH:MM        the nightly time (default 03:00, this Mac's local time)
//   teamax update run               what the agent runs (nightly, or a request from `now` / the web)
import fs from 'node:fs'
import { launchAgent } from '../../../scripts/dev-service'
import { CHANNELS, type Channel } from './release'
import { loadSettings, officePaths, type OfficeSettings } from './settings'
import {
  readUpdateSettings, readUpdateState, requestUpdate, runUpdate, takeRequest, updateLabel, updatePaths, updatePlist, updateView,
  writeUpdateSettings, type OfficeUpdateView, type RunResult,
} from './update'

const uid = () => process.getuid?.() ?? 0

/** Install or refresh the update agent (office.js install). Not while an update run uses it (TEAMAX_UPDATE_RUN): the
 * plist file is then only rewritten, launchd reads it at the next login. */
export function syncUpdateAgent(s: OfficeSettings, envPath: string, env: Record<string, string | undefined> = process.env): string {
  const p = officePaths(s.home)
  const label = updateLabel(s)
  const file = p.plist(label)
  const text = updatePlist(s, readUpdateSettings(s.home).time, envPath)
  const ua = launchAgent(label, file)
  let before = ''
  try { before = fs.readFileSync(file, 'utf8') } catch {}
  fs.mkdirSync(p.agentsDir, { recursive: true })
  fs.mkdirSync(p.logs, { recursive: true, mode: 0o750 })
  if (env.TEAMAX_UPDATE_RUN === '1' || readUpdateState(s.home).running) {
    // launchd keeps the job it loaded: the supervisor reloads it once the update is over (reloadMarkedUpdateAgent)
    if (before !== text) { fs.writeFileSync(file, text, { mode: 0o644 }); fs.writeFileSync(reloadMarker(s.home), '', { mode: 0o600 }) }
    return ''
  }
  if (before === text && ua.loaded()) return ''
  if (ua.loaded()) ua.stop()
  fs.writeFileSync(file, text, { mode: 0o644 })
  ua.start()
  const t = readUpdateSettings(s.home)
  return `자동 업데이트 / automatic updates (${label}): 매일 / every night ${t.time}, ${t.channel}${t.paused ? ', 꺼짐 / paused' : ''}`
}

const reloadMarker = (home: string) => `${updatePaths(home).dir}/agent-reload`

/** The supervisor (office.js run, every 30 s): an update rewrote the update agent's plist while that agent was running
 * it; once no update runs, load the new one (bootout + bootstrap). */
export function reloadMarkedUpdateAgent(s: OfficeSettings): string {
  const m = reloadMarker(s.home)
  if (!fs.existsSync(m) || readUpdateState(s.home).running) return ''
  const label = updateLabel(s)
  const ua = launchAgent(label, officePaths(s.home).plist(label))
  fs.rmSync(m, { force: true })
  if (!fs.existsSync(officePaths(s.home).plist(label))) return ''
  if (ua.loaded()) ua.stop()
  ua.start()
  return `update agent reloaded (${label})`
}

export function removeUpdateAgent(s: OfficeSettings): string {
  const label = updateLabel(s)
  const file = officePaths(s.home).plist(label)
  const ua = launchAgent(label, file)
  const was = ua.loaded() || fs.existsSync(file)
  if (ua.loaded()) ua.stop()
  fs.rmSync(file, { force: true })
  return was ? `update agent: removed` : ''
}

const local = (iso: string | null) => (iso ? new Date(iso).toLocaleString('ko-KR', { hour12: false }) : '-')

export function viewText(v: OfficeUpdateView): string {
  const lines = [
    `현재 버전 / installed   ${v.current}`,
    `채널 / channel          ${v.channel}`,
    `자동 업데이트 / auto    ${!v.agentInstalled ? '설치 안 됨 / agent not installed (office-install.sh)' : v.paused ? '꺼짐 / paused (teamax update resume)' : `매일 / every night ${v.time} (다음 / next ${local(v.nextWindowAt)})`}`,
    `마지막 확인 / checked   ${local(v.lastCheckAt)}${v.last ? `  → ${v.last.kind}${v.last.version ? ` ${v.last.version}` : ''}${v.last.message ? ` (${v.last.message})` : ''}` : ''}`,
  ]
  if (v.available) lines.push(`새 버전 / available     ${v.available.version} (${v.available.channel})`)
  if (v.lastUpdate) lines.push(`마지막 업데이트 / last  ${v.lastUpdate.from} → ${v.lastUpdate.to} ${v.lastUpdate.result} ${local(v.lastUpdate.at)}${v.lastUpdate.error ? ` (${v.lastUpdate.error})` : ''}`)
  if (v.desktop) lines.push(`윈도우 앱 / Windows app ${v.desktop.version} (data/downloads, ${local(v.desktop.at)})`)
  if (v.running) lines.push(`진행 중 / running       ${v.running.phase}`)
  else if (v.requested) lines.push('요청됨 / requested     곧 시작합니다 / starting')
  return lines.join('\n')
}

const resultText = (r: RunResult) => `${r.kind}${r.version ? ` ${r.version}` : ''}${r.message ? `: ${r.message}` : ''}`

/** follow an agent run until it is done (the Terminal can be closed: the agent keeps going) */
async function follow(home: string, startedAt: number, maxMs = 45 * 60_000): Promise<number> {
  let last = ''
  const end = Date.now() + maxMs
  while (Date.now() < end) {
    await Bun.sleep(1500)
    const st = readUpdateState(home)
    const requested = fs.existsSync(updatePaths(home).request)
    if (st.running && st.running.phase !== last) { last = st.running.phase; console.log(`  … ${last}`) }
    if (!st.running && !requested && st.last && Date.parse(st.last.at) >= startedAt) {
      console.log(resultText(st.last))
      return ['failed', 'rolled-back', 'refused'].includes(st.last.kind) ? 1 : 0
    }
  }
  console.log(`still running; see ${updatePaths(home).log} or teamax update status`)
  return 0
}

export async function updateCommand(home: string, args: string[], envPath: string): Promise<number> {
  const rest = args.filter((a, i) => !(a === '--home' || args[i - 1] === '--home'))
  const [sub = 'status', val] = rest
  const s = loadSettings(home)
  switch (sub) {
    case 'run': {
      const req = takeRequest(home)
      await runUpdate(home, { reason: req ? 'now' : 'schedule' })
      return 0
    }
    case 'status':
      console.log(viewText(updateView(home)))
      return 0
    case 'check': {
      const r = await runUpdate(home, { reason: 'check' })
      console.log(resultText(r))
      return r.kind === 'failed' || r.kind === 'refused' ? 1 : 0
    }
    case 'now': {
      const ua = launchAgent(updateLabel(s), officePaths(home).plist(updateLabel(s)))
      if (rest.includes('--inline') || !ua.loaded()) {
        if (!rest.includes('--inline')) console.log('(update agent not installed: running here; do not close this window)')
        const r = await runUpdate(home, { reason: 'now' })
        console.log(resultText(r))
        return ['failed', 'rolled-back', 'refused'].includes(r.kind) ? 1 : 0
      }
      const started = Date.now()
      requestUpdate(home, 'teamax update now')
      const k = Bun.spawnSync(['launchctl', 'kickstart', `gui/${uid()}/${updateLabel(s)}`], { stdout: 'pipe', stderr: 'pipe' })
      if (k.exitCode !== 0 && !readUpdateState(home).running) console.log(`launchctl kickstart: ${(k.stdout.toString() + k.stderr.toString()).trim()}`)
      console.log(`업데이트를 시작했습니다 / update started (${updateLabel(s)}; log ${updatePaths(home).log}). 이 창을 닫아도 계속됩니다 / closing this window does not stop it.`)
      return await follow(home, started)
    }
    case 'pause':
    case 'resume': {
      writeUpdateSettings(home, { paused: sub === 'pause' })
      console.log(sub === 'pause' ? '자동 업데이트를 껐습니다 / automatic updates off (teamax update resume)' : '자동 업데이트를 켰습니다 / automatic updates on')
      console.log(viewText(updateView(home)))
      return 0
    }
    case 'channel': {
      if (!CHANNELS.includes(val as Channel)) { console.error('usage: teamax update channel stable|beta'); return 2 }
      writeUpdateSettings(home, { channel: val as Channel })
      console.log(`채널 / channel: ${val}`)
      return 0
    }
    case 'time': {
      if (!val || !/^([01]\d|2[0-3]):[0-5]\d$/.test(val)) { console.error('usage: teamax update time HH:MM (e.g. 03:00)'); return 2 }
      writeUpdateSettings(home, { time: val })
      const line = syncUpdateAgent(s, envPath)
      if (line) console.log(line)
      console.log(viewText(updateView(home)))
      return 0
    }
    case 'feed': {
      // tests only: a feed on this Mac (http://127.0.0.1:<port>); `default` goes back to https://updates.treesoop.com
      if (!val) { console.error('usage: teamax update feed http://127.0.0.1:<port> | default'); return 2 }
      if (val === 'default') { const cur = readUpdateSettings(home); delete cur.feed; fs.writeFileSync(updatePaths(home).settings, JSON.stringify(cur, null, 1) + '\n', { mode: 0o600 }); return 0 }
      if (!/^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/.test(val)) { console.error('only a feed on this Mac (http://127.0.0.1:<port>) can replace the default'); return 2 }
      writeUpdateSettings(home, { feed: val })
      return 0
    }
    default:
      console.error('usage: teamax update [status] | check | now [--inline] | pause | resume | channel stable|beta | time HH:MM')
      return 2
  }
}
