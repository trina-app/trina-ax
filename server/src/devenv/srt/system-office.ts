// What the srt runner asks of an office Mac (docs/decisions/20261124-office-mac-doc-kit.md): the documents profile
// only (devenv/setting.ts documentsOnlyServer, commandMode). An office install has no sudo, so there are no dev slot accounts
// (system-mac.ts): a run is the signed-in user's own process, in a process group of its own, and srt's Seatbelt
// profile is what keeps it in (no network, the home folder and the team folder unreadable, only the chat's work folder
// writable, no process info or signals outside the sandbox, no Apple events, no launchd jobs: checked in
// tests/unit/dev-env-office.test.ts and on a real install, QA TC-8713).
//
// Limits (no cgroups on macOS): open files, file size and core files by ulimit before srt starts; memory and time by a
// watchdog here that adds up the RSS of the run's process group every second and ends the group over the limit (the
// marker files <exit>.oom and <exit>.timeout, as run-wrap-mac writes them). The exit code is the srt process's.
import { spawn as spawnChild } from 'node:child_process'
import fs from 'node:fs'
import { UNIT_RE } from './config'
import type { DocKit } from '../kit'
import type { SrtSystem, UnitInfo } from './system'

/** The argv of one run: a shell sets the limits and execs srt (its CLI with the run's settings) in place. */
export function officeArgv(kit: Pick<DocKit, 'node' | 'srtCli'>, o: { settingsFile: string; command: string }): string[] {
  return ['/bin/sh', '-c', 'ulimit -n 4096; ulimit -f 4194304; ulimit -c 0; exec "$@"', 'trina-run',
    kit.node, kit.srtCli, '--settings', o.settingsFile, '-c', o.command]
}

/** RSS (KiB) of every process in a process group (ps -g), or null when ps fails */
function groupRssKiB(pgid: number): number | null {
  const r = Bun.spawnSync(['/bin/ps', '-x', '-g', String(pgid), '-o', 'rss='], { stdout: 'pipe', stderr: 'ignore', env: { PATH: '/usr/bin:/bin', LANG: 'C' } })
  if (r.exitCode !== 0 && !r.stdout.length) return null
  return r.stdout.toString().split('\n').reduce((a, l) => a + (Number(l.trim()) || 0), 0)
}
function groupPids(pgid: number): { pid: number; command: string; seconds: number }[] {
  const r = Bun.spawnSync(['/bin/ps', '-x', '-g', String(pgid), '-o', 'pid=,etime=,command='], { stdout: 'pipe', stderr: 'ignore', env: { PATH: '/usr/bin:/bin', LANG: 'C' } })
  return r.stdout.toString().split('\n').map((l) => /^\s*(\d+)\s+(\S+)\s?(.*)$/.exec(l)).filter((m): m is RegExpExecArray => !!m).slice(0, 50)
    .map((m) => ({ pid: Number(m[1]), command: (m[3] ?? '').slice(0, 300), seconds: 0 }))
}
const killGroup = (pgid: number, sig: NodeJS.Signals) => { try { process.kill(-pgid, sig) } catch { /* gone */ } }

interface Live { pid: number; exitFile: string; oom: boolean; watch: ReturnType<typeof setInterval> }

/** The office SrtSystem: runs live only while this server process does (the documents profile has no jobs or dev
 * servers, and a server stop ends them: their process group is this server's child). */
export function officeSystem(kit: DocKit): SrtSystem {
  const live = new Map<string, Live>()
  const unitOf = (runId: string) => `trina-dev-${runId}.scope`
  return {
    spawn(s) {
      const open = (f: string) => fs.openSync(f, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, 0o640)
      const out = open(s.stdoutFile), err = s.stderrFile === s.stdoutFile ? out : open(s.stderrFile)
      try {
        for (const m of ['.oom', '.timeout']) try { fs.rmSync(s.exitFile + m, { force: true }) } catch {}
        // a process group of its own (detached), so the watchdog and stop reach every process the command starts
        const p = spawnChild(officeArgv(kit, s)[0]!, officeArgv(kit, s).slice(1), { cwd: s.cwd, env: s.env, stdio: ['ignore', out, err], detached: true })
        const pid = p.pid ?? 0
        const started = Date.now()
        const limitKiB = s.limits.memoryMiB * 1024
        const l: Live = { pid, exitFile: s.exitFile, oom: false, watch: setInterval(() => {
          const kb = groupRssKiB(pid)
          if (kb !== null && kb > limitKiB) { l.oom = true; try { fs.writeFileSync(s.exitFile + '.oom', String(kb)) } catch {} killGroup(pid, 'SIGKILL') }
          else if ((Date.now() - started) / 1000 > s.limits.runtimeMaxSec) { try { fs.writeFileSync(s.exitFile + '.timeout', String(Math.round((Date.now() - started) / 1000))) } catch {} killGroup(pid, 'SIGKILL') }
        }, 1000) }
        live.set(s.runId, l)
        const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
          p.once('exit', (code, signal) => {
            clearInterval(l.watch)
            // what the command left in its group (a `cmd &` that outlived it)
            killGroup(pid, 'SIGKILL')
            try { if (code !== null) fs.writeFileSync(s.exitFile, `${code}\n`, { mode: 0o600 }) } catch {}
            live.delete(s.runId)
            resolve({ code, signal })
          })
          p.once('error', () => { clearInterval(l.watch); live.delete(s.runId); resolve({ code: 127, signal: null }) })
        })
        return { pid, exited }
      } finally {
        fs.closeSync(out); if (err !== out) fs.closeSync(err)
      }
    },
    async stop(runId, pid) {
      const p = live.get(runId)?.pid ?? pid
      if (!p) return
      killGroup(p, 'SIGTERM')
      await Bun.sleep(2000)
      killGroup(p, 'SIGKILL')
    },
    async unit(runId): Promise<UnitInfo> {
      const l = live.get(runId)
      if (l) return { state: 'active', result: '', memoryBytes: (groupRssKiB(l.pid) ?? 0) * 1024 }
      return { state: '', result: '', memoryBytes: null }
    },
    async units() { return [...live.keys()].map(unitOf).filter((u) => UNIT_RE.test(u)) },
    async forget() {},
    oomKills(runId) { const l = live.get(runId); return l ? (l.oom ? 1 : 0) : null },
    cpuUsec() { return null },
    procs(runId) { const l = live.get(runId); return l ? groupPids(l.pid) : [] },
    async selfTest() {
      // srt starts and runs a command in its sandbox (no network, nothing readable but the system)
      for (const f of [kit.node, kit.srtCli, '/usr/bin/sandbox-exec']) if (!fs.existsSync(f)) return `${f} is missing: run the office installer again`
      const r = Bun.spawnSync([kit.node, kit.srtCli, '--version'], { stdout: 'pipe', stderr: 'pipe', env: { PATH: '/usr/bin:/bin', LANG: 'C', HOME: '/var/empty' }, timeout: 20_000 })
      return r.exitCode === 0 ? '' : `srt does not start: ${r.stderr.toString().trim().slice(0, 300)}`
    },
    forward: null,
    bridge: null,
  }
}
