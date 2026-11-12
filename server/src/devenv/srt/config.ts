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
  /** macOS (a Mac team server): srt's CLI with the localhost rules of the run's own port (srt-mac.mjs). It runs
   * full.mjs, so it is also the Full internet CLI there */
  cliMac: `/opt/trina/srt/${SRT_VERSION}/mac.mjs`,
  /** macOS: the first program of a run, as a dev slot account (scripts/dev-env/srt/run-wrap-mac) */
  runWrapMac: '/opt/trina/devenv/run-wrap-mac',
  sudo: '/usr/bin/sudo',
} as const

/** The platform of the dev environment: Linux (bubblewrap, systemd scopes) or macOS (Seatbelt, dev slot accounts). */
export type DevPlatform = 'linux' | 'darwin'
export const devPlatform = (p: string = process.platform): DevPlatform => (p === 'darwin' ? 'darwin' : 'linux')

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

/** What a run reads on the host besides its own folders (QA TC-306: an allow-list, not a deny list). Programs and
 * libraries (/usr; /bin, /lib, /lib64 and /sbin point into it on Debian 13), the system configuration (/etc, less
 * ETC_SECRETS) and Trina's tools (/opt/trina: node, python, srt, the headless browser). A path that is not there is
 * skipped by srt. */
export const SYSTEM_READ_PATHS = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc', '/opt/trina']

/** Places in /etc that hold host secrets or service settings, often world-readable (a tunnel token in a unit file, a
 * share password in fstab, a hosted image's link token). Whole folders and files, not paths inside them: srt hides a
 * path it cannot look at by the nearest parent it can, and a path that is not there costs nothing. */
export const ETC_SECRETS = ['/etc/systemd', '/etc/cloudflared', '/etc/ssh', '/etc/polkit-1', '/etc/sudoers.d',
  '/etc/letsencrypt', '/etc/ssl/private', '/etc/wireguard', '/etc/NetworkManager', '/etc/docker',
  '/etc/default', '/etc/environment', '/etc/fstab', '/etc/crypttab', '/etc/netplan', '/etc/cron.d', '/etc/crontab',
  '/etc/openvpn', '/etc/ipsec.d', '/etc/ipsec.secrets', '/etc/pki', '/etc/samba', '/etc/rclone', '/etc/davfs2',
  '/etc/apt/auth.conf', '/etc/apt/auth.conf.d', '/etc/msmtprc', '/etc/postfix', '/etc/mysql', '/etc/ax', '/etc/cloud',
  '/etc/machine-id']

/** Hidden in every run. `/` hides the whole host: srt expands it into the root's children (not /proc, /dev, /sys) and
 * skips the ones SYSTEM_READ_PATHS gives back. srt lists the root when a run starts: a folder made at the top during a
 * run (a new mount) is visible to that run and hidden from the next one. The rest
 * name what must stay hidden even if `/` were dropped: /tmp is the server's private /tmp (PrivateTmp); /mnt, /media and
 * /srv hold the sources of connected folders (team-files/connected.ts LINUX_ROOTS), which a run sees only through
 * connected/<name> and its folder rules; /opt and /var/lib hold other apps' files. */
export const DENIED_SYSTEM_PATHS = ['/', '/tmp', '/var/log', '/var/lib', '/run', '/home', '/root', '/mnt', '/media', '/srv', '/opt',
  ...ETC_SECRETS]

/** macOS (docs/DECISIONS.md "Dev environment on a Mac team server"): what a run reads on the host besides its own
 * folders. Programs and libraries (/usr, /bin, /sbin, /System, the dyld cache), the time zones, xcrun's link to the
 * developer tools (/private/var/select) and the Command Line Tools (git, python3, make: without them those are stubs
 * that only ask to install them), Homebrew's programs when the Mac has them, and Trina's tools (/opt/trina: node,
 * srt). The links /etc, /var and /tmp can be followed (srt-mac.mjs); in /private/etc only the files below. */
