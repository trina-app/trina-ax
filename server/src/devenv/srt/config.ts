// The parts of a run on srt with no side effects (docs/research/srt-dev-env.md section 2): the srt settings file, the
// environment of the run and the argv of `systemd-run --scope`. Tests check each one (tests/unit/dev-env-srt.test.ts).
import fs from 'node:fs'
import path from 'node:path'
import { DEV_ENV_DEFAULT_DOMAINS, PRODUCT, mergeSites } from '@mycel/shared'
import type { FolderView } from './access'

/** The pinned srt version. A new version goes into a new folder (scripts/dev-env/srt/install-srt.sh). */
export const SRT_VERSION = '0.0.81'
/** System paths of the install. They must be outside the base folder: the settings hide all of it. */
export const SRT_PATHS = {
  node: '/opt/trina/node/bin/node',
  cli: `/opt/trina/srt/${SRT_VERSION}/cli.js`,
  /** srt's CLI with an ask callback that allows every host: the Full internet switch of one person (srt-full.mjs). The
   * deny lists and the resolved-address check stay in force; it widens only a settings file with strictAllowlist false */
  cliFull: `/opt/trina/srt/${SRT_VERSION}/full.mjs`,
  runWrap: '/opt/trina/devenv/run-wrap',
  systemdRun: '/usr/bin/systemd-run',
  systemctl: '/usr/bin/systemctl',
} as const

/** The unit name of a run. The polkit rule allows only this pattern (scripts/dev-env/srt/devenv.rules.in). */
export const UNIT_RE = /^trina-dev-[a-z0-9]{16}\.scope$/
export const RUN_ID_RE = /^[a-z0-9]{16}$/
export const unitName = (runId: string) => `trina-dev-${runId}.scope`

/** Ids that become folder names: a user id or a chat id. Anything else is refused before a path is made. */
export const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const safeId = (id: string) => { if (!SAFE_ID_RE.test(id)) throw new Error(`not a safe id: ${id.slice(0, 80)}`); return id }

/** The folders of the dev environment under the base folder. The server owns all of them. A run is the person's, not
 * the project's: the home (caches, tool config) and the logs are per person, the work folder is per chat. */
export function devenvPaths(base: string) {
  const root = path.join(base, 'devenv')
  return {
    root,
    /** settings files and waiting commands of the runs (0600); hidden from the sandbox */
    run: path.join(root, 'run'),
    home: path.join(root, 'home'),
    logs: path.join(root, 'logs'),
    work: path.join(root, 'work'),
  }
}
/** HOME, TMPDIR and the caches of one person's runs (read and write) */
export const personHome = (base: string, userId: string) => path.join(devenvPaths(base).home, safeId(userId))
/** the logs of one person's runs (the sandbox reads them, never writes them) */
export const personLogs = (base: string, userId: string) => path.join(devenvPaths(base).logs, safeId(userId))
/** the work folder of a chat with no project (read and write); removed when the chat is purged */
export const chatWork = (base: string, chatId: string) => path.join(devenvPaths(base).work, safeId(chatId))

/** Server files outside the base folder that a run must not read. If the install adds more files outside the base,
 * they go here too (a unit test checks the list against scripts/dev-env/srt/install-srt.sh). */
export const serverFilesOutsideBase = (id: string) => [`/etc/default/${id}`]

/** Other system places that a run must not read. /tmp is the server's private /tmp (PrivateTmp). */
export const DENIED_SYSTEM_PATHS = ['/tmp', '/var/log', '/run', '/home', '/root']

/** Private, shared, link-local and unique-local ranges. srt has a built-in set too; this list is explicit. */
export const DENIED_RANGES = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '169.254.0.0/16', '127.0.0.0/8', '0.0.0.0/8', 'fc00::/7', 'fe80::/10', '::1/128']

/** Metadata names that no run may reach, with Full internet too (the addresses are in DENIED_RANGES already). */
export const DENIED_NAMES = ['metadata.google.internal']

