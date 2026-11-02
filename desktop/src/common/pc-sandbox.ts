// The macOS jail of a PC runner command (docs/DECISIONS.md "PC runner"). Pure: the profile text comes from the paths and
// grants of one command, and tests/unit/e-pc-sandbox.test.ts runs it under the real sandbox-exec.
//
// A command starts with nothing (deny default) and gets: the system's programs and libraries to read, the workspace to
// read and write, a sandbox home of its own (HOME, TMPDIR and the tools' caches, so `npm install` writes nothing in the
// person's home), the folders of the person's own tools to read, and the network. Everything else of the person's home
// is closed, because a list of "secret places" can never be complete: .ssh, keychains, browser profiles, Documents.
//
// The rules that matter are the ones that are not obvious:
//  - No mach service but the short list: LaunchServices (`open`), AppleEvents (`osascript`) and launchd jobs run a
//    program OUTSIDE the jail. A bare (allow default) lets a command walk out through any of them.
//  - Only IP sockets, plus DNS. A unix socket can be the Docker daemon, which is root on the machine, or an ssh agent.
//  - The secret files of the workspace (shared/src/pc-tools.ts) deny writes as well as reads: `mv .env x` and
//    `ln .env x` would otherwise give the same bytes another name.
//  - .git is closed to a command without the `login` grant, except the data plain git writes. Git runs what its control
//    files name, and those are more than config and hooks: .git/commondir points git at a config in any folder, so a
//    plain command could plant a program that the next approved `git push` runs with the person's login, or that the
//    person's own terminal runs with no jail at all (core.fsmonitor). A list of what is dangerous is what missed that.
// SBPL applies the last matching rule, so the broad allows come first and the denies after them.
import { NOT_SECRET_SOURCE, SECRET_NAME_SOURCE } from '@mycel/shared'

/** Grants a person gave for one command on the approval card; never the "this chat" allowance. */
export interface PcGrants {
  /** the person's logins: ~/.ssh, the keychain, git and CLI credentials, the ssh agent */
  login: boolean
  /** the secret files of the workspace (.env, key files) */
  secretFiles: boolean
}

/** Real paths (fs.realpath): the sandbox sees resolved paths, so /tmp or a symlinked home would match nothing. */
export interface PcSandboxPaths {
  work: string
  /** the command's HOME: per workspace, in the app's user data */
  sandboxHome: string
  /** the person's real home */
  home: string
  /** PATH folders, as resolved from the person's login shell */
  pathDirs: readonly string[]
  /** the ssh agent's socket, for the login grant */
  sshAgentSocket?: string
}

/** Read-only places every dev tool needs. */
const SYSTEM_READ = ['/usr', '/bin', '/sbin', '/opt', '/System', '/Library', '/Applications', '/nix', '/private/etc', '/private/var/db/timezone', '/private/var/db/dyld', '/private/var/select']
const SYSTEM_LITERAL = ['/', '/private', '/private/var', '/private/var/db', '/var', '/etc', '/tmp', '/dev']
/** Top-level folders of the home where people keep their tools (read only). Not a secret among them: credentials of
 * these tools live elsewhere (cargo's are closed below). */
const HOME_TOOLS = ['.nvm', '.bun', '.cargo', '.rustup', '.pyenv', '.rbenv', '.asdf', '.deno', '.volta', '.fnm', '.sdkman', '.gem', '.local/bin', '.local/share/mise', '.local/share/pnpm', '.orbstack/bin', 'go', 'Library/pnpm', 'Library/Python']
/** What a person's logins read, for the login grant. Writes stay closed: an approved `git push` changes nothing there. */
const LOGIN_READ = ['.ssh', '.gitconfig', '.git-credentials', '.config/git', '.config/gh', '.config/hub', '.config/gcloud', '.config/glab-cli', '.aws', '.azure', '.docker', '.kube', '.npmrc', '.yarnrc', '.yarnrc.yml', '.pypirc', '.netrc', '.cargo/credentials', '.cargo/credentials.toml', 'Library/Keychains']
const LOGIN_MACH = ['com.apple.SecurityServer', 'com.apple.securityd.xpc', 'com.apple.security.agent', 'com.apple.secd', 'com.apple.security.keychain-circle-notification', 'com.apple.CoreAuthentication.daemon', 'com.apple.CoreServices.coreservicesd']
/** Enough for name lookups, certificates, logs and file watchers (a dev server's reload). Nothing here starts a program. */
const MACH = ['com.apple.system.opendirectoryd.libinfo', 'com.apple.system.opendirectoryd.membership', 'com.apple.system.notification_center', 'com.apple.system.logger', 'com.apple.logd', 'com.apple.trustd', 'com.apple.trustd.agent', 'com.apple.SystemConfiguration.configd', 'com.apple.SystemConfiguration.DNSConfiguration', 'com.apple.dnssd.service', 'com.apple.bsd.dirhelper', 'com.apple.diagnosticd', 'com.apple.analyticsd', 'com.apple.cfprefsd.daemon', 'com.apple.cfprefsd.agent', 'com.apple.FontObjectsServer', 'com.apple.fonts', 'com.apple.FSEvents']