export const MAC_SYSTEM_READ_PATHS = ['/usr', '/bin', '/sbin', '/System', '/Library/Apple', '/Library/Developer/CommandLineTools',
  '/private/var/db/timezone', '/private/var/db/dyld', '/private/var/select', '/opt/homebrew', '/opt/trina',
  ...['hosts', 'resolv.conf', 'services', 'protocols', 'passwd', 'group', 'shells', 'localtime', 'ssl', 'profile', 'bashrc',
    'zshrc', 'zprofile', 'paths', 'paths.d', 'gitconfig'].map((f) => `/private/etc/${f}`)]

/** macOS: places in /private/etc with host secrets or settings. None of them is in MAC_SYSTEM_READ_PATHS (a unit test
 * checks it); the list is for settingsProblems, which refuses a run that would read one. */
export const MAC_ETC_SECRETS = ['/private/etc/sudoers', '/private/etc/sudoers.d', '/private/etc/ssh', '/private/etc/master.passwd',
  '/private/etc/kcpassword', '/private/etc/pf.conf', '/private/etc/pf.anchors', '/private/etc/newsyslog.d', '/private/etc/cups',
  '/private/etc/racoon', '/private/etc/ppp', '/private/etc/apache2', '/private/etc/postfix', '/private/etc/openldap']

/** macOS: hidden in every run. `/` hides the whole Mac; the rest name what must stay hidden even if `/` were dropped: the
 * people's homes, other disks and network shares (/Volumes, /Network: connected folders), /Library (the install's base
 * folder, the server's logs, other apps' data), the temp folders, /private/var (logs, the server's own temp folder
 * under /private/var/folders), /private/etc (only the files above come back), /opt and /Applications. */
export const MAC_DENIED_SYSTEM_PATHS = ['/', '/Users', '/Volumes', '/Network', '/Library', '/Applications', '/opt', '/tmp', '/private/tmp',
  '/var', '/private/var', '/etc', '/private/etc', '/cores']

/** The host lists of one platform. */
export function hostLists(p: DevPlatform) {
  return p === 'darwin'
    ? { read: MAC_SYSTEM_READ_PATHS, denied: MAC_DENIED_SYSTEM_PATHS, etcSecrets: MAC_ETC_SECRETS }
    : { read: SYSTEM_READ_PATHS, denied: DENIED_SYSTEM_PATHS, etcSecrets: ETC_SECRETS }
}

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
  /** the source folders of the team's connected folders (a NAS mount, for example): a run reads only the mirror in
   * connected/<name>, with its folder rules, never the source. A source goes into denyRead only when nothing there
   * hides it already (on Linux they are under /mnt, /media or /srv): srt looks at every denyRead path when a run starts,
   * and a hung network mount would stall every run */
  connectedSources?: readonly string[]
  /** linux (default: this machine) or darwin: the host lists, and on macOS no open localhost (allowLocalBinding false;
   * srt-mac.mjs adds the run's own port) */
  platform?: DevPlatform
}

const abs = (teamRoot: string, rel: string) => (rel === '' ? teamRoot : path.join(teamRoot, rel))
const uniq = (a: string[]) => [...new Set(a)]

/** The srt settings file of one run. It is complete for each run: srt refuses a bad or empty file, so a bug fails
 * closed. */
