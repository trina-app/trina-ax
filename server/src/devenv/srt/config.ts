// The parts of a run on srt with no side effects (docs/research/srt-dev-env.md section 2): the srt settings file, the
// environment of the run and the argv of `systemd-run --scope`. Tests check each one (tests/unit/dev-env-srt.test.ts).
import path from 'node:path'
import { DEV_ENV_DEFAULT_DOMAINS } from '@mycel/shared'

/** The pinned srt version. A new version goes into a new folder (scripts/dev-env/srt/install-srt.sh). */
export const SRT_VERSION = '0.0.81'
/** System paths of the install. They must be outside the base folder: the settings hide all of it. */
export const SRT_PATHS = {
  node: '/opt/trina/node/bin/node',
  cli: `/opt/trina/srt/${SRT_VERSION}/cli.js`,
  runWrap: '/opt/trina/devenv/run-wrap',
  systemdRun: '/usr/bin/systemd-run',
  systemctl: '/usr/bin/systemctl',
} as const

/** The unit name of a run. The polkit rule allows only this pattern (scripts/dev-env/srt/devenv.rules.in). */
export const UNIT_RE = /^trina-dev-[a-z0-9]{16}\.scope$/
export const RUN_ID_RE = /^[a-z0-9]{16}$/
export const unitName = (runId: string) => `trina-dev-${runId}.scope`

/** The folders of the dev environment under the base folder. The server owns all of them. */
export function devenvPaths(base: string, projectId?: string) {
  const root = path.join(base, 'devenv')
  return {
    root,
    /** settings files of the runs (0600); hidden from the sandbox */
    run: path.join(root, 'run'),
    home: projectId ? path.join(root, 'home', projectId) : path.join(root, 'home'),
    logs: projectId ? path.join(root, 'logs', projectId) : path.join(root, 'logs'),
  }
}

/** Server files outside the base folder that a run must not read. If the install adds more files outside the base,
 * they go here too (a unit test checks the list against scripts/dev-env/srt/install-srt.sh). */
export const serverFilesOutsideBase = (id: string) => [`/etc/default/${id}`]

/** Other system places that a run must not read. /tmp is the server's private /tmp (PrivateTmp). */
export const DENIED_SYSTEM_PATHS = ['/tmp', '/var/log', '/run', '/home', '/root']

/** Private, shared, link-local and unique-local ranges. srt has a built-in set too; this list is explicit. */
export const DENIED_RANGES = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '169.254.0.0/16', '127.0.0.0/8', '0.0.0.0/8', 'fc00::/7', 'fe80::/10', '::1/128']

export interface SettingsInput {
  /** the base folder (/var/lib/<ID>) */
  base: string
  /** the install id (<ID>) */
  id: string
  projectId: string
  /** the absolute project folder */
  projectDir: string
  /** the team folder (normally <base>/team); hidden too when it is outside the base folder */
  teamRoot: string
  network: 'open' | 'offline'
  /** the team's extra domains (devEnv.team) */
  extraDomains: readonly string[]
  /** host names of this Trina server and of other Trina servers */
  denyHosts: readonly string[]
  /** this VM's public IPs and other addresses to refuse */
  denyAddrs: readonly string[]
}

/** The srt settings file of one run. It is complete for each run: srt refuses a bad or empty file, so a bug fails
 * closed. */
export function srtSettings(i: SettingsInput) {
  const p = devenvPaths(i.base, i.projectId)
  const domains = i.network === 'open' ? [...new Set([...DEV_ENV_DEFAULT_DOMAINS, ...i.extraDomains])] : []
  return {
    filesystem: {
      // the whole base folder, not a list of its folders: a file made later in a hidden folder stays hidden
      denyRead: [...new Set([i.base, ...(inside(i.teamRoot, i.base) ? [] : [i.teamRoot]), ...serverFilesOutsideBase(i.id), ...DENIED_SYSTEM_PATHS])],
      allowRead: [i.projectDir, p.home, p.logs],
      allowWrite: [i.projectDir, p.home],
      denyWrite: [] as string[],
    },
    network: {
      allowedDomains: domains,
      deniedDomains: [...new Set(i.denyHosts.map((h) => h.toLowerCase()))],
      deniedResolvedAddresses: [...new Set([...DENIED_RANGES, ...i.denyAddrs])],
      allowLocalBinding: true,
      strictAllowlist: true,
    },
    mandatoryDenySearchDepth: 3,
  }
}