/** A value inside an SBPL string. */
export const sbString = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
/** A path inside an SBPL regex string: regex characters are literal. */
const reLiteral = (s: string): string => s.replace(/[.^$*+?()[\]{}|\\/-]/g, (c) => (c === '/' ? '/' : `\\${c}`))
const reString = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

/** "/a/b/c" -> ["/a/b", "/a", "/"]: stat() only, because realpath() and module lookup walk up from a path. */
export function ancestors(p: string): string[] {
  const out: string[] = []
  for (let i = p.lastIndexOf('/'); i > 0; i = p.lastIndexOf('/', i - 1)) out.push(p.slice(0, i))
  out.push('/')
  return out
}

const under = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`)

/**
 * The folders of the person's home that hold the programs on PATH (a version manager's folder, say), read only: the
 * folder above a "bin", else the folder itself. A PATH entry that is the home itself, or holds it, gives nothing.
 */
export function toolFolders(p: Pick<PcSandboxPaths, 'home' | 'pathDirs'>): string[] {
  const out = new Set(HOME_TOOLS.map((d) => `${p.home}/${d}`))
  for (const d of p.pathDirs) {
    if (!d.startsWith(`${p.home}/`)) continue
    const up = d.replace(/\/+$/, '').replace(/\/s?bin$/, '')
    if (up !== p.home && under(up, p.home)) out.add(up)
  }
  return [...out].sort()
}

/** The workspace's secret files, as a regular expression on the real path (the names: shared/src/pc-tools.ts). */
export const secretFileRegex = (work: string): string => `^${reLiteral(work)}/(.*/)?(${SECRET_NAME_SOURCE})$`
/** `mv .env node_modules/x` stays closed although the target would be no secret: the rename leaves a secret name. */
const secretExceptionRegex = (work: string): string => `^${reLiteral(work)}/(.*/)?(${NOT_SECRET_SOURCE})`
/** Every repository in the workspace, and the name .git itself: `mv .git g; echo evil >> g/config; mv g .git`. */
const gitFolderRegex = (work: string): string => `^${reLiteral(work)}/(.*/)?\\.git(/.*)?$`
/**
 * What plain git writes (commit, branch, merge, rebase, stash, reset, gc), and nothing it takes instructions from: the index,
 * objects, refs, logs, its state files (HEAD, MERGE_MSG, ...) and the folders of an operation under way. Not config,
 * config.worktree, commondir, hooks, info/ or worktrees/. Every name is written out, so a control file git adds later stays
 * closed. SBPL regular expressions IGNORE CASE, so a class like [A-Z]* would also match config and commondir (it did).
 */
const GIT_STATE = 'HEAD|ORIG_HEAD|FETCH_HEAD|MERGE_HEAD|MERGE_MSG|MERGE_MODE|MERGE_RR|AUTO_MERGE|CHERRY_PICK_HEAD|REVERT_HEAD|REBASE_HEAD|COMMIT_EDITMSG|SQUASH_MSG|TAG_EDITMSG|BISECT_[A-Z_]*|NOTES_MERGE_[A-Z_]*'
const GIT_DATA = String.raw`(modules/[^/]+/)*(index(\.[^/]*)?|next-index-[0-9]+\.lock|sharedindex\.[0-9a-f]+|packed-refs(\.[a-z]+)?|gc\.(pid|log)(\.lock)?|shallow(\.lock)?|(${GIT_STATE})(\.lock)?|(objects|refs|logs|rebase-merge|rebase-apply|sequencer|rr-cache|lfs)(/.*)?)$`
const gitDataRegex = (work: string): string => `^${reLiteral(work)}/(.*/)?\\.git/${GIT_DATA}`
/** Under objects/ but no data: these make git read another folder. */
const gitAlternatesRegex = (work: string): string => `^${reLiteral(work)}/(.*/)?\\.git/(modules/[^/]+/)*objects/info/(http-)?alternates$`

const paths = (kind: 'subpath' | 'literal', list: readonly string[]) => list.map((p) => `(${kind} ${sbString(p)})`).join(' ')

export function sandboxProfile(p: PcSandboxPaths, g: PcGrants): string {
  const up = [...new Set([...ancestors(p.work), ...ancestors(p.sandboxHome), ...toolFolders(p).flatMap(ancestors)])].sort()
  const lines = [
    '(version 1)',
    '(deny default)',
    '(import "system.sb")',
    // processes: the command and what it starts, nothing around it
    '(allow process-fork)',
    '(allow process-exec)',
    '(allow signal (target same-sandbox))',
    '(allow process-info* (target same-sandbox))',
    '(allow process-info-pidinfo process-info-setcontrol (target self))',
    '(allow sysctl-read)',
    '(deny sysctl-read (sysctl-name "kern.proc.all") (sysctl-name "kern.proc.pgrp") (sysctl-name "kern.proc.session") (sysctl-name "kern.proc.tty") (sysctl-name "kern.proc.uid") (sysctl-name "kern.proc.ruid") (sysctl-name "kern.proc.lcid"))',
    `(allow mach-lookup ${MACH.map((m) => `(global-name ${sbString(m)})`).join(' ')})`,
    '(allow ipc-posix-shm)',
    '(allow ipc-posix-sem)',
    '(allow user-preference-read)',
    // files: the system to read, the workspace and the sandbox home to read and write
    `(allow file-read* ${paths('literal', SYSTEM_LITERAL)} ${paths('subpath', SYSTEM_READ)})`,
    '(allow file-read* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom") (literal "/dev/tty") (literal "/dev/stdin") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/dtracehelper") (subpath "/dev/fd"))',
    '(allow file-write-data file-ioctl (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/dtracehelper") (subpath "/dev/fd"))',
    `(allow file-read-metadata ${paths('literal', up)})`,
    `(allow file-read* ${paths('subpath', toolFolders(p))})`,
    `(allow file-read* file-write* ${paths('subpath', [p.work, p.sandboxHome])})`,
    // the Xcode shims (/usr/bin/cc, python3, git) keep a lookup cache in the user temp folder, whatever TMPDIR says
    '(allow file-read* file-write* (regex "^/private/var/folders/[^/]+/[^/]+/T/xcrun_db(-[^/]*)?$"))',
    `(allow file-read* (literal ${sbString(`${p.home}/.CFUserTextEncoding`)}))`,
    // the network: ports on any address, and DNS. No unix sockets (see above)
    '(allow network-outbound (remote ip "*:*"))',
    '(allow network-bind (local ip "*:*"))',
    '(allow network-inbound (local ip "*:*"))',
    '(allow network-outbound (literal "/private/var/run/mDNSResponder"))',
    '(allow system-socket)',
    // closed again, after the allows above
    '(deny file-read* file-write* (subpath "/Library/Keychains") (subpath "/private/var/db/dslocal") (literal "/private/etc/master.passwd") (literal "/private/etc/sudoers") (subpath "/private/etc/sudoers.d"))',
    // the data of services a package manager installed (databases): programs are under /opt, their data is not for a command
    '(deny file-read* file-write* (subpath "/opt/homebrew/var") (subpath "/usr/local/var"))',
    `(deny file-read* file-write* (literal ${sbString(`${p.home}/.cargo/credentials`)}) (literal ${sbString(`${p.home}/.cargo/credentials.toml`)}))`,
  ]
  if (!g.secretFiles) {
    lines.push(`(deny file-read-data file-write* (regex ${reString(secretFileRegex(p.work))}))`)
    // names the same operations as the deny: (allow file-read* ...) does not undo a (deny file-read-data ...)
    lines.push(`(allow file-read-data file-write* (regex ${reString(secretExceptionRegex(p.work))}))`)
  }
  if (!g.login) {
    lines.push(`(deny file-write* (regex ${reString(gitFolderRegex(p.work))}))`)
    lines.push(`(allow file-write* (regex ${reString(gitDataRegex(p.work))}))`)
    lines.push(`(deny file-write* (regex ${reString(gitAlternatesRegex(p.work))}))`)
  } else {
    lines.push(`(allow file-read* ${paths('subpath', LOGIN_READ.map((d) => `${p.home}/${d}`))})`)
    lines.push(`(allow mach-lookup ${LOGIN_MACH.map((m) => `(global-name ${sbString(m)})`).join(' ')})`)
    if (p.sshAgentSocket) lines.push(`(allow network-outbound (literal ${sbString(p.sshAgentSocket)}))`)
  }
  return lines.join('\n') + '\n'
}