export function srtSettings(i: SettingsInput) {
  const home = personHome(i.base, i.userId), logs = personLogs(i.base, i.userId)
  const platform = i.platform ?? devPlatform()
  const host = hostLists(platform)
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
  // the whole base folder, not a list of its folders: a file made later in a hidden folder stays hidden
  const deny = uniq([i.base, ...(inside(i.teamRoot, i.base) ? [] : [i.teamRoot]), ...(platform === 'linux' ? serverFilesOutsideBase(i.id) : []), ...host.denied,
    ...(i.serverPaths ?? []).filter((p) => !inside(p, i.base)), ...fixedHidden, ...i.view.denyRead.map((r) => abs(i.teamRoot, r)),
    ...writeInRead.map((w) => abs(i.teamRoot, w))])
  const allowRead = uniq([...i.view.read, ...i.view.write].map((r) => abs(i.teamRoot, r)).concat([home, logs], i.work ? [i.work] : [], host.read))
  return {
    filesystem: {
      denyRead: uniq(deny.concat((i.connectedSources ?? []).filter((src) => !hiddenBy(deny, allowRead, src)))),
      allowRead,
      allowWrite: uniq(i.view.write.map((r) => abs(i.teamRoot, r)).concat([home], i.work ? [i.work] : [])),
      denyWrite: uniq(i.view.denyWrite.map((r) => abs(i.teamRoot, r))),
    },
    network: {
      allowedDomains: domains,
      deniedDomains: [...new Set([...i.denyHosts.map((h) => h.toLowerCase()), ...DENIED_NAMES])],
      deniedResolvedAddresses: [...new Set([...DENIED_RANGES, ...i.denyAddrs])],
      // Linux: the run has a network namespace of its own, so its localhost is its own. macOS: one localhost for the
      // whole Mac (the server's ports, other runs): srt allows only its proxy, srt-mac.mjs adds the run's own port
      allowLocalBinding: platform === 'linux',
      // false only for Full internet: then srt asks its callback for a host that is not on the list, and the callback
      // of full.mjs says yes. The denied hosts and addresses are checked before it
      strictAllowlist: !full,
    },
    mandatoryDenySearchDepth: 3,
  }
}

/** Is `child` the same folder as `parent`, or inside it? */
const inside = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith('/') ? parent : parent + '/')

/** Is `p` hidden in a run with these settings? srt gives an allowRead path back inside a denied folder (allowRead wins
 * over denyRead, a tie too), so the deepest entry at or above `p` decides. */
function hiddenBy(denyRead: readonly string[], allowRead: readonly string[], p: string): boolean {
  const depth = (list: readonly string[]) => Math.max(-1, ...list.filter((e) => inside(p, e)).map((e) => (e === '/' ? 0 : e.split('/').length - 1)))
  return depth(denyRead) > depth(allowRead)
}
const hidden = (s: ReturnType<typeof srtSettings>, p: string) => hiddenBy(s.filesystem.denyRead, s.filesystem.allowRead, p)

/** Checks that a settings file keeps the rules of the design. Returns the problems (empty = good). The runner calls it
 * before every spawn, so a bug in the builder does not reach srt. */