/** Is `child` the same folder as `parent`, or inside it? */
const inside = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith('/') ? parent : parent + '/')

/** Checks that a settings file keeps the rules of the design. Returns the problems (empty = good). The runner calls it
 * before every spawn, so a bug in the builder does not reach srt. */
export function settingsProblems(s: ReturnType<typeof srtSettings>, i: Pick<SettingsInput, 'base' | 'projectDir' | 'teamRoot'>): string[] {
  const out: string[] = []
  if (!s.filesystem.denyRead.includes(i.base)) out.push('the base folder is not hidden')
  if (!s.filesystem.denyRead.some((d) => inside(i.teamRoot, d))) out.push('the team folder is not hidden')
  for (const w of s.filesystem.allowWrite) {
    if (w !== i.projectDir && inside(i.projectDir, w)) out.push(`a parent of the project folder is writable: ${w}`)
    if (inside(w, i.base) && !inside(w, i.teamRoot) && !inside(w, path.join(i.base, 'devenv', 'home'))) out.push(`writable path in the base folder: ${w}`)
  }
  if (!inside(i.projectDir, i.teamRoot) || i.projectDir === i.teamRoot) out.push('the project folder is not a folder of the team folder')
  for (const sys of Object.values(SRT_PATHS)) if (inside(sys, i.base)) out.push(`${sys} is inside the base folder`)
  return out
}

export interface EnvInput { base: string; projectId: string; nodeBin?: string }

/** The whole environment of a run. Nothing comes from the server's own environment (srt passes its caller's
 * environment to the command). srt adds its proxy variables. */
export function runEnv(i: EnvInput): Record<string, string> {
  const p = devenvPaths(i.base, i.projectId)
  const home = p.home
  return {
    PATH: `${path.dirname(i.nodeBin ?? SRT_PATHS.node)}:/usr/local/bin:/usr/bin:/bin`,
    HOME: home,
    TMPDIR: path.join(home, 'tmp'),
    // srt sets TMPDIR in the sandbox to this value (else /tmp/claude, which the settings hide)
    CLAUDE_CODE_TMPDIR: path.join(home, 'tmp'),
    LANG: 'C.UTF-8',
    TERM: 'dumb',
    CI: '1',
    SHELL: '/bin/bash',
    npm_config_cache: path.join(home, '.npm'),
    PIP_CACHE_DIR: path.join(home, '.cache', 'pip'),
    PLAYWRIGHT_BROWSERS_PATH: '0',
    TRINA_LOGS: p.logs,
  }
}

export interface ScopeLimits { cpus: number; memoryMiB: number; pids: number; runtimeMaxSec: number }

/** The argv of one run: systemd-run makes the scope with the limits, run-wrap sets rlimits and the OOM score and
 * writes the exit code, srt runs the command. One argv, no shell. */
export function scopeArgv(o: { runId: string; id: string; limits: ScopeLimits; exitFile: string; settingsFile: string; command: string }): string[] {
  const m = o.limits.memoryMiB
  return [
    SRT_PATHS.systemdRun, '--scope', '--quiet', '--no-ask-password',
    `--unit=${unitName(o.runId)}`, `--slice=${o.id}-devenv.slice`,
    '-p', `MemoryMax=${m}M`, '-p', `MemoryHigh=${Math.floor(m * 0.9)}M`, '-p', 'MemorySwapMax=0',
    '-p', `CPUQuota=${Math.round(o.limits.cpus * 100)}%`, '-p', `TasksMax=${o.limits.pids}`,
    '-p', 'OOMPolicy=kill', '-p', `RuntimeMaxSec=${o.limits.runtimeMaxSec}`,
    '--', ...wrappedArgv(o),
  ]
}

/** run-wrap and srt, also used with no systemd (MYCEL_DEV_ENV_SRT_DIRECT=1: the Docker attack test). */
export function wrappedArgv(o: { exitFile: string; settingsFile: string; command: string }): string[] {
  return [SRT_PATHS.runWrap, o.exitFile, '--', SRT_PATHS.node, SRT_PATHS.cli, '--settings', o.settingsFile, '-c', o.command]
}