/** Does this run use Full internet? (The settings decide: the argv then names full.mjs.) */
export const isFull = (s: { network: { strictAllowlist: boolean } }) => s.network.strictAllowlist === false

export interface SettingsInput {
  /** the base folder (/var/lib/<ID>) */
  base: string
  /** the install id (<ID>) */
  id: string
  /** the team folder (normally <base>/team); hidden too when it is outside the base folder */
  teamRoot: string
  /** the person who owns the chat */
  userId: string
  /** the folder access of this run now (access.ts folderView with the run's starting folder), team-relative */
  view: FolderView
  /** the run's starting folder, team-relative (a project folder), or null (the chat's work folder): the only team
   * folder that the run may write, besides the person's own folder (owner decision Q0 (b)) */
  start: string | null
  /** the chat's work folder (a chat with no project), else null */
  work: string | null
  network: 'open' | 'offline'
  /** the team's extra domains (devEnv.team) */
  extraDomains: readonly string[]
  /** the sites that the person allowed (always) and the sites allowed once for this run, already checked (sites.ts);
   * only with network open */
  userDomains?: readonly string[]
  /** the person's Full internet switch: every host, except the denied hosts and addresses; only with network open */
  full?: boolean
  /** host names of this Trina server and of other Trina servers */
  denyHosts: readonly string[]
  /** this VM's public IPs and other addresses to refuse */
  denyAddrs: readonly string[]
  /** server folders and files that must be hidden even when they are outside the base folder (data folder, sockets,
   * engine folders, config file, secrets, TLS key). A path inside the base folder is hidden already. */
  serverPaths?: readonly string[]
}

const abs = (teamRoot: string, rel: string) => (rel === '' ? teamRoot : path.join(teamRoot, rel))
const uniq = (a: string[]) => [...new Set(a)]

/** The srt settings file of one run. It is complete for each run: srt refuses a bad or empty file, so a bug fails
 * closed. */
export function srtSettings(i: SettingsInput) {
  const home = personHome(i.base, i.userId), logs = personLogs(i.base, i.userId)
  // the team's No network (and the plan's) wins over every site a person allowed and over Full internet
  const open = i.network === 'open'
  const domains = open ? mergeSites(DEV_ENV_DEFAULT_DOMAINS, i.extraDomains, i.userDomains ?? []) : []
  const full = open && !!i.full
  const fixedHidden = [abs(i.teamRoot, 'users'), abs(i.teamRoot, PRODUCT.systemDir)]
  // srt binds a denied folder's allowed paths back writes first, then reads: a writable folder inside a read-only one
  // (the starting folder inside a folder that Q0 (b) made read-only, for example the team root of an admin) would be
  // read-only. A denyRead landing on the writable folder itself makes srt bind it back again, writable, after the
  // read-only folder above it (srt 0.0.81 linux-sandbox-utils pushReadDenyDirMounts; Docker attack A28c).
  const writeInRead = i.view.write.filter((w) => i.view.read.some((r) => r !== w && (r === '' || w.startsWith(r + '/'))))
  return {
    filesystem: {
      // the whole base folder, not a list of its folders: a file made later in a hidden folder stays hidden
      denyRead: uniq([i.base, ...(inside(i.teamRoot, i.base) ? [] : [i.teamRoot]), ...serverFilesOutsideBase(i.id), ...DENIED_SYSTEM_PATHS,
        ...(i.serverPaths ?? []).filter((p) => !inside(p, i.base)), ...fixedHidden, ...i.view.denyRead.map((r) => abs(i.teamRoot, r)),
        ...writeInRead.map((w) => abs(i.teamRoot, w))]),
      allowRead: uniq([...i.view.read, ...i.view.write].map((r) => abs(i.teamRoot, r)).concat([home, logs], i.work ? [i.work] : [])),
      allowWrite: uniq(i.view.write.map((r) => abs(i.teamRoot, r)).concat([home], i.work ? [i.work] : [])),
      denyWrite: uniq(i.view.denyWrite.map((r) => abs(i.teamRoot, r))),
    },
    network: {
      allowedDomains: domains,
      deniedDomains: [...new Set([...i.denyHosts.map((h) => h.toLowerCase()), ...DENIED_NAMES])],
      deniedResolvedAddresses: [...new Set([...DENIED_RANGES, ...i.denyAddrs])],
      allowLocalBinding: true,
      // false only for Full internet: then srt asks its callback for a host that is not on the list, and the callback
      // of full.mjs says yes. The denied hosts and addresses are checked before it
      strictAllowlist: !full,
    },
    mandatoryDenySearchDepth: 3,
  }
}