export function settingsProblems(s: ReturnType<typeof srtSettings>, i: Pick<SettingsInput, 'base' | 'teamRoot' | 'userId' | 'work' | 'serverPaths' | 'start' | 'connectedSources' | 'platform'>): string[] {
  const out: string[] = []
  const platform = i.platform ?? devPlatform()
  const host = hostLists(platform)
  const deny = s.filesystem.denyRead
  const users = path.join(i.teamRoot, 'users'), own = path.join(users, i.userId), system = path.join(i.teamRoot, PRODUCT.systemDir)
  const home = personHome(i.base, i.userId), logs = personLogs(i.base, i.userId)
  if (!deny.includes(i.base)) out.push('the base folder is not hidden')
  if (!deny.some((d) => inside(i.teamRoot, d))) out.push('the team folder is not hidden')
  if (!deny.includes(users)) out.push('the personal folders are not hidden')
  if (!deny.includes(system)) out.push('the system folder is not hidden')
  // a base folder from the environment that is not the real one must not show the server's data (fail closed)
  for (const sp of i.serverPaths ?? []) if (!hidden(s, sp)) out.push(`a server path is not hidden: ${sp}`)
  // the host: everything outside the allowed paths is hidden, the connected sources too (QA TC-306)
  for (const d of host.denied) if (!deny.includes(d)) out.push(`a host path is not hidden: ${d}`)
  for (const d of host.denied) if (d !== '/' && !hidden(s, d)) out.push(`a host path is given back: ${d}`)
  for (const src of i.connectedSources ?? []) {
    if (!hidden(s, src)) out.push(`a connected folder's source is not hidden: ${src}`)
    for (const r of s.filesystem.allowRead) if (inside(r, src)) out.push(`a path in a connected folder's source is readable: ${r}`)
  }
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
  for (const r of s.filesystem.allowRead) if (!allowed(r, [logs, ...host.read])) out.push(`a path that a run may not read: ${r}`)
  // a host secret in /etc must not be given back
  for (const r of s.filesystem.allowRead) if (host.etcSecrets.some((e) => inside(r, e))) out.push(`a host secret is readable: ${r}`)
  for (const sys of Object.values(SRT_PATHS)) if (inside(sys, i.base)) out.push(`${sys} is inside the base folder`)
  // the network: the private, link-local and metadata ranges are always denied, with every site list and Full internet
  const n = s.network
  // macOS: localhost is the whole Mac's (the server's ports, other runs' dev servers)
  if (platform === 'darwin' && n.allowLocalBinding !== false) out.push('localhost is open (allowLocalBinding must be false on macOS)')
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

export interface EnvInput { base: string; userId: string; teamRoot: string; work: string | null; nodeBin?: string; platform?: DevPlatform }

/** The whole environment of a run. Nothing comes from the server's own environment (srt passes its caller's
 * environment to the command). srt adds its proxy variables. */
export function runEnv(i: EnvInput): Record<string, string> {
  const home = personHome(i.base, i.userId)
  const mac = (i.platform ?? devPlatform()) === 'darwin'
  const node = path.dirname(i.nodeBin ?? SRT_PATHS.node)
  return {
    // macOS: Homebrew's programs when the Mac has them (MAC_SYSTEM_READ_PATHS); /usr/local is not readable there
    PATH: mac ? `${node}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin` : `${node}:/usr/local/bin:/usr/bin:/bin`,
    HOME: home,
    // srt's own temp files (proxy sockets) land here too. A server-only TMPDIR for the srt process was tried (S7,
    // 2026-11-04, Docker suite): srt then binds that folder into the sandbox writable and the allowed-site proxy broke
    TMPDIR: path.join(home, 'tmp'),
    // srt sets TMPDIR in the sandbox to this value (else /tmp/claude, which the settings hide)
    CLAUDE_CODE_TMPDIR: path.join(home, 'tmp'),
    // node 22.21+ sends http, https and fetch through HTTPS_PROXY only with this: without it a node program (the
    // Remotion browser download, for example) has no network in srt (spike VM, 2026-11-04)
    NODE_USE_ENV_PROXY: '1',
    LANG: mac ? 'en_US.UTF-8' : 'C.UTF-8',
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

/** macOS: the argv of one run (docs/DECISIONS.md "Dev environment on a Mac team server"). sudo switches to the run's
 * dev slot account (the sudoers rule names only run-wrap-mac and the slot accounts) and sets the run's environment
 * (the SETENV tag; sudo would reset it). run-wrap-mac sets the limits, starts the RAM watchdog and writes the exit
 * code; srt-mac.mjs runs srt with the run's own port. One argv, no shell. */
export function macArgv(o: { account: string; env: Record<string, string>; limits: ScopeLimits; poolMiB: number; exitFile: string; settingsFile: string; command: string }): string[] {
  if (!SLOT_ACCOUNT_RE.test(o.account)) throw new Error(`not a dev slot account: ${o.account.slice(0, 40)}`)
  const env = Object.entries(o.env).map(([k, v]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || v.includes('\0')) throw new Error(`bad environment variable ${k.slice(0, 40)}`)
    return `${k}=${v}`
  })
  return [SRT_PATHS.sudo, '-n', '-u', o.account, ...env, SRT_PATHS.runWrapMac, 'run', o.exitFile, String(o.limits.memoryMiB), String(o.limits.pids),
    String(o.limits.runtimeMaxSec), String(o.poolMiB), '--', SRT_PATHS.node, SRT_PATHS.cliMac, '--settings', o.settingsFile, '-c', o.command]
}
/** A dev slot account: a role account with a number (run-wrap-mac refuses any other: its kill -1 hits every process of
 * the account it runs as). */
export const SLOT_ACCOUNT_RE = /^_[a-z][a-z0-9]{0,30}dev[0-9]{1,2}$/