/** Is `child` the same folder as `parent`, or inside it? */
const inside = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith('/') ? parent : parent + '/')

/** Checks that a settings file keeps the rules of the design. Returns the problems (empty = good). The runner calls it
 * before every spawn, so a bug in the builder does not reach srt. */
export function settingsProblems(s: ReturnType<typeof srtSettings>, i: Pick<SettingsInput, 'base' | 'teamRoot' | 'userId' | 'work' | 'serverPaths' | 'start'>): string[] {
  const out: string[] = []
  const deny = s.filesystem.denyRead
  const users = path.join(i.teamRoot, 'users'), own = path.join(users, i.userId), system = path.join(i.teamRoot, PRODUCT.systemDir)
  const home = personHome(i.base, i.userId), logs = personLogs(i.base, i.userId)
  if (!deny.includes(i.base)) out.push('the base folder is not hidden')
  if (!deny.some((d) => inside(i.teamRoot, d))) out.push('the team folder is not hidden')
  if (!deny.includes(users)) out.push('the personal folders are not hidden')
  if (!deny.includes(system)) out.push('the system folder is not hidden')
  // a base folder from the environment that is not the real one must not show the server's data (fail closed)
  for (const sp of i.serverPaths ?? []) if (!deny.some((d) => inside(sp, d))) out.push(`a server path is not hidden: ${sp}`)
  if (i.work !== null && !inside(i.work, devenvPaths(i.base).work)) out.push(`the work folder is not in the base folder's devenv/work: ${i.work}`)
  /** a path a run may get: a team folder (not .system, not another person's personal folder), the home, the work folder */
  const allowed = (p: string, extra: string[]) => {
    if (p === home || (i.work !== null && p === i.work) || extra.includes(p)) return true
    if (!inside(p, i.teamRoot)) return false
    if (inside(p, system)) return false
    if (inside(p, users)) return inside(p, own)
    return true
  }
  for (const w of s.filesystem.allowWrite) if (!allowed(w, [])) out.push(`a path that a run may not write: ${w}`)
  // Q0 (b): in the team folder, only the starting folder and the person's own folder are writable (a view of the
  // person, not of the run, fails here)
  const start = i.start === null || i.start === '' ? null : abs(i.teamRoot, i.start)
  for (const w of s.filesystem.allowWrite) {
    if (inside(w, i.teamRoot) && !inside(w, own) && !(start !== null && inside(w, start))) out.push(`a team folder outside the starting folder is writable: ${w}`)
  }
  for (const r of s.filesystem.allowRead) if (!allowed(r, [logs])) out.push(`a path that a run may not read: ${r}`)
  for (const sys of Object.values(SRT_PATHS)) if (inside(sys, i.base)) out.push(`${sys} is inside the base folder`)
  // the network: the private, link-local and metadata ranges are always denied, with every site list and Full internet
  const n = s.network
  for (const r of DENIED_RANGES) if (!n.deniedResolvedAddresses.includes(r)) out.push(`a denied range is missing: ${r}`)
  for (const d of DENIED_NAMES) if (!n.deniedDomains.includes(d)) out.push(`a denied name is missing: ${d}`)
  for (const a of n.allowedDomains) {
    const host = a.startsWith('*.') ? a.slice(2) : a
    if (host.includes('*') || host.includes(':') || host.includes('/') || /^[0-9.]+$/.test(host)) out.push(`an allowed site is not a host name: ${a}`)
    if (n.deniedDomains.some((d) => d === host || d.endsWith('.' + host))) out.push(`an allowed site covers a denied host: ${a}`)
  }
  return out
}

/** The real folder a run starts in: `rel` (already checked by boxCwd: no "..", not absolute) must not leave the root
 * folder (the project folder, or the chat's work folder) through a link. Null when it does, or when it is not a
 * folder. */
export function resolveRunCwd(root: string, rel: string): string | null {
  try {
    const r = fs.realpathSync(root)
    const real = fs.realpathSync(path.join(root, rel))
    if (!inside(real, r) || !fs.statSync(real).isDirectory()) return null
    return real
  } catch { return null }
}

export interface EnvInput { base: string; userId: string; teamRoot: string; work: string | null; nodeBin?: string }

/** The whole environment of a run. Nothing comes from the server's own environment (srt passes its caller's
 * environment to the command). srt adds its proxy variables. */
export function runEnv(i: EnvInput): Record<string, string> {
  const home = personHome(i.base, i.userId)
  return {
    PATH: `${path.dirname(i.nodeBin ?? SRT_PATHS.node)}:/usr/local/bin:/usr/bin:/bin`,
    HOME: home,
    // srt's own temp files (proxy sockets) land here too. A server-only TMPDIR for the srt process was tried (S7,
    // 2026-11-04, Docker suite): srt then binds that folder into the sandbox writable and the allowed-site proxy broke
    TMPDIR: path.join(home, 'tmp'),
    // srt sets TMPDIR in the sandbox to this value (else /tmp/claude, which the settings hide)
    CLAUDE_CODE_TMPDIR: path.join(home, 'tmp'),
    // node 22.21+ sends http, https and fetch through HTTPS_PROXY only with this: without it a node program (the
    // Remotion browser download, for example) has no network in srt (spike VM, 2026-11-04)
    NODE_USE_ENV_PROXY: '1',
    LANG: 'C.UTF-8',
    TERM: 'dumb',
    CI: '1',
    SHELL: '/bin/bash',
    npm_config_cache: path.join(home, '.npm'),
    PIP_CACHE_DIR: path.join(home, '.cache', 'pip'),
    PLAYWRIGHT_BROWSERS_PATH: '0',
    TRINA_LOGS: personLogs(i.base, i.userId),
    /** the team folder: team paths of the file tools are under it */
    TRINA_TEAM: i.teamRoot,
    ...(i.work ? { TRINA_WORK: i.work } : {}),
  }
}

export interface ScopeLimits { cpus: number; memoryMiB: number; pids: number; runtimeMaxSec: number }

/** The argv of one run: systemd-run makes the scope with the limits, run-wrap sets rlimits and the OOM score and
 * writes the exit code, srt runs the command. One argv, no shell. */
export function scopeArgv(o: { runId: string; id: string; limits: ScopeLimits; exitFile: string; settingsFile: string; command: string; full?: boolean }): string[] {
  const m = o.limits.memoryMiB
  return [
    SRT_PATHS.systemdRun, '--scope', '--quiet', '--no-ask-password',
    `--unit=${unitName(o.runId)}`, `--slice=${o.id}-devenv.slice`,
    // no MemoryHigh: it throttles a run near the limit for hours in place of an OOM kill (spike VM, A21)
    '-p', `MemoryMax=${m}M`, '-p', 'MemorySwapMax=0',
    '-p', `CPUQuota=${Math.round(o.limits.cpus * 100)}%`, '-p', `TasksMax=${o.limits.pids}`,
    '-p', 'OOMPolicy=kill', '-p', `RuntimeMaxSec=${o.limits.runtimeMaxSec}`,
    '--', ...wrappedArgv(o),
  ]
}

/** run-wrap and srt, also used with no systemd (MYCEL_DEV_ENV_SRT_DIRECT=1: the Docker attack test). */
export function wrappedArgv(o: { exitFile: string; settingsFile: string; command: string; full?: boolean }): string[] {
  return [SRT_PATHS.runWrap, o.exitFile, '--', SRT_PATHS.node, o.full ? SRT_PATHS.cliFull : SRT_PATHS.cli, '--settings', o.settingsFile, '-c', o.command]
}
