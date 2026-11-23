// Dev environment on srt: attack suite (docs/research/srt-dev-env.md 10.2). Runs INSIDE the Docker image of
// tests/linux/Dockerfile.srt as root: it makes a team server's folders with canary strings in every place a run must
// not see, then runs each attack as the server account through the same pieces as the runner (folderView from the
// folder rules of one person, srtSettings, runEnv, resolveRunCwd, run-wrap, srt), with no systemd scope. A run has the
// folder access of the person who owns the chat: it must see her folders, write only where she writes, and see nothing
// of the folders she may not open, of other people's personal folders, logs and homes, or of the server. An attack
// passes when no canary comes back and its check holds. Lines that need systemd and polkit (A17, A21-A23, A25, A26)
// and chromium (A24) run on the spike VM.
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { RuleSet, type Access, type Principal } from '../../server/src/policy/access'
import { folderView, sharedFolderView, sharedPathAccess } from '../../server/src/devenv/srt/access'
import { gitWrapperSource } from '../../server/src/devenv/srt/git-guard'
import { writeBoxBrowser } from '../../server/src/devenv/srt/box-browser'
import { othersLive, sweepRoots, visibleOf, type Visible } from '../../server/src/devenv/srt/hook-sweep'
import { entryGuard, entryPins, hideDeniedNames, lockFolders, makeGuardDir, writePins } from '../../server/src/devenv/srt/mounts'
import { holdPlaceholders, isRunPlaceholder, SRT_DENY_DIRS, SRT_DENY_FILES } from '../../server/src/devenv/srt/placeholders'
import { SRT_PATHS, boxBrowser, runGuard, chatHome, chatLogs, chatWork, devenvPaths, projectHome, isFull, personHome, personLogs, resolveRunCwd, runEnv, runHome, runLogs, runTmp, sharedLogs, sharedWork, sharedWorkKey, srtSettings, settingsProblems, wrappedArgv } from '../../server/src/devenv/srt/config'
import { ruleWorld, type RuleRow } from '../lib/rule-world'

const ID = 'mycel'
const BASE = `/var/lib/${ID}`
const TEAM = `${BASE}/team`
const DIR1 = `${TEAM}/projects/one`
const WORK = chatWork(BASE, 'chat-1')
const SRV = 'axserver'
const CANARY = 'CANARY-7f3a'
const ME = 'alice'

function sh(cmd: string) { const r = Bun.spawnSync(['bash', '-c', cmd]); if (r.exitCode !== 0) throw new Error(`${cmd}: ${r.stderr.toString()}`) }

// ---- the team server's folders (as install-linux.sh and the server make them) ----
for (const d of ['data', 'secrets', 'config', 'agent/codex-auth', 'root', 'run/tools', 'devenv/run']) fs.mkdirSync(path.join(BASE, d), { recursive: true })
const w = (rel: string, text: string) => { const f = path.join(TEAM, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text) }
fs.writeFileSync(`${BASE}/data/app.db`, `${CANARY}-db`)
fs.writeFileSync(`${BASE}/secrets/master.key`, `${CANARY}-secret`)
fs.writeFileSync(`${BASE}/config/server.json`, `{"x":"${CANARY}-config"}`)
fs.writeFileSync(`${BASE}/agent/codex-auth/auth.json`, `${CANARY}-codex`)
// the team folder: what alice may open (shared, her group, her project, her own folder, skills read-only) and what
// she may not (finance, another project, a hidden folder inside her group, bob's folder, .system)
w('projects/one/readme.md', 'hello from p1\n')
w('projects/one/public/notice.md', 'read only for alice\n')
w('shared/s.md', 'shared text\n')
w('skills/rules.md', 'skills text\n')
w('groups/marketing/brief.md', 'marketing brief\n')
w('groups/marketing/salaries/2026.md', `${CANARY}-salaries`)
w('groups/finance/budget.md', `${CANARY}-finance`)
w('projects/two/private.md', `${CANARY}-other-project`)
w('users/alice/todo.md', 'alice todo\n')
// a shared repo and her group folder: she may write them by the rules, but in a run they are read-only (Q0 (b)), so
// her AI cannot plant code there that another person's AI runs later (G-SRT-11)
w('shared/repo/package.json', '{"scripts":{"test":"echo ok"}}\n')
fs.mkdirSync(`${TEAM}/shared/repo/.git/hooks`, { recursive: true }); fs.writeFileSync(`${TEAM}/shared/repo/.git/config`, '[core]\n')
w('groups/marketing/Makefile', 'all:\n\techo ok\n')
// git repos in group folders: their hooks run in the next person's git command (G-SRT-11)
for (const g of ['groups/marketing', 'groups/finance']) { fs.mkdirSync(`${TEAM}/${g}/.git/hooks`, { recursive: true }); fs.writeFileSync(`${TEAM}/${g}/.git/config`, '[core]\n') }
// a project folder inside her group folder (no rule of its own): in a run that starts there, the group folder above is
// read-only and the project folder is writable inside it
w('groups/marketing/campaign/plan.md', 'campaign plan\n')
w('users/bob/notes.md', `${CANARY}-bob`)
w('.system/history/old.bin', `${CANARY}-system`)
fs.mkdirSync(`${DIR1}/.git/hooks`, { recursive: true }); fs.writeFileSync(`${DIR1}/.git/config`, '[core]\n')
const RULES = ruleWorld(([
  ['shared', 'everyone', null, 'write'], ['skills', 'everyone', null, 'read'],
  // the salaries: limited with no rules (docs/DECISIONS.md "Folder access adds up like Google Drive (P2)"); and a
  // limited folder with no rules inside shared/, which everyone may edit: the sandbox must deny reading it
  ['groups/marketing', 'group', 'marketing', 'write'], ['groups/marketing/salaries', 'everyone', null, 'none'], ['shared/hr-limited', 'everyone', null, 'none'],
  ['groups/finance', 'group', 'finance', 'write'],
  // carol (an admin) is a member of projects/one: since project contents are for members only (docs/DECISIONS.md
  // "Project contents only for members"), an admin opens a project only as one of its members (A28d-h, A29)
  ['projects/one', 'user', ME, 'write'], ['projects/one', 'user', 'carol', 'write'], ['projects/one/public', 'everyone', null, 'read'],
  ['projects/two', 'group', 'finance', 'write'], ['connected/nas', 'everyone', null, 'read'],
  // a shared project chat (S1-S9): projects/web has alice and dave; projects/web/mine is limited to alice alone
  ['projects/web', 'user', ME, 'write'], ['projects/web', 'user', 'dave', 'write'], ['projects/web/mine', 'user', ME, 'write'],
  // git between two members (QA TC-4939, G1-G4): projects/gitp has alice and erin and no repository yet
  ['projects/gitp', 'user', ME, 'write'], ['projects/gitp', 'user', 'erin', 'write'],
  ['groups/marketing/hr-alicealone', 'user', ME, 'write'],
  // QA TC-4945 review (S17): projects/mix both read, its w/ alice writes and dave reads, its hid/ alice's alone; a git
  // repository at its top that once tracked hid/
  ['projects/mix', 'user', ME, 'read'], ['projects/mix', 'user', 'dave', 'read'], ['projects/mix/w', 'user', ME, 'write'], ['projects/mix/w', 'user', 'dave', 'read'],
  ['projects/mix/hid', 'user', ME, 'read'],
  ['shared/deep/hr-deep', 'user', ME, 'write'],
] as [string, 'everyone' | 'group' | 'user', string | null, Access][]).map(([p, t, s, a]) => ({ path: p, subject_type: t, subject_id: s, access: a })), ['groups/marketing/salaries', 'shared/hr-limited', 'projects/one', 'projects/one/public', 'projects/two', 'projects/web', 'projects/web/mine', 'projects/gitp', 'groups/marketing/hr-alicealone', 'projects/mix', 'projects/mix/hid', 'shared/deep/hr-deep'])
const ALICE = { id: ME, name: 'Alice', role: 'member' as const, groups: ['marketing'] }
/** an admin: the rules give her write in the whole team folder, so in a run the team root is read-only (Q0 (b)) */
const CAROL = { id: 'carol', name: 'Carol', role: 'admin' as const, groups: [] as string[] }
/** shared chats (docs/decisions/20261118-devenv-shared-chats.md): dave is a member of projects/web only; erin is in
 * marketing like alice */
const DAVE: Principal = { id: 'dave', name: 'Dave', role: 'member', groups: [] }
const ERIN: Principal = { id: 'erin', name: 'Erin', role: 'member', groups: ['marketing'] }
const WEB = `${TEAM}/projects/web`
/** the shared project chat (alice and dave), the chat shared with people (alice and erin), another shared chat */
// production-length chat ids (uuid v7, 36 characters): with short ones this suite missed srt's socket paths growing past
// the unix socket limit (QA TC-4848; tests/unit/dev-env-socket-path.test.ts)
const SP = '01a1ed7a-0000-7000-8000-0000000000sp', SW = '01a1ed7a-0000-7000-8000-0000000000sw', SO = '01a1ed7a-0000-7000-8000-0000000000so'
/** what only alice has: her own folder's text, her own home and logs (no CANARY prefix: alice's own runs read them) */
const ASKER = 'ASKER-ONLY-9c1e'
fs.mkdirSync('/etc/default', { recursive: true }); fs.writeFileSync(`/etc/default/${ID}`, `MYCEL_TOKEN=${CANARY}-etcdefault\n`)
fs.mkdirSync('/tmp/server-private', { recursive: true }); fs.writeFileSync('/tmp/server-private/t', `${CANARY}-tmp`)
fs.mkdirSync(`/run/${ID}`, { recursive: true }); fs.writeFileSync(`/run/${ID}/x`, `${CANARY}-run`)
w('users/carol/c.md', 'carol note\n')
// the host around the install (QA TC-306): a NAS behind a connected folder (the team folder holds a mirror of what the
// rules show, connected/nas, without the closed sub-folder), a second NAS mounted elsewhere, other apps' files, host
// service units with a tunnel token, another login's home
const NAS = '/mnt/nas/share', NAS2 = '/data/nas2'
fs.mkdirSync(`${NAS}/closed`, { recursive: true }); fs.writeFileSync(`${NAS}/open.md`, `${CANARY}-nas-open`); fs.writeFileSync(`${NAS}/closed/pay.md`, `${CANARY}-nas-closed`)
fs.mkdirSync(NAS2, { recursive: true }); fs.writeFileSync(`${NAS2}/x.md`, `${CANARY}-nas2`)
w('connected/nas/open.md', 'nas open mirror\n')
fs.mkdirSync('/srv/other-app', { recursive: true }); fs.writeFileSync('/srv/other-app/config.env', `KEY=${CANARY}-srv\n`)
fs.mkdirSync('/opt/other', { recursive: true }); fs.writeFileSync('/opt/other/secret.txt', `${CANARY}-opt`)
fs.mkdirSync('/etc/systemd/system', { recursive: true }); fs.writeFileSync('/etc/systemd/system/cloudflared.service', `ExecStart=/usr/bin/cloudflared tunnel run --token ${CANARY}-tunnel\n`)
fs.mkdirSync('/etc/cloudflared', { recursive: true }); fs.writeFileSync('/etc/cloudflared/config.yml', `token: ${CANARY}-cfd\n`)
fs.mkdirSync('/var/lib/other-app', { recursive: true }); fs.writeFileSync('/var/lib/other-app/db', `${CANARY}-varlib`)
fs.mkdirSync('/home/someone', { recursive: true }); fs.writeFileSync('/home/someone/notes', `${CANARY}-home`)
// world-readable host secrets in /etc (independent review of QA TC-306): 0644 files a run must not read
const ETC_CANARIES: [string, string][] = [['/etc/environment', 'API_KEY'], ['/etc/fstab', '//nas/share /mnt/nas cifs password'], ['/etc/default/other-app', 'TOKEN'],
  ['/etc/netplan/50-cloud.yaml', 'wifi password'], ['/etc/cron.d/backup', 'curl -u user'], ['/etc/openvpn/client.conf', 'auth'], ['/etc/ax/link.json', 'tenant token'],
  ['/etc/samba/smb.conf', 'password'], ['/etc/msmtprc', 'password'], ['/etc/rclone/rclone.conf', 'token'], ['/etc/apt/auth.conf.d/private.conf', 'password'],
  ['/etc/pki/tls/key.pem', 'key'], ['/etc/cloud/cloud.cfg.d/99-link.cfg', 'token'], ['/etc/crontab', 'curl -u user'], ['/etc/postfix/sasl_passwd', 'password']]
for (const [f, what] of ETC_CANARIES) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, `\n${what} ${CANARY}-etc\n`); fs.chmodSync(f, 0o644) }
sh(`chmod -R a+rX ${NAS} ${NAS2} /srv/other-app /opt/other /etc/systemd/system /etc/cloudflared /var/lib/other-app /home/someone && chmod a+r /etc/systemd/system/cloudflared.service`)
w('projects/gitp/plan.md', 'plan\n')
for (const u of [ME, 'bob', 'carol', 'erin']) { fs.mkdirSync(path.join(personHome(BASE, u), 'tmp'), { recursive: true }); fs.mkdirSync(personLogs(BASE, u), { recursive: true }) }
fs.writeFileSync(path.join(personHome(BASE, 'bob'), 'secret'), `${CANARY}-other-home`)
fs.writeFileSync(path.join(personLogs(BASE, 'bob'), 'job.log'), `${CANARY}-other-log`)
fs.mkdirSync(WORK, { recursive: true }); fs.mkdirSync(chatWork(BASE, 'chat-2'), { recursive: true })
// shared chats: the project folder with a folder only alice sees, links out of it planted before the run (as an earlier
// run of her own chat could), her own home and logs with text only she has, the homes and logs of the shared chats
w('projects/web/index.html', 'web index\n')
w('projects/web/docs/guide.md', 'web guide\n')
w('projects/web/mine/secret.md', `${ASKER}-subfolder`)
// a folder of her group limited to alice alone (QA TC-4929): in a chat she shares with erin not even its name shows
w('groups/marketing/hr-alicealone/pay.md', `${ASKER}-hr`)
w('shared/deep/hr-deep/x.md', `${ASKER}-deep`); w('shared/deep/ok.md', 'deep ok\n')
w('projects/mix/readme.md', 'mix readme\n'); w('projects/mix/w/notes.md', 'mix notes\n'); w('projects/mix/hid/pay.md', `${ASKER}-mix-hid\n`)
sh(`cd ${TEAM}/projects/mix && git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm init && chmod -R a+rX .git`)
sh(`cd ${TEAM}/projects/mix && git clone -q --bare . mix.git && chmod -R a+rX mix.git`)
fs.writeFileSync(`${TEAM}/users/alice/key.txt`, `${ASKER}-own-folder`)
fs.mkdirSync(`${WEB}/.git/hooks`, { recursive: true }); fs.writeFileSync(`${WEB}/.git/config`, '[core]\n')
fs.writeFileSync(path.join(personHome(BASE, ME), '.netrc'), `machine github.com password ${ASKER}-home\n`)
fs.writeFileSync(path.join(personLogs(BASE, ME), 'job.log'), `${ASKER}-logs\n`)
for (const [l, t] of [['to-own', `${TEAM}/users/alice`], ['to-own-file', `${TEAM}/users/alice/key.txt`], ['to-mine', 'mine'], ['to-mine-file', 'mine/secret.md'],
  ['to-finance', '../../groups/finance'], ['to-one', `${TEAM}/projects/one`], ['to-secret', `${BASE}/secrets/master.key`], ['to-home', personHome(BASE, ME)],
  ['to-chat', chatWork(BASE, 'chat-2')], ['to-system', `${TEAM}/.system`]]) fs.symlinkSync(t, `${WEB}/${l}`)
for (const c of [SP, SW, SO]) { fs.mkdirSync(path.join(chatHome(BASE, c), 'tmp'), { recursive: true }); fs.mkdirSync(chatLogs(BASE, c), { recursive: true }) }
fs.mkdirSync(chatWork(BASE, SW), { recursive: true }); fs.mkdirSync(chatWork(BASE, SO), { recursive: true })
fs.writeFileSync(path.join(chatHome(BASE, SO), 'x'), `${CANARY}-other-shared-home`); fs.writeFileSync(path.join(chatLogs(BASE, SO), 'cmd.out'), `${CANARY}-other-shared-logs`)
fs.writeFileSync(path.join(chatWork(BASE, SO), 'x'), `${CANARY}-other-shared-work`)
// a shared chat's job logs (docs/decisions/20261118-devenv-shared-jobs-mac-localhost.md): the folder of SP's people and
// view (alice and dave) holds a job's log their next command reads; the folder of another audience of SP (erin joined
// since, or someone's access narrowed) holds one nobody of this audience may read (S16)
const SP_LOGS = sharedLogs(BASE, SP, sharedWorkKey([ME, 'dave'], 'logs')), SP_LOGS_OTHER = sharedLogs(BASE, SP, sharedWorkKey([ME, 'dave', 'erin'], 'logs'))
fs.mkdirSync(SP_LOGS, { recursive: true }); fs.writeFileSync(path.join(SP_LOGS, 'build.log'), 'JOB-LOG-OF-THESE-PEOPLE\n')
fs.mkdirSync(SP_LOGS_OTHER, { recursive: true }); fs.writeFileSync(path.join(SP_LOGS_OTHER, 'build.log'), `${CANARY}-other-audience-log`)
fs.writeFileSync(path.join(chatWork(BASE, 'chat-2'), 'x'), `${CANARY}-other-chat`)
// SW was alice's private chat before it was shared: its private work folder holds a copy of her own file (review 1)
fs.writeFileSync(path.join(chatWork(BASE, SW), 'x'), `${ASKER}-private-work`)
// a work folder of SW for an earlier, smaller audience (alice alone): a new audience never gets it (review 2)
fs.mkdirSync(sharedWork(BASE, SW, sharedWorkKey([ME])), { recursive: true }); fs.writeFileSync(path.join(sharedWork(BASE, SW, sharedWorkKey([ME])), 'x'), `${ASKER}-alone-work`)
// another run's short temp folder (devenv/rt/<run>, config.ts runTmp), with a marker: a shared run never sees or writes it
const RT_SIB = path.join(devenvPaths(BASE).runTmp, 'othersibling0001')
fs.mkdirSync(RT_SIB, { recursive: true }); fs.writeFileSync(path.join(RT_SIB, 'marker'), `${CANARY}-rt-sibling`)
// the git wrapper first on every run's PATH, as the runner writes it (runner.ts writeGitWrapper)
fs.mkdirSync(devenvPaths(BASE).bin, { recursive: true }); fs.writeFileSync(path.join(devenvPaths(BASE).bin, 'git'), gitWrapperSource({ node: SRT_PATHS.node, realGit: '/usr/bin/git' }), { mode: 0o755 })
// and the browser commands, as the runner writes them (runner.ts prepare, box-browser.ts)
writeBoxBrowser(devenvPaths(BASE).bin, boxBrowser('linux'), SRT_PATHS.node)
sh(`chown -R ${SRV}:${SRV} ${BASE} /tmp/server-private /run/${ID} && chown root:${SRV} /etc/default/${ID} && chmod 640 /etc/default/${ID}`)
// a host name that resolves to a private address, one to loopback (the resolved-address check)
fs.appendFileSync('/etc/hosts', '10.11.12.13 private.attack.test\n127.0.0.1 loop.attack.test\n')
// "the Trina server": a port on the host's loopback, and a unix socket
const server = Bun.serve({ hostname: '127.0.0.1', port: 8099, fetch: () => new Response(`${CANARY}-server`) })
const unixSock = `${DIR1}/server.sock`
const us = net.createServer((c) => c.end(`${CANARY}-unix`)).listen(unixSock)
await new Promise((r) => us.on('listening', r))
sh(`chown ${SRV} ${unixSock}`)
process.env.MYCEL_LEAK = `${CANARY}-env`
// credentials in the server's environment: a run never gets them (A3, S8)
process.env.GH_TOKEN = `${CANARY}-gh-token`; process.env.ANTHROPIC_API_KEY = `${CANARY}-anthropic`

// ---- one run, as the runner does it (no scope) ----
const SRT_NAMES = new Set([...SRT_DENY_FILES, ...SRT_DENY_DIRS.flatMap((d) => d.split('/').map((_, i, a) => a.slice(0, i + 1).join('/')))])
let n = 0
/** the runner's live runs and the folders each may write (runner.ts liveSweeps) */
const live = new Map<string, { userId: string; roots: string[] }>()
/** the hook sweep as the runner does it: as the server account (sweep-as.ts). Null, or why it failed */
function sweepAs(a: { roots?: string[]; entry?: string; visible?: Visible }): string | null {
  const r = Bun.spawnSync(['setpriv', `--reuid=${SRV}`, `--regid=${SRV}`, '--init-groups', '--', process.execPath, path.join(import.meta.dir, 'sweep-as.ts'), JSON.stringify(a)], { cwd: '/', env: { PATH: process.env.PATH! } })
  return r.exitCode === 0 ? null : (r.stderr.toString().trim() || `exit ${r.exitCode}`)
}
async function run(command: string, o: { network?: 'open' | 'offline'; cwd?: string; extra?: string[]; user?: string[]; full?: boolean; during?: () => void; afterPins?: () => void; timeoutMs?: number; work?: boolean; start?: string; who?: Principal; people?: (typeof ALICE | typeof CAROL)[]; shared?: { chat: string; within: string | null; audience: Principal[] }; rawCwd?: boolean } = {}): Promise<{ code: number | null; out: string; refused?: string }> {
  const runId = `attack${String(++n).padStart(10, '0')}`
  const sh_ = o.shared
  // a shared chat (runner.ts spaceOf): a project chat starts in its project folder, a chat shared with people in its work folder
  // (its own work folder for the people who see it now, never the private one: config.ts sharedWork)
  const work = sh_ ? (sh_.within === null ? sharedWork(BASE, sh_.chat, sharedWorkKey(sh_.audience.map((q) => q.id))) : null) : o.work ? WORK : null
  // a shared chat's command: a home and logs of its own (runner.ts prepare)
  // a person's run in a project folder: a home of its own for that folder (runner.ts runOwner, config.ts projectHome)
  const projectFolder = sh_ || work ? null : o.start ?? 'projects/one'
  // a shared chat's logs folder: the one of its people (runner.ts sharedLogKey; here a key of the audience alone)
  const logKey = sh_ ? sharedWorkKey(sh_.audience.map((q) => q.id), 'logs') : null
  const owner = { userId: (o.who ?? ALICE).id, sharedChat: sh_ ? sh_.chat : null, runId, projectFolder, logKey }
  if (!sh_) { fs.mkdirSync(path.join(runHome(BASE, owner), 'tmp'), { recursive: true }); sh(`chown -R ${SRV}:${SRV} ${devenvPaths(BASE).root}`) }
  if (sh_) { for (const d of [runHome(BASE, owner), runTmp(BASE, owner), runLogs(BASE, owner), ...(work ? [work] : [])]) fs.mkdirSync(d, { recursive: true }); sh(`chown -R ${SRV}:${SRV} ${devenvPaths(BASE).root}`) }
  // the run's view: the person's folder rules, writable only in the starting folder and her own folder
  const start = sh_ ? sh_.within : work ? null : o.start ?? 'projects/one'
  const who = o.who ?? ALICE
  // with people (the runner passes the team's active people): a project run reads only what all who see it may read.
  // A shared chat: what the person AND everyone who sees the chat may read (access.ts sharedFolderView)
  const view = sh_ ? sharedFolderView(RULES, who, { start }, { audience: sh_.audience, within: sh_.within }) : folderView(RULES, who, { start }, o.people)
  const sharedChat = sh_ ? sh_.chat : null
  // a shared chat: read-only folders holding a denied one are given entry by entry (runner.ts settingsFor, mounts.ts)
  const given = sh_ ? hideDeniedNames(view, TEAM) : view
  const pinsNow = sh_ ? entryPins(view, given, TEAM) : {}
  const input = { base: BASE, id: ID, teamRoot: TEAM, userId: who.id, view: given, start, work, sharedChat, runId, projectFolder, logKey, network: o.network ?? 'open', extraDomains: o.extra ?? [], userDomains: o.user ?? [], full: o.full ?? false, denyHosts: ['team.trina.test'], denyAddrs: ['203.0.113.7'], connectedSources: [NAS, NAS2] }
  const settings = srtSettings(input)
  const problems = settingsProblems(settings, input)
  if (problems.length) throw new Error(problems.join('; '))
  // as the runner: the entries given one by one are checked first inside the sandbox, and srt's places and masks are
  // made read-only there, in every run (mounts.ts entryGuard, lockFolders)
  // in the run's own guard folder, made new and read-only in the run (never the TMPDIR: RX1-RX4)
  const gdir = runGuard(BASE, runId)!
  const dropGuard = makeGuardDir(gdir)
  const pinFiles = writePins(gdir, pinsNow, lockFolders(given, settings.filesystem.denyRead, TEAM))
  sh(`chown -R ${SRV}:${SRV} '${path.dirname(gdir)}'`)
  const guard = entryGuard(pinFiles)
  // S18: the disk changes after the listing, before srt binds
  o.afterPins?.()
  const root = work ?? `${TEAM}/${start}`
  const cwd = resolveRunCwd(root, o.cwd ?? '')
  if (!cwd) return { code: null, out: '', refused: 'cwd' }
  // as the runner: a shared chat's cwd in a team folder the chat does not show is refused before srt (runner.ts
  // sharedCwdShown, by the rules for everyone in the chat)
  if (sh_ && !o.rawCwd) {
    const rel = path.relative(fs.realpathSync(TEAM), cwd)
    const outside = rel.startsWith('..') || path.isAbsolute(rel)
    if (!outside && (rel === '' || sharedPathAccess(RULES, who, { start }, { audience: sh_.audience, within: sh_.within }, rel) === 'none')) return { code: null, out: '', refused: 'cwd' }
  }
  const settingsFile = path.join(devenvPaths(BASE).run, `${runId}.json`)
  fs.writeFileSync(settingsFile, JSON.stringify(settings), { mode: 0o600 }); sh(`chown ${SRV} ${settingsFile}`)
  const exitFile = path.join(runLogs(BASE, owner), `${runId}.exit`)
  const argv = ['setpriv', `--reuid=${SRV}`, `--regid=${SRV}`, '--init-groups', '--', ...wrappedArgv({ exitFile, settingsFile, command: guard ? `${guard}\n${command}` : command, full: isFull(settings) })]
  // as the runner: srt's protected names exist in the cwd before the run (placeholders.ts), owned by the server account
  const release = holdPlaceholders(cwd)
  sh(`chown -h ${SRV}:${SRV} ${[...SRT_NAMES].map((n) => `'${path.join(cwd, n)}'`).join(' ')} 2>/dev/null || true`)
  // as the runner (spawnRun): every file git could run as a hook in the folders the run may write loses its exec bit
  // before the run, and again after it (QA TC-5348, hook-sweep.ts)
  const swept = sweepRoots(settings.filesystem.allowWrite, [runHome(BASE, owner), runTmp(BASE, owner)])
  const visible = visibleOf(settings.filesystem, TEAM)
  // and the folders other people's live runs may write that this run may read (runner.ts liveSweeps)
  const first = sweepAs({ roots: [...new Set([...swept, ...othersLive(live.values(), who.id, visible)])], visible })
  if (first !== null) { release(); dropGuard(); return { code: null, out: first, refused: 'sweep' } }
  live.set(runId, { userId: who.id, roots: swept })
  const p = Bun.spawn(argv, { cwd, env: runEnv({ base: BASE, userId: who.id, teamRoot: TEAM, work, sharedChat, runId, projectFolder, logKey }), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const t = setTimeout(() => p.kill('SIGKILL'), o.timeoutMs ?? 60_000)
  if (o.during) setTimeout(o.during, 1500)
  const [a, b] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  await p.exited; clearTimeout(t)
  const code = fs.existsSync(exitFile) ? Number(fs.readFileSync(exitFile, 'utf8').trim()) : null
  release(); dropGuard()
  const after = sweepAs({ roots: swept, visible }); live.delete(runId)
  if (after !== null) console.log(`     note: the sweep after ${runId} failed: ${after}`)
  fs.rmSync(settingsFile, { force: true }); fs.rmSync(exitFile, { force: true })
  return { code, out: a + b }
}

/** a git repo in a team folder changed: a hook was added, or .git/config names another hooks folder */
const gitChanged = (rel: string) => (fs.readdirSync(`${TEAM}/${rel}/.git/hooks`).length || fs.readFileSync(`${TEAM}/${rel}/.git/config`, 'utf8').includes('hooksPath') ? `${rel}/.git changed` : null)
type Check = (r: { code: number | null; out: string; refused?: string }) => string | null
// The pinned browser in a run, driven over its debugging pipe with no library (tests/linux/box-libs-install.sh installs it
// from the one list). argv: url, then "auth" to log in to the run's proxy, "force" to send even local addresses to it.
const BROWSER_DRIVER = String.raw`
const { spawn } = require("child_process"), fs = require("fs"), path = require("path");
const [url, ...o] = process.argv.slice(1), px = new URL(process.env.HTTPS_PROXY);
const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, "br-"));
const args = ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--remote-debugging-pipe", "--user-data-dir=" + dir, "--allow-file-access-from-files"];
if (o.includes("force")) args.push("--proxy-server=" + px.origin, "--proxy-bypass-list=<-loopback>");
const b = spawn(process.env.HYPERFRAMES_BROWSER_PATH, [...args, "about:blank"], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
let id = 0, buf = "", status = "", sid; const wait = new Map();
const send = (method, params = {}, s = sid) => new Promise((r) => { const m = ++id; wait.set(m, r); b.stdio[3].write(JSON.stringify({ id: m, method, params, ...(s ? { sessionId: s } : {}) }) + "\0"); });
const end = (t) => { console.log(t); try { b.kill("SIGKILL"); } catch {} setTimeout(() => { fs.rmSync(dir, { recursive: true, force: true }); process.exit(0); }, 200); };
let loaded; const load = new Promise((r) => { loaded = r; });
b.stdio[4].on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\0")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
  if (m.id && wait.has(m.id)) { wait.get(m.id)(m.result || { error: m.error }); wait.delete(m.id); continue; }
  if (m.method === "Fetch.requestPaused") send("Fetch.continueRequest", { requestId: m.params.requestId });
  if (m.method === "Fetch.authRequired") send("Fetch.continueWithAuth", { requestId: m.params.requestId, authChallengeResponse: o.includes("auth") ? { response: "ProvideCredentials", username: decodeURIComponent(px.username), password: decodeURIComponent(px.password) } : { response: "CancelAuth" } });
  if (m.method === "Network.responseReceived" && m.params.type === "Document" && !status) status = String(m.params.response.status);
  if (m.method === "Page.loadEventFired") loaded();
} });
setTimeout(() => end("timeout status=" + status), 25000);
(async () => {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" }, null);
  sid = (await send("Target.attachToTarget", { targetId, flatten: true }, null)).sessionId;
  await send("Page.enable"); await send("Network.enable"); await send("Fetch.enable", { handleAuthRequests: true });
  const n = await send("Page.navigate", { url });
  if (n.errorText) return end("error=" + n.errorText + " status=" + status);
  await Promise.race([load, new Promise((r) => setTimeout(r, 6000))]);
  const t = await send("Runtime.evaluate", { expression: "document.documentElement.outerHTML" });
  end("status=" + status + " body=" + String(t.result && t.result.value).slice(0, 400));
})();
`
const browse = (url: string, ...o: ('auth' | 'force')[]) => `test -x "$HYPERFRAMES_BROWSER_PATH" || { echo NO-BROWSER; exit 9; }; node -e "$(echo ${Buffer.from(BROWSER_DRIVER).toString('base64')} | base64 -d)" ${JSON.stringify(url)} ${o.join(' ')} 2>&1 | grep -v -E 'UNDICI|trace-warnings'`
const failsQuietly: Check = (r) => (r.code === 0 ? `exit code 0: ${r.out.slice(0, 200)}` : null)
const ok: Check = (r) => (r.code === 0 ? null : `exit code ${r.code}: ${r.out.slice(0, 300)}`)
const has = (s: string): Check => (r) => (r.out.includes(s) ? null : `no "${s}" in: ${r.out.slice(0, 300)}`)
/** the output without the exact "No such file or directory" lines of cat and ls for paths the attack typed itself
 * (they repeat that path). Any other line stays, "Permission denied" too: it would tell that a hidden folder is there. */
const typedNotThere = (out: string, ...paths: string[]) => out.split('\n').filter((l) => !paths.some((p) => l === `cat: ${p}: No such file or directory` || l === `ls: cannot access '${p}': No such file or directory`)).join('\n')
/** nothing that only alice may open (her own folder, her sub-folder, her home and logs) came back */
const noAsker: Check = (r) => (r.out.includes(ASKER) || r.out.includes('alice todo') ? `something only alice may open came back: ${r.out.slice(Math.max(0, r.out.indexOf(ASKER) - 60), r.out.indexOf(ASKER) + 40)}` : null)
const SPC = { shared: { chat: SP, within: 'projects/web', audience: [ALICE, DAVE] } }
const SWC = { shared: { chat: SW, within: null, audience: [ALICE, ERIN] } }
const SW_WORK = sharedWork(BASE, SW, sharedWorkKey([ALICE.id, ERIN.id]))
/** a shared project chat in projects/gitp (alice and erin): a writable project folder given whole, no hidden sub-folder */
const GITPC = { shared: { chat: '01a1ed7a-0000-7000-8000-00000000gitp', within: 'projects/gitp', audience: [ALICE, ERIN] } }
const both = (...cs: Check[]): Check => (r) => cs.map((c) => c(r)).find((x) => x) ?? null

const GITP = `${TEAM}/projects/gitp`
const HOOK_MARK = path.join(personHome(BASE, ME), '.hook-was-here')
/** git as the server (root) on the test's repositories, which the server account owns */
const hostGit = (dir: string, ...args: string[]) => { fs.mkdirSync(dir, { recursive: true }); const r = Bun.spawnSync(['git', '-c', 'safe.directory=*', ...args], { cwd: dir, env: { PATH: process.env.PATH!, HOME: '/root' } }); sh(`chown -R ${SRV}:${SRV} ${GITP}`); return r }
const GMARK = `${GITP}/PLANTED-RAN`
/** a git call refused by the wrapper, and nothing planted ran */
const gitRefused = (r: { code: number | null; out: string }) => (!r.out.includes('git was refused') ? `git was not refused: ${r.out.slice(0, 300)}` : fs.existsSync(GMARK) ? 'a planted program ran' : null)
const PROJECT_HOME = projectHome(BASE, ME, 'projects/gitp')
const GID = '-c user.name=a -c user.email=a@example.com'
/** no hook of erin's ran: no line of it in the output, no mark in the project folder */
const hookNotRun: Check = (r) => (r.out.split('\n').some((l) => l.trim() === 'HOOK-RAN') ? `a hook ran: ${r.out.slice(0, 300)}` : fs.existsSync(GMARK) ? 'a planted hook left its mark' : null)
/** a file on the disk has no exec bit */
const noExec = (f: string) => { try { return fs.statSync(f).mode & 0o111 ? `${path.relative(TEAM, f)} is executable on the disk` : null } catch { return `${path.relative(TEAM, f)} is not there` } }
const attacks: { id: string; what: string; cmd: string; check: Check; o?: Parameters<typeof run>[1]; after?: () => string | null; before?: () => void }[] = [
  { id: 'A0', what: 'the project folder and her own folder: read and write; her other folders and read-only folders: read', cmd: `cat readme.md && echo new > new.txt && cat new.txt && echo $HOME && touch $TMPDIR/x && cat ${TEAM}/skills/rules.md && cat ${TEAM}/shared/s.md && cat ${TEAM}/groups/marketing/brief.md && echo y > ${TEAM}/users/alice/new.md && cat public/notice.md`, check: both(ok, has('hello from p1'), has('new'), has('skills text'), has('shared text'), has('marketing brief'), has('read only for alice')) },
  { id: 'A0b', what: 'a chat with no project: the work folder, and the person\'s folders (read)', cmd: `pwd && echo w > w.txt && cat w.txt && cat ${TEAM}/shared/s.md && cat ${DIR1}/readme.md && echo z > ${TEAM}/users/alice/z.md && echo $TRINA_WORK`, check: both(ok, has(WORK), has('shared text'), has('hello from p1')), o: { work: true } },
  // the box's libraries (docs/decisions/20261121-box-python-libs.md): every one loads inside srt (native modules too),
  // a deck with a chart is made, node requires pptxgenjs and docx, and a package from PyPI goes into a venv of the folder
  { id: 'LIB1', what: 'the box\'s Python and Node libraries load in a run; python-pptx makes a deck with a matplotlib chart', cmd: `which python3 && python3 -c \"import importlib; [importlib.import_module(m) for m in 'pptx docx openpyxl lxml.etree PIL.Image xlsxwriter numpy pandas matplotlib.pyplot reportlab.pdfgen.canvas pypdf'.split()]; print('PY-LIBS-OK')\" && python3 -c "import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as p; p.plot([1,2]); p.savefig('c.png'); from pptx import Presentation; from pptx.util import Inches; d=Presentation(); s=d.slides.add_slide(d.slide_layouts[6]); s.shapes.add_picture('c.png', Inches(1), Inches(1)); d.save('deck.pptx'); print('DECK-OK')" && node -e "require('pptxgenjs'); require('docx'); console.log('NODE-LIBS-OK')"`, check: both(ok, has('/opt/trina/python/python-pptx/current/bin/python3'), has('PY-LIBS-OK'), has('DECK-OK'), has('NODE-LIBS-OK')), o: { work: true } },
  { id: 'LIB2', what: 'another package from PyPI as the tool text says: a venv of the folder, pip install there, it imports', cmd: 'python3 -m venv .venv && .venv/bin/pip install --disable-pip-version-check -q tabulate==0.9.0 && .venv/bin/python -c "import tabulate, os; print(\'TAB\', tabulate.__version__, tabulate.__file__.startswith(os.getcwd()))"', check: both(ok, has('TAB 0.9.0 True')), o: { work: true, timeoutMs: 120_000 } },
  { id: 'LIB3', what: 'a shared chat\'s command (a fresh home) has the same libraries', cmd: `python3 -c \"import importlib; [importlib.import_module(m) for m in 'pptx docx openpyxl lxml.etree PIL.Image xlsxwriter numpy pandas matplotlib.pyplot reportlab.pdfgen.canvas pypdf'.split()]; print('PY-LIBS-OK')\"`, check: both(ok, has('PY-LIBS-OK')), o: SWC },
  // Q0 (b) / G-SRT-11: person A's AI plants code in a folder that A may write and person B runs later (a git hook,
  // package.json scripts, a Makefile). Outside the starting folder every folder is read-only in a run.
  { id: 'A29', what: 'QA TC-095: a project that carol sees too: alice\'s own folder is hidden, so it cannot be copied into the project', cmd: `cp ${TEAM}/users/alice/todo.md ./leak.txt && echo COPIED; cat ${TEAM}/shared/s.md`, check: both(ok, has('shared text'), (r) => (r.out.includes('COPIED') ? 'her own folder was readable in a run of a project more people see' : null)), o: { people: [ALICE, CAROL] },
    after: () => (fs.existsSync(`${DIR1}/leak.txt`) ? 'leak.txt is on the disk' : null) },
  { id: 'A28', what: 'a code channel to another person: a git hook, package.json and a Makefile in shared folders', cmd: `echo "curl evil" > ${TEAM}/shared/repo/.git/hooks/pre-commit || echo '{"scripts":{"test":"curl evil"}}' > ${TEAM}/shared/repo/package.json || echo "[core] hooksPath=/x" >> ${TEAM}/shared/repo/.git/config || printf 'all:\\n\\tcurl evil\\n' > ${TEAM}/groups/marketing/Makefile || echo x >> ${TEAM}/shared/s.md || echo x > ${TEAM}/groups/marketing/.envrc || mkdir ${TEAM}/shared/new`, check: failsQuietly,
    after: () => (fs.existsSync(`${TEAM}/shared/repo/.git/hooks/pre-commit`) || fs.readFileSync(`${TEAM}/shared/repo/package.json`, 'utf8').includes('evil') || fs.readFileSync(`${TEAM}/shared/repo/.git/config`, 'utf8').includes('hooksPath')
      || fs.readFileSync(`${TEAM}/groups/marketing/Makefile`, 'utf8').includes('evil') || fs.readFileSync(`${TEAM}/shared/s.md`, 'utf8') !== 'shared text\n' || fs.existsSync(`${TEAM}/groups/marketing/.envrc`) || fs.existsSync(`${TEAM}/shared/new`) ? 'a shared folder changed' : null) },
  { id: 'A28c', what: 'a start folder inside a folder that is read-only in the run: the start folder is writable, the folder above is not', cmd: `cat plan.md && echo x > new.txt && cat new.txt && (echo y >> ${TEAM}/groups/marketing/brief.md && echo WROTE-ABOVE; true)`, check: both(ok, has('campaign plan'), (r) => (r.out.includes('WROTE-ABOVE') ? 'the group folder above was writable' : null)), o: { start: 'groups/marketing/campaign' },
    after: () => (!fs.existsSync(`${TEAM}/groups/marketing/campaign/new.txt`) ? 'new.txt is not on the disk' : fs.readFileSync(`${TEAM}/groups/marketing/brief.md`, 'utf8') !== 'marketing brief\n' ? 'brief.md changed' : null) },
  { id: 'A28d', what: 'an admin: the project folder and her own folder are writable; the team root and every other folder are read-only', cmd: `cat readme.md && echo a > admin.txt && cat admin.txt && echo c >> ${TEAM}/users/carol/c.md && cat ${TEAM}/groups/finance/budget.md | head -c 0 && (echo z > ${TEAM}/top.txt && echo WROTE-ROOT; echo z >> ${TEAM}/groups/finance/budget.md && echo WROTE-FINANCE; true)`, check: both(ok, has('hello from p1'), (r) => (/WROTE-(ROOT|FINANCE)/.test(r.out) ? 'a folder outside the project was writable' : null)), o: { who: CAROL },
    after: () => (!fs.existsSync(`${DIR1}/admin.txt`) ? 'admin.txt is not on the disk' : fs.existsSync(`${TEAM}/top.txt`) ? 'the team root changed' : !fs.readFileSync(`${TEAM}/users/carol/c.md`, 'utf8').includes('c\n') ? 'her own folder was not writable' : null) },
  { id: 'A28e', what: 'an admin\'s run (the start folder bound back writable): .git/hooks, .git/config and .bashrc there stay read-only', cmd: 'echo "curl evil" > .git/hooks/pre-commit || echo "[core] hooksPath=/x" >> .git/config || echo evil >> .bashrc', check: failsQuietly, o: { who: CAROL },
    after: () => (fs.existsSync(`${DIR1}/.git/hooks/pre-commit`) || fs.readFileSync(`${DIR1}/.git/config`, 'utf8').includes('hooksPath') || (fs.existsSync(`${DIR1}/.bashrc`) && fs.readFileSync(`${DIR1}/.bashrc`, 'utf8').includes('evil')) ? 'a protected file changed' : null) },
  // the same code channel through .git/hooks of a group folder: from a project run, from a run that starts inside the
  // group folder (the group folder above is read-only, the start folder bound back), and from an admin's run (the
  // rules give her write everywhere)
  { id: 'A28f', what: 'a git hook and .git/config in her group folder, from a project run', cmd: `echo "curl evil" > ${TEAM}/groups/marketing/.git/hooks/pre-commit || echo "[core] hooksPath=/x" >> ${TEAM}/groups/marketing/.git/config || mkdir ${TEAM}/groups/marketing/.git/hooks/x`, check: failsQuietly, after: () => gitChanged('groups/marketing') },
  { id: 'A28g', what: 'a git hook in the group folder above the start folder', cmd: `echo "curl evil" > ${TEAM}/groups/marketing/.git/hooks/pre-commit || echo "[core] hooksPath=/x" >> ${TEAM}/groups/marketing/.git/config || echo "curl evil" > ../.git/hooks/post-checkout`, check: failsQuietly, o: { start: 'groups/marketing/campaign' }, after: () => gitChanged('groups/marketing') },
  { id: 'A28h', what: 'an admin: git hooks, package.json and new folders in shared and group folders', cmd: `echo "curl evil" > ${TEAM}/shared/repo/.git/hooks/pre-commit || echo '{"scripts":{"test":"curl evil"}}' > ${TEAM}/shared/repo/package.json || echo "curl evil" > ${TEAM}/groups/finance/.git/hooks/pre-commit || echo "[core] hooksPath=/x" >> ${TEAM}/groups/finance/.git/config || echo "curl evil" > ${TEAM}/groups/marketing/.git/hooks/pre-commit || mkdir ${TEAM}/shared/new || mkdir ${TEAM}/newtop || echo x > ${TEAM}/groups/finance/x.md`, check: failsQuietly, o: { who: CAROL },
    after: () => gitChanged('shared/repo') ?? gitChanged('groups/finance') ?? gitChanged('groups/marketing') ?? (fs.readFileSync(`${TEAM}/shared/repo/package.json`, 'utf8').includes('evil') || fs.existsSync(`${TEAM}/shared/new`) || fs.existsSync(`${TEAM}/newtop`) || fs.existsSync(`${TEAM}/groups/finance/x.md`) || fs.existsSync(`${TEAM}/projects/two/x.md`) ? 'a team folder outside the project changed' : null) },
  { id: 'A28b', what: 'a chat with no project: the project folder and the shared folders are read-only', cmd: `echo x > ${DIR1}/planted.js || echo x >> ${DIR1}/readme.md || echo "curl evil" > ${TEAM}/shared/repo/.git/hooks/post-checkout || echo x >> ${TEAM}/shared/s.md`, check: failsQuietly, o: { work: true },
    after: () => (fs.existsSync(`${DIR1}/planted.js`) || fs.readFileSync(`${DIR1}/readme.md`, 'utf8') !== 'hello from p1\n' || fs.existsSync(`${TEAM}/shared/repo/.git/hooks/post-checkout`) || fs.readFileSync(`${TEAM}/shared/s.md`, 'utf8') !== 'shared text\n' ? 'a team folder outside the work folder changed' : null) },
  // QA TC-306: the host outside the team folder. Through the mirror the open part of the NAS reads; the source does not
  { id: 'A30', what: 'a connected folder: the mirror reads; its NAS source (and the closed sub-folder) does not', cmd: `cat ${TEAM}/connected/nas/open.md; cat ${NAS}/open.md; cat ${NAS}/closed/pay.md; cat ${NAS2}/x.md; ls -a /mnt /mnt/nas ${NAS} /data ${NAS2}; true`, check: has('nas open mirror') },
  { id: 'A31', what: 'other apps\' files, host units and tunnel tokens, other homes', cmd: 'cat /srv/other-app/config.env; cat /opt/other/secret.txt; cat /etc/systemd/system/cloudflared.service; grep -r tunnel /etc/systemd; cat /etc/cloudflared/config.yml; cat /var/lib/other-app/db; cat /home/someone/notes; true', check: () => null },
  { id: 'A31b', what: 'listing /opt, /var/lib, /srv, /mnt, /media, /home shows nothing but the paths to the run\'s own folders', cmd: 'echo OPT: $(ls -a /opt 2>&1); echo VARLIB: $(ls -a /var/lib 2>&1); echo SRV: $(ls -a /srv 2>&1); echo MNT: $(ls -a /mnt 2>&1); echo MEDIA: $(ls -a /media 2>&1); echo HOME: $(ls -a /home 2>&1); echo ROOT: $(ls -a / 2>&1)',
    check: (r) => {
      const line = (k: string) => (r.out.split('\n').find((l) => l.startsWith(k + ':')) ?? '').slice(k.length + 1).replace(/\.\.?(?=\s|$)/g, '').trim().split(/\s+/).filter((x) => x && !x.startsWith('ls:') && !/^(cannot|access|No|such|file|or|directory|'.*'|Permission|denied)$/.test(x))
      const bad = [['OPT', ['trina']], ['VARLIB', [ID]], ['SRV', []], ['MNT', []], ['MEDIA', []], ['HOME', []]].flatMap(([k, okNames]) => line(k as string).filter((x) => !(okNames as string[]).includes(x)).map((x) => `${k} lists ${x}`))
      return bad.length ? `${bad.join(', ')}: ${r.out.slice(0, 400)}` : null
    } },
  { id: 'A31c', what: 'world-readable host secrets in /etc: fstab, environment, /etc/default, netplan, cron, VPN, link token, mail, rclone, apt auth', cmd: `${ETC_CANARIES.map(([f]) => `cat ${f}`).join('; ')}; grep -rs ${CANARY} /etc; true`, check: () => null },
  // what a normal dev run needs still works: node, python, git, bun, an npm install into the run's own folders
  { id: 'A0c', what: 'node, python, git, bun, curl to an allowed site and an npm install in the work folder', cmd: 'node -e "console.log(\'node-ok\', process.version)" && python3 -c "import ssl,json,sqlite3;print(\'py-ok\')" && git init -q g && cd g && git -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m x && echo git-ok && cd .. && bun --version && npm init -y >/dev/null && npm install --no-audit --no-fund is-number >/dev/null && node -e "require(\'is-number\');console.log(\'npm-ok\')" && ls /opt/trina/srt >/dev/null && echo opt-ok && test -r /etc/ssl/certs/ca-certificates.crt && getent passwd root >/dev/null && echo etc-ok',
    check: both(ok, has('node-ok'), has('py-ok'), has('git-ok'), has('npm-ok'), has('opt-ok'), has('etc-ok')), o: { work: true, timeoutMs: 180_000 } },
  { id: 'A1', what: 'the DB, secrets, config, engine logins', cmd: `cat ${BASE}/data/app.db || cat ${BASE}/secrets/master.key || cat ${BASE}/config/server.json || cat ${BASE}/agent/codex-auth/auth.json || grep -r ${CANARY} ${BASE}`, check: failsQuietly },
  // srt shows the folders on the way to an allowed folder, with only those paths in them
  { id: 'A2', what: 'folders the person may not open: another project, another group, a hidden folder inside her group, another person\'s folder, .system', cmd: `cat ${TEAM}/projects/two/private.md; cat ${TEAM}/groups/finance/budget.md; cat ${TEAM}/groups/marketing/salaries/2026.md; cat ${TEAM}/users/bob/notes.md; cat ${TEAM}/.system/history/old.bin; ls -a ${TEAM} ${TEAM}/projects ${TEAM}/groups ${TEAM}/users ${TEAM}/groups/marketing`, check: (r) => (/\btwo\b|\bfinance\b|\bbob\b|\.system|\bdata\b/.test(r.out.replace(/No such file or directory/g, '').replace(/cat: [^\n]*\n/g, '')) ? `a hidden folder is listed: ${r.out.slice(0, 300)}` : null) },
  // srt shows the path to the own work folder, so the work folder list names only this chat
  { id: 'A2b', what: 'another chat\'s work folder; another person\'s logs and home', cmd: `cat ${chatWork(BASE, 'chat-2')}/x || cat ${personLogs(BASE, 'bob')}/job.log || ls ${personLogs(BASE, 'bob')} || cat ${personHome(BASE, 'bob')}/secret`, check: failsQuietly, o: { work: true } },
  { id: 'A2d', what: 'the list of work folders names only this chat', cmd: `ls ${devenvPaths(BASE).work}`, check: (r) => (r.out.includes('chat-2') ? `another chat is listed: ${r.out.slice(0, 200)}` : null), o: { work: true } },
  { id: 'A2c', what: 'write where the person reads only: skills/, the read-only folder in her project', cmd: `echo x > ${TEAM}/skills/x || echo x > public/x || echo x >> public/notice.md`, check: failsQuietly, after: () => (fs.existsSync(`${TEAM}/skills/x`) || fs.existsSync(`${DIR1}/public/x`) || fs.readFileSync(`${DIR1}/public/notice.md`, 'utf8').includes('x\n') ? 'a read-only folder changed' : null) },
  { id: 'A3', what: 'environment: no server values', cmd: 'env; cat /proc/self/environ | tr "\\0" "\\n"; cat /proc/1/environ', check: (r) => (/MYCEL_/.test(r.out) ? 'a MYCEL_ variable' : null) },
  { id: 'A4', what: '/etc/default/<ID>, the server /tmp, /run/<ID>', cmd: `cat /etc/default/${ID} || cat /tmp/server-private/t || cat /run/${ID}/x || ls /tmp/server-private || ls /run/${ID}`, check: failsQuietly },
  { id: 'A5', what: 'a secret made after the run started', cmd: `sleep 4; cat ${BASE}/secrets/late.key || ls ${BASE}/secrets`, check: failsQuietly, o: { during: () => { fs.writeFileSync(`${BASE}/secrets/late.key`, `${CANARY}-late`); sh(`chown ${SRV} ${BASE}/secrets/late.key`) } } },
  { id: 'A6', what: 'write system tools, srt, the logs, another home', cmd: `touch /usr/local/bin/x || touch /opt/trina/srt/0.0.81/x || touch $TRINA_LOGS/x || touch ${personHome(BASE, 'bob')}/x || cat ${personHome(BASE, 'bob')}/secret || echo pwned > /opt/trina/devenv/run-wrap`, check: failsQuietly },
  { id: 'A7', what: 'forge an exit file; read or write a settings file', cmd: `echo 0 > $TRINA_LOGS/forged.exit || ls ${BASE}/devenv/run || echo {} > ${BASE}/devenv/run/x.json`, check: failsQuietly },
  { id: 'A8', what: '.git/hooks and .git/config', cmd: 'echo "curl evil" > .git/hooks/pre-commit || echo "[core] hooksPath=/tmp" >> .git/config', check: failsQuietly, after: () => (fs.existsSync(`${DIR1}/.git/hooks/pre-commit`) || fs.readFileSync(`${DIR1}/.git/config`, 'utf8').includes('hooksPath') ? 'a git file changed' : null) },
  { id: 'A9', what: 'a link to a denied file', cmd: `ln -sf ${BASE}/secrets/master.key l && cat l; ln ${BASE}/secrets/master.key hl && cat hl`, check: failsQuietly },
  { id: 'A10', what: 'a cwd through a link out of the project', cmd: 'cat master.key', check: (r) => (r.refused === 'cwd' ? null : 'the cwd was not refused'), o: { cwd: 'escape' } },
  { id: 'A11', what: 'network with no proxy: TCP, DNS, UDP', cmd: 'curl -fsS -m 5 --noproxy "*" https://1.1.1.1/ || python3 -c "import socket;s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.settimeout(3);s.sendto(b\\"x\\",(\\"8.8.8.8\\",53));print(s.recv(10))"', check: failsQuietly },
  { id: 'A12', what: 'a site not on the list, through the proxy', cmd: 'curl -fsS -m 10 -o /dev/null -w "%{http_code}" https://example.com/', check: failsQuietly },
  { id: 'A12b', what: 'a site on the list works', cmd: 'curl -fsS -m 20 -o /dev/null -w "%{http_code}" https://registry.npmjs.org/', check: both(ok, has('200')) },
  { id: 'A13', what: 'metadata, private ranges, names that resolve inside', cmd: 'curl -fsS -m 5 http://169.254.169.254/latest/meta-data/ || curl -fsS -m 5 http://10.11.12.13/ || curl -fsS -m 5 http://private.attack.test/ || curl -fsS -m 5 http://loop.attack.test:8099/ || curl -fsS -m 5 http://203.0.113.7/', check: failsQuietly, o: { extra: ['private.attack.test', 'loop.attack.test'] } },
  { id: 'A14', what: 'the Trina server port and host name', cmd: 'curl -fsS -m 5 http://127.0.0.1:8099/ || curl -fsS -m 5 --noproxy "*" http://127.0.0.1:8099/ || curl -fsS -m 5 https://team.trina.test/', check: failsQuietly },
  { id: 'A15', what: 'git over ssh', cmd: 'GIT_TERMINAL_PROMPT=0 timeout 20 git clone ssh://git@example.com/x.git /tmp/x', check: failsQuietly },
  { id: 'A16', what: 'a unix socket of the server', cmd: `python3 -c "import socket;s=socket.socket(socket.AF_UNIX);s.connect('${unixSock}');print(s.recv(100))"`, check: failsQuietly },
  // the browser of a run (config.ts BOX_BROWSER) needs no unix socket by path: this block stays (decisions/20261123-chat-browser-render.md)
  { id: 'A16b', what: 'no new unix socket, by path or abstract; a socketpair (the browser\'s own pipes) works', cmd: `python3 -c "
import socket
a,b=socket.socketpair(); a.send(b'x'); assert b.recv(1)==b'x'
for addr in ('${unixSock}', '\\0trina-attack'):
    try:
        s=socket.socket(socket.AF_UNIX); s.connect(addr); print('REACHED', addr)
    except PermissionError: print('refused')
"`, check: (r) => (r.code === 0 && r.out.split('refused').length === 3 && !r.out.includes('REACHED') ? null : `code ${r.code}: ${r.out.slice(0, 200)}`) },
  // the pinned browser in a run (docs/decisions/20261123-chat-browser-render.md). A missing browser fails these: never a skip
  { id: 'BR1', what: 'browser: an allowed site, logged in to the proxy, answers 200', cmd: browse('https://registry.npmjs.org/-/ping', 'auth'), check: has('status=200') },
  { id: 'BR2', what: 'browser: without the login the proxy answers 407, also for an allowed site', cmd: browse('https://registry.npmjs.org/-/ping'), check: has('status=407') },
  { id: 'BR3', what: 'browser: a site not on the list is refused (http 403, https no tunnel)', cmd: `${browse('http://example.com/', 'auth')}; ${browse('https://example.com/', 'auth')}`, check: both(has('status=403'), has('ERR_TUNNEL_CONNECTION_FAILED')) },
  { id: 'BR4', what: 'browser: the host loopback through the proxy, logged in, is 403', cmd: browse('http://127.0.0.1:8099/', 'auth', 'force'), check: (r) => (r.out.includes('status=403') && !r.out.includes(CANARY) ? null : r.out.slice(0, 300)) },
  { id: 'BR5', what: 'browser: a private address through the proxy, logged in, is 403', cmd: browse('http://10.11.12.13/', 'auth', 'force'), check: has('status=403') },
  { id: 'BR6', what: 'browser: the metadata address through the proxy, logged in, is 403', cmd: browse('http://169.254.169.254/latest/meta-data/', 'auth', 'force'), check: has('status=403') },
  { id: 'BR7', what: 'browser: a denied file by file:// is not there', cmd: browse(`file://${BASE}/secrets/master.key`), check: (r) => (r.out.includes(CANARY) || r.out.includes('NO-BROWSER') || !/status=|error=/.test(r.out) ? r.out.slice(0, 300) : null) },
  // the plain commands of a run (config.ts, box-browser.ts): the script adds the flags and logs in through a relay
  { id: 'BR8', what: 'plain chromium --dump-dom of an allowed site works through the run proxy', cmd: 'chromium --headless --dump-dom https://registry.npmjs.org/chalk/latest 2>/dev/null', check: has('"name":"chalk"') },
  { id: 'BR9', what: 'plain chromium: a site not on the list stays refused', cmd: 'chromium --headless --dump-dom https://example.com/ 2>/dev/null; chromium --headless --dump-dom http://example.com/ 2>/dev/null; true', check: (r) => (r.out.includes('Example Domain') ? r.out.slice(0, 200) : null) },
  { id: 'BR10', what: 'plain chromium: the server port, a private address and metadata stay out of reach', cmd: 'for u in http://127.0.0.1:8099/ http://10.11.12.13/ http://169.254.169.254/latest/meta-data/; do chromium --headless --timeout=4000 --dump-dom "$u" 2>/dev/null; done; true', check: (r) => (r.out.includes(CANARY) ? r.out.slice(0, 200) : null) },
  { id: 'BR11', what: 'the browser commands and the relay are read-only in a run', cmd: 'R=$(dirname "$(command -v chromium)"); for f in chromium chrome browser-proxy-relay.cjs; do echo x >> "$R/$f" && echo WROTE; done; rm -f "$R/chromium" && echo WROTE; true', check: (r) => (r.out.includes('WROTE') ? r.out.slice(0, 200) : null) },
  { id: 'BR12', what: 'the proxy login is in no process argument while the browser and relay run', cmd: `chromium --headless --remote-debugging-port=0 about:blank >/dev/null 2>&1 & sleep 2; python3 -c "
import glob,os,urllib.parse
p=urllib.parse.unquote(urllib.parse.urlparse(os.environ['HTTPS_PROXY']).password)
n=0;hit=0
for f in glob.glob('/proc/[0-9]*/cmdline'):
    try: c=open(f,'rb').read()
    except OSError: continue
    if b'chrome-headless-shell' in c or b'browser-proxy-relay' in c: n+=1
    if c and p.encode() in c: hit+=1
print('procs',n>=2,'hits',hit)"; kill %1 2>/dev/null; true`, check: has('procs True hits 0') },
  // the sandbox has its own pid space: the same number names one of its own processes, never the server
  { id: 'A18', what: 'see the server process', cmd: `ps axww; cat /proc/${process.pid}/cmdline; ls /proc/${process.pid}/root/opt/mycel`, check: (r) => (r.out.includes('srt-attack.ts') ? 'the server process is visible' : null) },
  { id: 'A19', what: 'new namespaces, mount, chroot', cmd: 'unshare -U true || unshare -Urm true || mount -t tmpfs x /mnt || chroot / true', check: failsQuietly },
  { id: 'A20', what: 'a process left behind ends with the run', cmd: 'setsid nohup sleep 7777 >/dev/null 2>&1 & echo started', check: ok, after: () => { Bun.sleepSync(1000); return Bun.spawnSync(['pgrep', '-f', 'sleep 7777']).exitCode === 0 ? 'sleep 7777 still runs' : null } },
  // sites a person allows (always or once) and Full internet: the deny lists stay in force (docs/DECISIONS.md "Dev
  // environment: sites a person allows")
  { id: 'A12c', what: 'a site the person allowed works in her run', cmd: 'curl -fsS -m 20 -o /dev/null -w "%{http_code}" https://example.com/', check: both(ok, has('200')), o: { user: ['example.com'] } },
  { id: 'A12e', what: 'Full internet: a site on no list works', cmd: 'curl -fsS -m 20 -o /dev/null -w "%{http_code}" https://example.com/', check: both(ok, has('200')), o: { full: true } },
  { id: 'A13f', what: 'Full internet: metadata, private ranges, names that resolve inside, the VM address', cmd: 'curl -fsS -m 5 http://169.254.169.254/latest/meta-data/ || curl -fsS -m 5 http://10.11.12.13/ || curl -fsS -m 5 http://private.attack.test/ || curl -fsS -m 5 http://loop.attack.test:8099/ || curl -fsS -m 5 http://203.0.113.7/ || curl -fsS -m 5 http://metadata.google.internal/ || curl -fsS -m 5 http://[fd00::1]/ || curl -fsS -m 5 http://2852039166/ || curl -fsS -m 5 http://192.168.1.1/ || curl -fsS -m 5 http://100.64.0.1/', check: failsQuietly, o: { full: true } },
  { id: 'A14f', what: 'Full internet: the Trina server port and host name', cmd: 'curl -fsS -m 5 http://127.0.0.1:8099/ || curl -fsS -m 5 http://localhost:8099/ || curl -fsS -m 5 https://team.trina.test/ || curl -fsS -m 5 https://team.trina.test./ || curl -fsS -m 5 https://Team.Trina.Test../ || curl -fsS -m 5 --noproxy "*" https://1.1.1.1/', check: failsQuietly, o: { full: true } },
  { id: 'A27f', what: 'offline wins over Full internet and allowed sites', cmd: 'curl -fsS -m 10 -o /dev/null -w "%{http_code}" https://example.com/ || curl -fsS -m 10 -o /dev/null https://registry.npmjs.org/', check: failsQuietly, o: { network: 'offline', full: true, user: ['example.com'] } },
  { id: 'A27', what: 'offline: nothing, also the allowed sites', cmd: 'curl -fsS -m 10 -o /dev/null -w "%{http_code}" https://registry.npmjs.org/', check: failsQuietly, o: { network: 'offline' } },
  // ---- git between members (QA TC-4939): a run that makes a repository can write its hooks and config (srt protects
  // them only when .git is there as the run starts); another member's git must not run them ----
  { id: 'G1', what: 'erin makes a repository in the project folder and plants a pre-commit hook', o: { who: ERIN, start: 'projects/gitp' },
    cmd: `git init -q && printf '#!/bin/sh\\necho HOOK-RAN; touch "$HOME/.hook-was-here"; touch ${HOOK_MARK}; touch ${GMARK}\\n' > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit && echo PLANTED`,
    check: both(ok, has('PLANTED')), after: () => noExec(`${GITP}/.git/hooks/pre-commit`) },
  { id: 'G2', what: 'alice commits there: the hook does not run, nothing lands in her home', o: { start: 'projects/gitp' },
    cmd: 'git -c user.name=a -c user.email=a@example.com commit -q --allow-empty -m x && echo COMMITTED; git config core.hooksPath',
    check: both(ok, has('COMMITTED'), has('/dev/null'), (r) => (r.out.includes('HOOK-RAN') ? 'the hook ran' : null)),
    after: () => (fs.existsSync(HOOK_MARK) || fs.existsSync(path.join(PROJECT_HOME, '.hook-was-here')) ? 'the hook wrote alice\'s home' : null) },
  { id: 'G3', what: 'a filter driver planted in the repository\'s config: alice\'s git is refused (the wrapper), nothing runs', o: { start: 'projects/gitp' },
    before: () => fs.appendFileSync(`${GITP}/.git/config`, `[filter "x"]\n\tclean = touch ${GMARK}\n`),
    cmd: 'git status; echo CODE=$?', check: both(has('CODE=128'), gitRefused) },
  { id: 'G4', what: 'a repository made in a sub-folder in the same run, with a planted hook: git there runs no hook', o: { who: ERIN, start: 'projects/gitp' },
    before: () => fs.writeFileSync(`${GITP}/.git/config`, fs.readFileSync(`${GITP}/.git/config`, 'utf8').replace(/\[filter "x"\][^[]*/, '')),
    cmd: `mkdir -p sub && cd sub && git init -q && printf '#!/bin/sh\\ntouch ${HOOK_MARK}\\n' > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit && git -c user.name=e -c user.email=e@example.com commit -q --allow-empty -m x && echo SUBCOMMIT`,
    check: both(ok, has('SUBCOMMIT')), after: () => (fs.existsSync(HOOK_MARK) ? 'the sub-folder\'s hook ran' : null) },
  // the bypasses of the first version (review of #1297): each planted as erin's run could have, then alice's git there
  { id: 'G5', what: 'a section header and its setting on one line ([diff "x"] textconv = ...)', o: { start: 'projects/gitp', cwd: 'g5' },
    before: () => { const d = `${GITP}/g5`; hostGit(d, 'init', '-q'); fs.writeFileSync(`${d}/a.txt`, 'one\n'); fs.writeFileSync(`${d}/.gitattributes`, '*.txt diff=x\n'); hostGit(d, 'add', '.'); hostGit(d, '-c', 'user.name=e', '-c', 'user.email=e@example.com', 'commit', '-q', '-m', 'x'); fs.writeFileSync(`${d}/a.txt`, 'two\n'); fs.appendFileSync(`${d}/.git/config`, `[diff "x"] textconv = sh -c 'touch ${GMARK}; cat'\n`); sh(`chown -R ${SRV}:${SRV} ${GITP}`) },
    cmd: 'git diff; echo CODE=$?', check: gitRefused },
  { id: 'G6', what: 'a .git that is a link to a repository elsewhere in the folder', o: { start: 'projects/gitp', cwd: 'g6' },
    before: () => { hostGit(`${GITP}/g6real`, 'init', '-q'); fs.appendFileSync(`${GITP}/g6real/.git/config`, `[filter "f"]\n\tclean = touch ${GMARK}\n`); fs.mkdirSync(`${GITP}/g6`, { recursive: true }); fs.symlinkSync('../g6real/.git', `${GITP}/g6/.git`); sh(`chown -hR ${SRV}:${SRV} ${GITP}`) },
    cmd: 'git status; echo CODE=$?', check: gitRefused },
  { id: 'G7', what: 'a bare repository folder: not used by itself, and refused when named', o: { start: 'projects/gitp' },
    before: () => { hostGit(GITP, 'init', '-q', '--bare', 'g7.git'); fs.appendFileSync(`${GITP}/g7.git/config`, `[core]\n\talternateRefsCommand = touch ${GMARK}\n`) },
    cmd: 'cd g7.git && git log; echo CODE1=$?; cd .. && git --git-dir=g7.git log; echo CODE2=$?',
    check: both((r) => (/CODE1=0\b/.test(r.out) ? 'the bare repository was used by itself' : null), gitRefused) },
  { id: 'G8', what: 'submodule.<name>.update = !command', o: { start: 'projects/gitp', cwd: 'g8' },
    before: () => { hostGit(`${GITP}/g8`, 'init', '-q'); fs.appendFileSync(`${GITP}/g8/.git/config`, `[submodule "s"]\n\tupdate = !touch ${GMARK}\n`) },
    cmd: 'git status; echo CODE=$?', check: gitRefused },
  { id: 'G9', what: 'core.alternateRefsCommand and a "!" alias', o: { start: 'projects/gitp', cwd: 'g9' },
    before: () => { hostGit(`${GITP}/g9`, 'init', '-q'); fs.appendFileSync(`${GITP}/g9/.git/config`, `[core]\n\talternateRefsCommand = touch ${GMARK}\n[alias]\n\tst = !touch ${GMARK}\n`) },
    cmd: 'git st; echo CODE=$?', check: gitRefused },
  { id: 'G10', what: 'no depth limit: a repository twelve folders down, and an absorbed submodule\'s config', o: { start: 'projects/gitp', cwd: 'g10/a/b/c/d/e/f/g/h/i/j/k/l' },
    before: () => { const d = `${GITP}/g10/a/b/c/d/e/f/g/h/i/j/k/l`; hostGit(d, 'init', '-q'); fs.mkdirSync(`${d}/.git/modules/s`, { recursive: true }); fs.writeFileSync(`${d}/.git/modules/s/HEAD`, 'ref: refs/heads/main\n'); fs.writeFileSync(`${d}/.git/modules/s/config`, `[filter "f"]\n\tclean = touch ${GMARK}\n`); sh(`chown -R ${SRV}:${SRV} ${GITP}`) },
    cmd: 'git status; echo CODE=$?', check: gitRefused },
  { id: 'G11', what: 'a filter written by another member\'s job after the command started: the next git call is refused', o: { start: 'projects/gitp', cwd: 'g11', during: () => fs.appendFileSync(`${GITP}/g11/.git/config`, `[filter "f"]\n\tclean = touch ${GMARK}\n`) },
    before: () => hostGit(`${GITP}/g11`, 'init', '-q'),
    cmd: 'git status >/dev/null && echo FIRST-OK; sleep 4; git status; echo CODE=$?', check: both(has('FIRST-OK'), gitRefused) },
  // ---- the command line wins over core.hooksPath=/dev/null (QA TC-5348): erin's hooks (G1 and below) must not run in
  // alice's command whatever it sets. The guard is the exec bit on the disk (hook-sweep.ts), so /usr/bin/git (no wrapper) ----
  { id: 'G12', what: 'alice: git -c core.hooksPath=.git/hooks commit (the repro), with the wrapper and with /usr/bin/git', o: { start: 'projects/gitp' },
    cmd: `git ${GID} -c core.hooksPath=.git/hooks commit -q --allow-empty -m g12; /usr/bin/git ${GID} -c core.hooksPath=.git/hooks commit -q --allow-empty -m g12b && echo COMMITTED`,
    check: both(has('COMMITTED'), hookNotRun), after: () => (fs.existsSync(HOOK_MARK) ? 'the hook wrote alice\'s home' : null) },
  { id: 'G13', what: 'alice: GIT_CONFIG_COUNT/KEY/VALUE set by the command replace the run\'s settings', o: { start: 'projects/gitp' },
    cmd: `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=.git/hooks /usr/bin/git ${GID} commit -q --allow-empty -m g13 && echo COMMITTED`, check: both(has('COMMITTED'), hookNotRun) },
  { id: 'G14', what: 'alice: -c include.path naming a file of her own that sets core.hooksPath', o: { start: 'projects/gitp' },
    cmd: `printf '[core]\\n\\thooksPath = %s\\n' "$PWD/.git/hooks" > "$TMPDIR/inc" && /usr/bin/git -c include.path="$TMPDIR/inc" ${GID} commit -q --allow-empty -m g14 && echo COMMITTED`, check: both(has('COMMITTED'), hookNotRun) },
  { id: 'G15', what: 'alice: --config-env=core.hooksPath=<variable>', o: { start: 'projects/gitp' },
    cmd: `HP=.git/hooks /usr/bin/git --config-env=core.hooksPath=HP ${GID} commit -q --allow-empty -m g15 && echo COMMITTED`, check: both(has('COMMITTED'), hookNotRun) },
  { id: 'G16a', what: 'erin: a hooks folder in a sub-folder (tools/hooks), an ordinary script, a repository in other/, a bare repository, a link hook', o: { who: ERIN, start: 'projects/gitp' },
    cmd: `set -e; mk() { mkdir -p "$(dirname "$1")"; printf '#!/bin/sh\\necho HOOK-RAN; touch ${GMARK}\\n' > "$1"; chmod +x "$1"; }
mk tools/hooks/pre-commit; printf '#!/bin/sh\\necho BUILD-OK\\n' > build.sh; chmod +x build.sh
mkdir other && git -C other init -q && mk other/.git/hooks/pre-commit
git init -q --bare b.git && mk b.git/hooks/pre-receive && mk b.git/hooks/update && mk b.git/hooks/post-receive
mk scripts/run.sh && mkdir -p lnk && ln -s ../scripts/run.sh lnk/pre-commit
mk deep/a/b/c/d/e/f/g/h/i/j/COMMIT-MSG
ls -l tools/hooks/pre-commit build.sh && echo PLANTED`,
    check: both(ok, has('PLANTED')),
    // the hooks erin wrote in this command have no exec bit on the disk once it ended; her build.sh keeps it
    after: () => ['tools/hooks/pre-commit', 'other/.git/hooks/pre-commit', 'b.git/hooks/pre-receive', 'b.git/hooks/update', 'b.git/hooks/post-receive', 'scripts/run.sh', 'deep/a/b/c/d/e/f/g/h/i/j/COMMIT-MSG'].map((f) => noExec(`${GITP}/${f}`)).find((x) => x) ?? (fs.statSync(`${GITP}/build.sh`).mode & 0o100 ? null : 'an ordinary script lost its exec bit') },
  { id: 'G16', what: 'alice: core.hooksPath naming erin\'s sub-folder (tools/hooks) and a folder ten down by another letter case', o: { start: 'projects/gitp' },
    cmd: `/usr/bin/git -c core.hooksPath=tools/hooks ${GID} commit -q --allow-empty -m g16 && /usr/bin/git -c core.hooksPath=deep/a/b/c/d/e/f/g/h/i/j ${GID} commit -q --allow-empty -m g16b && echo COMMITTED`, check: both(has('COMMITTED'), hookNotRun) },
  { id: 'G17', what: 'alice: git -C into erin\'s other repository with its hooks', o: { start: 'projects/gitp' },
    cmd: `/usr/bin/git -C other -c core.hooksPath=.git/hooks ${GID} commit -q --allow-empty -m g17 && GIT_CONFIG_COUNT=0 /usr/bin/git -C other ${GID} commit -q --allow-empty -m g17b && echo COMMITTED`, check: both(has('COMMITTED'), hookNotRun) },
  { id: 'G18', what: 'alice: a push into erin\'s bare repository (pre-receive, update, post-receive), the run\'s settings dropped', o: { start: 'projects/gitp' },
    cmd: `cd "$TMPDIR" && rm -rf a18 && /usr/bin/git init -q a18 && cd a18 && /usr/bin/git ${GID} commit -q --allow-empty -m g18 && GIT_CONFIG_COUNT=0 /usr/bin/git push -q ${GITP}/b.git HEAD:refs/heads/main 2>&1; /usr/bin/git -c core.hooksPath=${GITP}/b.git/hooks push -q ${GITP}/b.git HEAD:refs/heads/two 2>&1; echo PUSHED`,
    check: both(has('PUSHED'), hookNotRun) },
  { id: 'G19', what: 'alice: --git-dir naming erin\'s bare repository with core.hooksPath at its hooks', o: { start: 'projects/gitp' },
    cmd: `/usr/bin/git --git-dir=b.git --work-tree=. -c core.hooksPath=b.git/hooks ${GID} commit -q --allow-empty -m g19 2>&1; echo DONE`, check: both(has('DONE'), hookNotRun) },
  { id: 'G20', what: 'alice: a hook that is a link to erin\'s executable script', o: { start: 'projects/gitp' },
    cmd: `/usr/bin/git -c core.hooksPath=lnk ${GID} commit -q --allow-empty -m g20 && echo COMMITTED`, check: both(has('COMMITTED'), hookNotRun) },
  { id: 'G21', what: 'legitimate work: erin\'s ordinary script runs, and a hook alice writes in her own command runs there', o: { start: 'projects/gitp' },
    cmd: `./build.sh && mkdir own21 && cd own21 && /usr/bin/git init -q && printf '#!/bin/sh\\necho OWN-HOOK-RAN\\n' > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit && /usr/bin/git -c core.hooksPath=.git/hooks ${GID} commit -q --allow-empty -m own`,
    check: both(ok, has('BUILD-OK'), has('OWN-HOOK-RAN'), hookNotRun) },
  // ---- independent review of #46 (variants R1-R4): each is written as the fix must behave ----
  { id: 'R1a', what: 'erin: an exec-only (0111) ELF hook (a copy of /bin/false) in tools2/hooks', o: { who: ERIN, start: 'projects/gitp' },
    cmd: `mkdir -p tools2/hooks && cp /bin/false tools2/hooks/pre-commit && chmod 0111 tools2/hooks/pre-commit && ls -l tools2/hooks/pre-commit && echo PLANTED`,
    check: both(ok, has('PLANTED')), after: () => noExec(`${GITP}/tools2/hooks/pre-commit`) },
  { id: 'R1b', what: 'alice: core.hooksPath=tools2/hooks: the exec-only hook does not run (it is /bin/false: running = commit fails)', o: { start: 'projects/gitp' },
    cmd: `/usr/bin/git -c core.hooksPath=tools2/hooks ${GID} commit -q --allow-empty -m r1 && echo COMMITTED; ls -l tools2/hooks/pre-commit`, check: has('COMMITTED') },
  { id: 'R2', what: 'alice: a hook in a folder her run only reads (shared/hk), made a hook by a Files rename that keeps the mode', o: { start: 'projects/gitp' },
    before: () => {
      fs.mkdirSync(`${TEAM}/shared/hk`, { recursive: true }); fs.writeFileSync(`${TEAM}/shared/hk/runner`, `#!/bin/sh\necho HOOK-RAN; touch ${GMARK}\n`, { mode: 0o755 }); sh(`chown -R ${SRV}:${SRV} ${TEAM}/shared/hk`)
      // as Files does (team-files/service.ts relocate, then hookSafe on what it moved)
      fs.renameSync(`${TEAM}/shared/hk/runner`, `${TEAM}/shared/hk/pre-commit`)
      const why = sweepAs({ entry: `${TEAM}/shared/hk/pre-commit`, visible: { read: [TEAM], deny: [`${TEAM}/users`] } }); if (why) throw new Error(why)
    },
    cmd: `ls -l ${TEAM}/shared/hk/pre-commit; /usr/bin/git -c core.hooksPath=${TEAM}/shared/hk ${GID} commit -q --allow-empty -m r2 && echo COMMITTED`, check: both(has('COMMITTED'), hookNotRun) },
  { id: 'R3', what: 'erin: a hook-named link to bob\'s personal script (users/bob, hidden from her): the sweep does not change it', o: { who: ERIN, start: 'projects/gitp' },
    before: () => { fs.mkdirSync(`${TEAM}/users/bob`, { recursive: true }); fs.writeFileSync(`${TEAM}/users/bob/tool.sh`, '#!/bin/sh\n', { mode: 0o755 }); sh(`chown -R ${SRV}:${SRV} ${TEAM}/users/bob`) },
    cmd: `cat ${TEAM}/users/bob/tool.sh; ln -s ${TEAM}/users/bob/tool.sh post-merge && echo LINKED`, check: has('LINKED'),
    after: () => (fs.statSync(`${TEAM}/users/bob/tool.sh`).mode & 0o111 ? null : 'the sweep took the exec bit of a file in bob\'s personal folder') },
  { id: 'R4', what: 'erin: a hard link from the project to a file outside it (srt mounts: EXDEV)', o: { who: ERIN, start: 'projects/gitp' },
    cmd: `ln ${TEAM}/shared/s.md pre-rebase 2>&1; ln /opt/mycel/package.json pre-auto-gc 2>&1; echo TRIED`, check: has('TRIED'),
    after: () => (fs.existsSync(`${GITP}/pre-rebase`) || fs.existsSync(`${GITP}/pre-auto-gc`) ? 'a hard link out of the project folder was made' : null) },
  // ---- round 2 of the review of #46: N1 (a Files move follows a link only to what the mover may read) and N2 (the
  // sweep when the server starts follows no link) ----
  { id: 'N1', what: 'erin: a folder with a hook-named link to a project she cannot open; she moves it in Files: that file keeps its exec bit', o: { who: ERIN, start: 'projects/gitp' },
    before: () => { fs.writeFileSync(`${DIR1}/deploy-n1.sh`, '#!/bin/sh\n', { mode: 0o755 }); sh(`chown ${SRV}:${SRV} ${DIR1}/deploy-n1.sh`) },
    cmd: `mkdir -p n1src && ln -s ${DIR1}/deploy-n1.sh n1src/pre-commit && echo LINKED`, check: has('LINKED'),
    after: () => {
      // as Files does: the move, then hookSafe with the mover's view (here: what erin's folder rules let her read)
      fs.renameSync(`${GITP}/n1src`, `${GITP}/n1dst`)
      const v = folderView(RULES, ERIN, { start: 'projects/gitp' })
      const abs = (r: string) => (r === '' ? TEAM : `${TEAM}/${r}`)
      const why = sweepAs({ entry: `${GITP}/n1dst`, visible: { read: [...v.read, ...v.write].map(abs).filter((p) => !p.startsWith(`${TEAM}/users`)), deny: v.denyRead.map(abs) } })
      if (why) return `the Files sweep failed: ${why}`
      return fs.statSync(`${DIR1}/deploy-n1.sh`).mode & 0o111 ? null : 'a Files move took the exec bit of a file in a project erin cannot open'
    } },
  { id: 'N2', what: 'the server starts: the whole team folder is swept, no link followed (bob\'s script R3 linked stays executable), a planted hook is not', o: { start: 'projects/gitp' },
    before: () => {
      fs.mkdirSync(`${GITP}/n2`, { recursive: true }); fs.writeFileSync(`${GITP}/n2/pre-push`, '#!/bin/sh\n', { mode: 0o755 }); sh(`chown -R ${SRV}:${SRV} ${GITP}/n2`)
      const why = sweepAs({ roots: [TEAM], visible: { read: [] } }); if (why) throw new Error(why)
    },
    cmd: 'true', check: ok,
    after: () => (!(fs.statSync(`${TEAM}/users/bob/tool.sh`).mode & 0o111) ? 'the start sweep took the exec bit of bob\'s personal script' : noExec(`${GITP}/n2/pre-push`)) },
  // the home of a project folder's runs is not the home of her own chats (review of #1297)
  { id: 'H1', what: 'alice\'s run in the project folder leaves a file in its home', o: { start: 'projects/gitp' },
    cmd: 'echo HOME=$HOME; touch $HOME/PLANTED-IN-PROJECT-HOME && echo PLANTED', check: both(ok, has(`HOME=${PROJECT_HOME}`), has('PLANTED')) },
  { id: 'H2', what: 'her own chat\'s run has another home: the file is not there', o: { work: true },
    cmd: 'echo HOME=$HOME; ls $HOME/PLANTED-IN-PROJECT-HOME 2>/dev/null && echo SEEN || echo NOT-SEEN', check: both(ok, has(`HOME=${personHome(BASE, ME)}`), has('NOT-SEEN')) },
  // ---- shared chats (docs/decisions/20261118-devenv-shared-chats.md): alice asks; what the run shows goes to everyone
  // who sees the chat, so it sees only what all of them may read, and nothing that is hers alone ----
  { id: 'S1', what: 'shared project chat: the project folder lists, reads and writes as alice may; HOME and TMPDIR are the command\'s own, the logs folder the chat\'s people\'s', cmd: `ls && cat index.html && cat docs/guide.md && echo made > docs/made.txt && cat docs/made.txt && mkdir -p docs/new && echo g > docs/new/g.md && echo HOME=$HOME && echo LOGS=$TRINA_LOGS && echo TMP=$TMPDIR && touch $TMPDIR/x && echo tmp-ok && touch $HOME/.cache-ok && echo home-ok`,
    check: both(ok, has('index.html'), has('web index'), has('web guide'), has('made'), has(`HOME=${chatHome(BASE, SP)}/attack`), has(`LOGS=${SP_LOGS}`), has(`TMP=${devenvPaths(BASE).runTmp}/attack`), has('tmp-ok'), has('home-ok'), noAsker), o: SPC,
    after: () => (!fs.existsSync(`${WEB}/docs/made.txt`) || !fs.existsSync(`${WEB}/docs/new/g.md`) ? 'a write in the project folder is not on the disk' : !fs.readdirSync(chatHome(BASE, SP)).some((d) => fs.existsSync(path.join(chatHome(BASE, SP), d, '.cache-ok'))) ? 'the command\'s home was not written' : fs.existsSync(path.join(personHome(BASE, ME), '.cache-ok')) ? 'the run wrote alice\'s own home' : null) },
  { id: 'S2', what: 'shared project chat: alice\'s own users/<id> folder and the project sub-folder only she may open are not there', cmd: `cat ${TEAM}/users/alice/key.txt; cat ${TEAM}/users/alice/todo.md; ls -a ${TEAM}/users ${TEAM}/users/alice; cat mine/secret.md; echo MINE: $(ls -A mine 2>&1); true`,
    check: both(ok, noAsker, (r) => (/MINE: .*secret/.test(r.out) ? `the sub-folder lists its files: ${r.out.slice(0, 300)}` : null)), o: SPC },
  { id: 'S3', what: 'shared project chat: no team folder outside the project folder (shared/, skills/, her group, another project she may open)', cmd: `cat ${TEAM}/shared/s.md; cat ${TEAM}/skills/rules.md; cat ${TEAM}/groups/marketing/brief.md; cat ${TEAM}/projects/one/readme.md; cat ${TEAM}/connected/nas/open.md; echo TEAM: $(ls -A ${TEAM} 2>/dev/null); echo PROJECTS: $(ls -A ${TEAM}/projects 2>/dev/null); true`,
    check: (r) => {
      if (r.code !== 0) return `exit code ${r.code}: ${r.out.slice(0, 300)}`
      const leak = ['shared text', 'skills text', 'marketing brief', 'hello from p1', 'nas open mirror'].find((t) => r.out.includes(t))
      if (leak) return `"${leak}" came back`
      const line = (k: string) => (r.out.split('\n').find((l) => l.startsWith(k + ':')) ?? '').slice(k.length + 1).trim().split(/\s+/).filter(Boolean)
      const bad = [...line('TEAM').filter((x) => x !== 'projects'), ...line('PROJECTS').filter((x) => x !== 'web')]
      return bad.length ? `listed outside the project folder: ${bad.join(' ')}` : null
    }, o: SPC },
  { id: 'S4', what: 'shared project chat: other chats\' work folders, homes and logs, alice\'s own home and logs, .system/', cmd: `cat ${chatWork(BASE, 'chat-2')}/x; cat ${chatHome(BASE, SO)}/x; cat ${chatLogs(BASE, SO)}/cmd.out; cat ${chatWork(BASE, SO)}/x; cat ${personHome(BASE, ME)}/.netrc; cat ${personLogs(BASE, ME)}/job.log; cat ${TEAM}/.system/history/old.bin; echo WORKS: $(ls -A ${devenvPaths(BASE).work} 2>/dev/null); echo CHOMES: $(ls -A ${devenvPaths(BASE).chatHome} 2>/dev/null); echo CLOGS: $(ls -A ${devenvPaths(BASE).chatLogs} 2>/dev/null); echo HOMES: $(ls -A ${devenvPaths(BASE).home} 2>/dev/null); echo LOGS: $(ls -A ${devenvPaths(BASE).logs} 2>/dev/null); true`,
    check: both(ok, noAsker, (r) => {
      const lines = r.out.split('\n').filter((l) => /^(WORKS|CHOMES|CLOGS|HOMES|LOGS):/.test(l))
      const bad = lines.flatMap((l) => l.replace(/^\w+:/, '').trim().split(/\s+/).filter((x) => x && x !== SP))
      return bad.length ? `listed: ${bad.join(' ')}` : null
    }), o: SPC },
  { id: 'S5', what: 'shared project chat: links planted in the project folder pointing out (her own folder, her sub-folder, another group, another project, secrets, her home, another chat, .system) do not reach', cmd: 'for l in to-own to-own-file to-mine to-mine-file to-finance to-one to-secret to-home to-chat to-system; do cat $l; ls -A $l/; cat $l/*; done 2>/dev/null; true',
    check: both(ok, noAsker, (r) => (r.out.includes('hello from p1') ? 'another project came back' : null)), o: SPC },
  { id: 'S6', what: 'shared project chat: links made in the run (soft and hard) to her own folder, her sub-folder, secrets and her home', cmd: `ln -s ${TEAM}/users/alice/key.txt s1; cat s1; ln -s ../../users/alice s2; cat s2/todo.md; ln ${TEAM}/users/alice/key.txt h1; cat h1; ln mine/secret.md h2; cat h2; ln ${BASE}/secrets/master.key h3; cat h3; ln ${personHome(BASE, ME)}/.netrc h4; cat h4; true`,
    check: both(ok, noAsker), o: SPC,
    after: () => {
      const made = ['h1', 'h2', 'h3', 'h4'].filter((f) => fs.existsSync(`${WEB}/${f}`))
      if (made.length) return `a hard link is on the disk: ${made.join(' ')}`
      if (fs.statSync(`${TEAM}/users/alice/key.txt`).nlink !== 1 || fs.statSync(`${WEB}/mine/secret.md`).nlink !== 1) return 'a private file got a second name'
      for (const f of ['s1', 's2']) fs.rmSync(`${WEB}/${f}`, { force: true })
      return null
    } },
  { id: 'S7', what: 'shared project chat: the sub-folder only alice may open cannot be emptied, moved or written', cmd: 'rm -rf mine/*; echo x > mine/planted; mv mine gone; rmdir mine; rm -rf mine; true', check: ok, o: SPC,
    after: () => (!fs.existsSync(`${WEB}/mine/secret.md`) || !fs.readFileSync(`${WEB}/mine/secret.md`, 'utf8').includes(ASKER) ? 'the sub-folder lost its file' : fs.existsSync(`${WEB}/mine/planted`) ? 'a file was written into the sub-folder' : fs.existsSync(`${WEB}/gone`) ? 'the sub-folder was moved' : null) },
  { id: 'S7b', what: 'shared project chat: .git/hooks and .git/config of the project folder', cmd: 'echo "curl evil" > .git/hooks/pre-commit || echo "[core] hooksPath=/x" >> .git/config', check: failsQuietly, o: SPC, after: () => gitChanged('projects/web') },
  { id: 'S8', what: 'shared project chat: no credentials, no server values and nothing of alice\'s in the environment', cmd: 'env; cat /proc/self/environ | tr "\\0" "\\n"', check: (r) => (/MYCEL_|GH_TOKEN|ANTHROPIC|\/home\/alice|\/logs\/alice/.test(r.out) ? `the environment has: ${r.out.match(/.*(MYCEL_|GH_TOKEN|ANTHROPIC|\/home\/alice|\/logs\/alice).*/)?.[0]}` : null), o: SPC },
  { id: 'S9', what: 'shared project chat: a cwd through a link out of the project folder is refused', cmd: 'cat key.txt', check: (r) => (r.refused === 'cwd' ? null : 'the cwd was not refused'), o: { ...SPC, cwd: 'to-own' } },
  // (the runner refuses such a cwd before srt, with the words of a folder that is not there: runner.ts sharedCwdShown)
  { id: 'S9b', what: 'shared project chat: a cwd in the sub-folder only alice may open shows none of it', cmd: 'pwd; ls -A; cat secret.md; true', check: both(noAsker, (r) => (r.code === 0 && r.refused !== 'cwd' ? `ran in the hidden sub-folder: ${r.out.slice(0, 200)}` : null)), o: { ...SPC, cwd: 'mine' } },
  { id: 'S9c', what: 'shared project chat: a cwd through a link to that sub-folder shows none of it', cmd: 'pwd; ls -A; cat secret.md; true', check: both(noAsker, (r) => (r.code === 0 && r.refused !== 'cwd' ? `ran in the hidden sub-folder: ${r.out.slice(0, 200)}` : null)), o: { ...SPC, cwd: 'to-mine' } },
  // QA TC-4945: the project folder holds mine (alice's alone), so it is given entry by entry (srt/mounts.ts): mine is
  // not listed, not even empty; a sub-folder stays writable; the top cannot change (what is made there is not kept,
  // an entry there cannot be moved), its files are read-only; .git is read-only
  { id: 'S16', what: 'shared project chat: a project sub-folder only alice may open is not listed, not even empty; the rest of the folder works (QA TC-4945)', cmd: 'echo LS: $(ls -A); echo MI: $(grep -c /mine /proc/self/mountinfo); ls -A docs; echo top > top-new.txt; echo sub > docs/sub-new.txt && echo SUB-OK; mv index.html moved.html; echo x >> index.html; cat mine/secret.md; stat mine; touch .git/x; true',
    check: both(ok, noAsker, has('SUB-OK'), has('guide.md'), (r) => {
      const ls = (r.out.split('\n').find((l) => l.startsWith('LS:')) ?? '').slice(3).trim().split(/\s+/)
      if (ls.includes('mine')) return `the sub-folder only alice may open is listed: ${ls.join(' ')}`
      if (!ls.includes('index.html') || !ls.includes('docs')) return `the project folder does not list its entries: ${ls.join(' ')}`
      if (ls.includes('.git')) return '.git is given in a folder that holds a hidden one'
      if (!/^MI: 0$/m.test(r.out)) return `the hidden folder is a mount in the run: ${(r.out.match(/^MI:.*$/m) ?? [''])[0]}`
      return null
    }), o: SPC,
    after: () => {
      if (!fs.existsSync(`${WEB}/docs/sub-new.txt`)) return 'a write in a sub-folder is not on the disk'
      if (fs.existsSync(`${WEB}/top-new.txt`)) return 'a new file at the top of the folder was written to the disk'
      if (fs.existsSync(`${WEB}/moved.html`) || !fs.existsSync(`${WEB}/index.html`)) return 'an entry at the top was moved'
      if (fs.readFileSync(`${WEB}/index.html`, 'utf8') !== 'web index\n') return 'a file at the top was written'
      if (fs.existsSync(`${WEB}/.git/x`)) return '.git was written'
      fs.rmSync(`${WEB}/docs/sub-new.txt`, { force: true }); fs.rmSync(`${WEB}/top-new.txt`, { force: true })
      return null
    } },
  { id: 'S17', what: 'shared project chat: a read-only folder that holds a writable one and a hidden one is opened too; its git history is not there (QA TC-4945 review)', cmd: 'echo LS: $(ls -A); echo MI: $(grep -c /hid /proc/self/mountinfo); git status 2>&1; git show HEAD:hid/pay.md 2>&1; git log --stat 2>&1 | head -20; cat .git/HEAD 2>&1; echo w > w/new.txt && echo W-OK; cat readme.md; true',
    check: both(ok, noAsker, has('W-OK'), has('mix readme'), (r) => {
      const ls = (r.out.split('\n').find((l) => l.startsWith('LS:')) ?? '').slice(3).trim().split(/\s+/)
      if (ls.includes('hid') || ls.includes('.git')) return `listed: ${ls.join(' ')}`
      if (!/^MI: 0$/m.test(r.out)) return 'the hidden folder is a mount in the run'
      return /hid\/pay\.md|mix-hid/.test(r.out) ? `git told of the hidden folder: ${r.out.slice(0, 300)}` : null
    }), o: { shared: { chat: SP, within: 'projects/mix', audience: [ALICE, DAVE] } },
    after: () => { const f = `${TEAM}/projects/mix/w/new.txt`; if (!fs.existsSync(f)) return 'a write in the writable sub-folder is not on the disk'; fs.rmSync(f); return null } },
  // the guard stops the command with 97 and its own words (srt/mounts.ts entryGuard)
  { id: 'S18', what: 'shared project chat: a sub-folder swapped for a link to the hidden folder after the listing stops the command before it runs (QA TC-4945 review)', cmd: 'echo RAN; cat docs/secret.md; ls -A docs; true',
    check: both(noAsker, (r) => (r.out.includes('RAN') ? `the command ran: ${r.out.slice(0, 200)}` : r.code !== 97 || !r.out.includes('a folder changed while it started') ? `not stopped by the guard (exit ${r.code}): ${r.out.slice(0, 200)}` : null)),
    o: { ...SPC, afterPins: () => { fs.renameSync(`${WEB}/docs`, `${WEB}/docs-was`); fs.symlinkSync(`${WEB}/mine`, `${WEB}/docs`) } },
    after: () => { fs.rmSync(`${WEB}/docs`); fs.renameSync(`${WEB}/docs-was`, `${WEB}/docs`); return null } },
  // a writable folder the view gave already, inside an opened one (projects/mix/w): pinned too
  { id: 'S18b', what: 'shared project chat: the writable sub-folder of an opened folder swapped for a link to the hidden folder stops the command (QA TC-4945 re-review)', cmd: 'echo RAN; cat w/pay.md; echo x > w/planted; true',
    check: both(noAsker, (r) => (r.out.includes('RAN') ? `the command ran: ${r.out.slice(0, 200)}` : r.code !== 97 || !r.out.includes('a folder changed while it started') ? `not stopped by the guard (exit ${r.code}): ${r.out.slice(0, 200)}` : null)),
    o: { shared: { chat: SP, within: 'projects/mix', audience: [ALICE, DAVE] }, afterPins: () => { fs.renameSync(`${TEAM}/projects/mix/w`, `${TEAM}/projects/mix/w-was`); fs.symlinkSync(`${TEAM}/projects/mix/hid`, `${TEAM}/projects/mix/w`) } },
    after: () => {
      const planted = fs.existsSync(`${TEAM}/projects/mix/hid/planted`)
      fs.rmSync(`${TEAM}/projects/mix/w`); fs.renameSync(`${TEAM}/projects/mix/w-was`, `${TEAM}/projects/mix/w`)
      return planted ? 'the hidden folder was written through the link' : null
    } },
  // a bare repository beside the hidden folder (web.git/): not given either
  { id: 'S19', what: 'shared project chat: a bare git repository in a folder that holds a hidden one is not there (QA TC-4945 re-review)', cmd: 'echo LS: $(ls -A); git --git-dir=mix.git log --stat 2>&1 | head; true',
    check: both(ok, noAsker, (r) => (/^LS:.*\bmix\.git\b/m.test(r.out) || /hid\/pay\.md/.test(r.out) ? `the bare repository is there: ${r.out.slice(0, 300)}` : null)),
    o: { shared: { chat: SP, within: 'projects/mix', audience: [ALICE, DAVE] } } },
  { id: 'S10', what: 'chat shared with people: the work folder writes; folders everyone in the chat may open read; HOME is the chat\'s', cmd: `pwd && echo w > w.txt && cat w.txt && cat ${TEAM}/shared/s.md && cat ${TEAM}/skills/rules.md && cat ${TEAM}/groups/marketing/brief.md && echo HOME=$HOME && echo WORK=$TRINA_WORK`,
    check: both(ok, has(SW_WORK), has('shared text'), has('skills text'), has('marketing brief'), has(`HOME=${chatHome(BASE, SW)}/attack`), has(`WORK=${SW_WORK}\n`), noAsker), o: SWC,
    after: () => (!fs.existsSync(path.join(SW_WORK, 'w.txt')) ? 'w.txt is not in the work folder' : fs.existsSync(path.join(chatWork(BASE, SW), 'w.txt')) ? 'w.txt went into the private work folder' : null) },
  { id: 'S11', what: 'chat shared with people: alice\'s own folder, the chat\'s private work folder and one of an earlier audience, a project erin may not open, a folder limited inside the group, another group, .system, other chats, alice\'s home', cmd: `cat ${TEAM}/users/alice/key.txt; cat ${TEAM}/users/alice/todo.md; ls -A ${TEAM}/users; cat ${TEAM}/projects/one/readme.md; cat ${TEAM}/projects/web/index.html; cat ${TEAM}/projects/web/mine/secret.md; cat ${TEAM}/groups/marketing/salaries/2026.md; cat ${TEAM}/groups/finance/budget.md; cat ${TEAM}/.system/history/old.bin; cat ${chatWork(BASE, 'chat-2')}/x; cat ${chatWork(BASE, SO)}/x; cat ${chatWork(BASE, SW)}/x; cat ${sharedWork(BASE, SW, sharedWorkKey([ME]))}/x; cat x; ls -A ${devenvPaths(BASE).workShared}/${SW}; cat ${personHome(BASE, ME)}/.netrc; cat ${personLogs(BASE, ME)}/job.log; ln -s ${TEAM}/users/alice/key.txt l1; cat l1; ln ${TEAM}/users/alice/key.txt l2; cat l2; true`,
    check: both(ok, noAsker, (r) => (r.out.includes('hello from p1') || r.out.includes('web index') ? 'a project erin may not open came back' : null)), o: SWC },
  { id: 'S12', what: 'chat shared with people: the shared folders, her group folder and her own folder are read-only', cmd: `echo x >> ${TEAM}/shared/s.md || echo x > ${TEAM}/shared/new2.md || echo x >> ${TEAM}/groups/marketing/brief.md || echo evil > ${TEAM}/shared/repo/.git/hooks/pre-commit || echo '{}' > ${TEAM}/shared/repo/package.json || mkdir ${TEAM}/shared/dir2 || echo x > ${TEAM}/users/alice/z2.md`, check: failsQuietly, o: SWC,
    after: () => (fs.readFileSync(`${TEAM}/shared/s.md`, 'utf8') !== 'shared text\n' || fs.existsSync(`${TEAM}/shared/new2.md`) || fs.readFileSync(`${TEAM}/groups/marketing/brief.md`, 'utf8') !== 'marketing brief\n' || fs.existsSync(`${TEAM}/shared/dir2`) || fs.existsSync(`${TEAM}/users/alice/z2.md`) || fs.readFileSync(`${TEAM}/shared/repo/package.json`, 'utf8') === '{}\n' ? 'a team folder changed' : gitChanged('shared/repo')) },
  { id: 'S14', what: 'shared project chat: the parent of TMPDIR (devenv/rt) and another run\'s temp folder there: not listed, not read, not written', cmd: `echo SELF: $(basename $TMPDIR); echo FSTYPE: $(stat -f -c %T $(dirname $TMPDIR)); echo PARENT: $(ls -A $(dirname $TMPDIR) 2>/dev/null); ls -A ${devenvPaths(BASE).runTmp}; cat ${RT_SIB}/marker; touch ${RT_SIB}/t && echo TOUCHED-SIB; mkdir ${RT_SIB}/d && echo TOUCHED-SIB; touch $(dirname $TMPDIR)/p && echo TOUCHED-PARENT; mkdir $(dirname $TMPDIR)/newrun && echo TOUCHED-PARENT; true`,
    check: both(ok, (r) => (/TOUCHED-SIB/.test(r.out) ? `the sibling temp folder was written: ${r.out.slice(0, 300)}` : null),
      // srt shows the way to its own temp folder as a folder of the sandbox only: a write there must reach no disk (after)
      (r) => (/TOUCHED-PARENT/.test(r.out) && !/^FSTYPE: tmpfs$/m.test(r.out) ? `the parent of TMPDIR is writable and not the sandbox's tmpfs: ${r.out.slice(0, 300)}` : null), (r) => {
      const line = (k: string) => (r.out.split('\n').find((l) => l.startsWith(k + ':')) ?? '').slice(k.length + 1).trim().split(/\s+/).filter(Boolean)
      // only the path to its own temp folder (srt shows the folders on the way to an allowed one), never another run's
      const self = line('SELF')[0] ?? '', bad = line('PARENT').filter((x) => x !== self)
      return bad.length ? `the parent of TMPDIR lists: ${r.out.slice(0, 300)}` : null
    }), o: SPC,
    after: () => (fs.existsSync(path.join(RT_SIB, 't')) || fs.existsSync(path.join(RT_SIB, 'd')) ? 'the sibling temp folder was written' : fs.existsSync(path.join(devenvPaths(BASE).runTmp, 'p')) || fs.existsSync(path.join(devenvPaths(BASE).runTmp, 'newrun')) ? 'the parent of TMPDIR was written' : fs.readFileSync(path.join(RT_SIB, 'marker'), 'utf8') !== `${CANARY}-rt-sibling` ? 'the marker changed' : null) },
  { id: 'S14b', what: 'chat shared with people: the parent of TMPDIR and another run\'s temp folder: not listed, not read, not written', cmd: `echo SELF: $(basename $TMPDIR); echo FSTYPE: $(stat -f -c %T $(dirname $TMPDIR)); echo PARENT: $(ls -A $(dirname $TMPDIR) 2>/dev/null); ls -A ${devenvPaths(BASE).runTmp}; cat ${RT_SIB}/marker; touch ${RT_SIB}/t && echo TOUCHED-SIB; mkdir ${RT_SIB}/d && echo TOUCHED-SIB; touch $(dirname $TMPDIR)/p && echo TOUCHED-PARENT; mkdir $(dirname $TMPDIR)/newrun && echo TOUCHED-PARENT; true`,
    check: both(ok, (r) => (/TOUCHED-SIB/.test(r.out) ? `the sibling temp folder was written: ${r.out.slice(0, 300)}` : null),
      // srt shows the way to its own temp folder as a folder of the sandbox only: a write there must reach no disk (after)
      (r) => (/TOUCHED-PARENT/.test(r.out) && !/^FSTYPE: tmpfs$/m.test(r.out) ? `the parent of TMPDIR is writable and not the sandbox's tmpfs: ${r.out.slice(0, 300)}` : null), (r) => {
      const line = (k: string) => (r.out.split('\n').find((l) => l.startsWith(k + ':')) ?? '').slice(k.length + 1).trim().split(/\s+/).filter(Boolean)
      // only the path to its own temp folder (srt shows the folders on the way to an allowed one), never another run's
      const self = line('SELF')[0] ?? '', bad = line('PARENT').filter((x) => x !== self)
      return bad.length ? `the parent of TMPDIR lists: ${r.out.slice(0, 300)}` : null
    }), o: SWC,
    after: () => (fs.existsSync(path.join(RT_SIB, 't')) || fs.existsSync(path.join(RT_SIB, 'd')) ? 'the sibling temp folder was written' : fs.existsSync(path.join(devenvPaths(BASE).runTmp, 'p')) || fs.existsSync(path.join(devenvPaths(BASE).runTmp, 'newrun')) ? 'the parent of TMPDIR was written' : fs.readFileSync(path.join(RT_SIB, 'marker'), 'utf8') !== `${CANARY}-rt-sibling` ? 'the marker changed' : null) },
  { id: 'S14', what: 'chat shared with people: a folder of her group only alice may open, and a limited one nobody may, are not even listed (QA TC-4929)', cmd: `ls -A ${TEAM}/groups/marketing; ls -A ${TEAM}/shared; ls -A ${TEAM}; cat ${TEAM}/groups/marketing/hr-alicealone/pay.md; true`,
    check: both(ok, noAsker, has('brief.md'), has('s.md'), (r) => ((o) => (/hr-alicealone|hr-limited/.test(o) ? `a folder they may not all open is listed: ${o.slice(0, 300)}` : null))(typedNotThere(r.out, `${TEAM}/groups/marketing/hr-alicealone/pay.md`))), o: SWC },
  { id: 'S13', what: 'chat shared with people: no credentials and nothing of alice\'s in the environment', cmd: 'env; cat /proc/self/environ | tr "\\0" "\\n"', check: (r) => (/MYCEL_|GH_TOKEN|ANTHROPIC|\/home\/alice|\/logs\/alice/.test(r.out) ? 'the environment has a value it must not' : null), o: SWC },
  // jobs and dev servers of shared chats (docs/decisions/20261118-devenv-shared-jobs-mac-localhost.md, QA TC-4989): a
  // command reads the job logs of its chat's people, never those of another audience of the same chat, and writes none
  { id: 'S16', what: 'shared project chat: $TRINA_LOGS is the folder of the chat\'s people (a job\'s log there reads); another audience\'s logs of the same chat do not, and are not listed', cmd: `echo LOGS=$TRINA_LOGS; cat $TRINA_LOGS/build.log; cat ${SP_LOGS_OTHER}/build.log; echo LIST: $(ls -A ${chatLogs(BASE, SP)} 2>&1); ls -A ${SP_LOGS_OTHER}; true`,
    check: both(ok, has(`LOGS=${SP_LOGS}`), has('JOB-LOG-OF-THESE-PEOPLE'), (r) => ((o) => (o.includes(path.basename(SP_LOGS_OTHER)) ? `the other audience's logs folder is listed: ${o.slice(0, 300)}` : null))(typedNotThere(r.out, `${SP_LOGS_OTHER}/build.log`, SP_LOGS_OTHER))), o: SPC },
  { id: 'S16b', what: 'shared project chat: the logs folder is read-only in a run (no planted log for the next command)', cmd: 'echo planted > $TRINA_LOGS/build.log || echo planted > $TRINA_LOGS/new.log || rm -f $TRINA_LOGS/build.log', check: failsQuietly, o: SPC,
    after: () => (fs.readFileSync(path.join(SP_LOGS, 'build.log'), 'utf8') !== 'JOB-LOG-OF-THESE-PEOPLE\n' || fs.existsSync(path.join(SP_LOGS, 'new.log')) ? 'the logs folder changed' : null) },
  { id: 'S16c', what: 'chat shared with people: another chat\'s job logs, and her own private runs see no shared chat\'s logs', cmd: `cat ${SP_LOGS}/build.log; ls -A ${devenvPaths(BASE).chatLogs}; true`, check: both(ok, (r) => (r.out.includes('JOB-LOG-OF-THESE-PEOPLE') ? 'another chat\'s job log was read' : null)), o: SWC },
  { id: 'S16d', what: 'her own chat: no shared chat\'s job logs', cmd: `cat ${SP_LOGS}/build.log; ls -A ${devenvPaths(BASE).chatLogs}; true`, check: both(ok, (r) => (r.out.includes('JOB-LOG-OF-THESE-PEOPLE') || typedNotThere(r.out, `${SP_LOGS}/build.log`).includes(SP) ? `a shared chat's logs were seen: ${r.out.slice(0, 300)}` : null)) },
  // ---- variants of the independent review of PR #1372: nested opened folders, srt's places, raw listings, the cwd
  // without the suite's copy of the runner's refusal (bwrap itself) ----
  { id: 'RV1', what: 'nested read-only folder given entry by entry (shared/deep holds hr-deep): a new file at its top', cmd: `echo x > ${TEAM}/shared/deep/new.md || mkdir ${TEAM}/shared/deep/d2`, check: failsQuietly, o: SWC },
  { id: 'RV1b', what: 'shared/deep listing does not show hr-deep (raw, no filter)', cmd: `ls -A ${TEAM}/shared/deep; ls -lA ${TEAM}/shared/deep; true`, check: both(ok, has('ok.md'), (r) => (r.out.includes('hr-deep') ? `hr-deep shown: ${r.out.slice(0, 300)}` : null)), o: SWC },
  { id: 'RV1c', what: 'group folder (read-only, holds hidden ones): a new file at its top', cmd: `echo x > ${TEAM}/groups/marketing/new.md || mkdir ${TEAM}/groups/marketing/d2`, check: failsQuietly, o: SWC },
  { id: 'RV1d', what: 'ancestor places (team root, groups/): a new file or folder', cmd: `echo x > ${TEAM}/new-root.md || mkdir ${TEAM}/groups/newg || echo x > ${TEAM}/groups/new.md`, check: failsQuietly, o: SWC },
  // the lock is not a boundary (mounts.ts entryGuard): the sandbox's user owns the place and may give the write bit
  // back. What it then makes there stays in the sandbox's tmpfs: never on the disk, never seen by anyone else
  { id: 'RV2', what: 'the sandbox user gives a locked place its write bit back and writes: nothing reaches the disk', cmd: `chmod u+w ${TEAM}/shared && echo x > ${TEAM}/shared/new3.md && ls -ld ${TEAM}/shared && echo WROTE; true`, check: ok, o: SWC,
    after: () => (fs.existsSync(`${TEAM}/shared/new3.md`) ? 'reached the disk' : null) },
  { id: 'RV2b', what: 'mode and owner of the locked top in the sandbox', cmd: `stat -c '%A %u %g %n' ${TEAM}/shared ${TEAM}/shared/deep ${TEAM} ${TEAM}/groups/marketing; id; true`, check: () => null, o: SWC },
  { id: 'RV3', what: 'hidden vs not-there look the same in errors (ls/cat/stat/cd)', cmd: `for p in groups/marketing/hr-alicealone groups/marketing/nope-xyzzyx shared/hr-limited shared/nope-abcdefg shared/deep/hr-deep shared/deep/nope-qq; do echo "== $p"; ls -A ${TEAM}/$p 2>&1; cat ${TEAM}/$p/pay.md 2>&1; stat ${TEAM}/$p 2>&1 | head -1; (cd ${TEAM}/$p) 2>&1; touch ${TEAM}/$p/t 2>&1; done; true`,
    check: (r) => {
      const sec: Record<string, string> = {}
      for (const part of r.out.split('== ').slice(1)) { const [h, ...rest] = part.split('\n'); sec[h.trim()] = rest.join('\n').split(h.trim()).join('P') }
      const pairs = [['groups/marketing/hr-alicealone', 'groups/marketing/nope-xyzzyx'], ['shared/hr-limited', 'shared/nope-abcdefg'], ['shared/deep/hr-deep', 'shared/deep/nope-qq']]
      const bad = pairs.filter(([a, b]) => sec[a] !== sec[b])
      return bad.length ? `existence oracle: ${bad.map(([a, b]) => `${a}=[${sec[a]}] vs ${b}=[${sec[b]}]`).join(' | ').slice(0, 900)}` : null
    }, o: SWC },
  { id: 'RV4', what: 'other listers on the parents (find, du, ls -lR, rg --files) show no hidden name, raw output', cmd: `ls -lAR ${TEAM}/groups/marketing ${TEAM}/shared 2>&1; find ${TEAM}/groups/marketing ${TEAM}/shared 2>&1; du -a ${TEAM}/shared 2>&1; rg --files ${TEAM}/shared ${TEAM}/groups/marketing 2>&1; true`,
    check: (r) => (/hr-alicealone|hr-limited|hr-deep|salaries/.test(r.out) ? `a hidden name in raw output: ${r.out.split('\n').filter((l) => /hr-alicealone|hr-limited|hr-deep|salaries/.test(l)).slice(0, 5).join(' / ')}` : null), o: SWC },
  { id: 'RV5', what: 'S9b without the suite\'s cwd copy: bwrap itself, cwd in the hidden sub-folder', cmd: 'pwd; ls -A; cat secret.md; ls -A ..; true', check: (r) => (r.out.includes(ASKER) || /^secret\.md$/m.test(r.out) ? `hidden content: ${r.out.slice(0, 300)}` : null), o: { ...SPC, cwd: 'mine', rawCwd: true } },
  { id: 'RV5b', what: 'S9c without the copy: cwd through a link', cmd: 'pwd; ls -A; cat secret.md; true', check: (r) => (r.out.includes(ASKER) || /^secret\.md$/m.test(r.out) ? `hidden content: ${r.out.slice(0, 300)}` : null), o: { ...SPC, cwd: 'to-mine', rawCwd: true } },
  // a new file there is refused with an error the AI can read (keeping it is QA TC-5209)
  { id: 'RV6', what: 'shared project chat: a new file at the top of the writable project folder that holds a hidden one fails loudly', cmd: `echo x > ${WEB}/rv6.md && echo WROTE-RV6`, check: both(failsQuietly, has('Permission denied')), o: SPC,
    after: () => (fs.existsSync(`${WEB}/rv6.md`) ? 'rv6.md reached the disk' : null) },
  { id: 'RV7', what: 'S16 raw: the other audience\'s logs key in the LIST line only', cmd: `echo LIST: $(ls -A ${chatLogs(BASE, SP)} 2>&1); ls -lA ${chatLogs(BASE, SP)} 2>&1; find ${chatLogs(BASE, SP)} 2>&1; true`, check: (r) => (r.out.includes(path.basename(SP_LOGS_OTHER)) ? `other key: ${r.out.slice(0, 400)}` : null), o: SPC },
  { id: 'RV8', what: 'S16d raw: her own chat lists no shared chat logs', cmd: `ls -lA ${devenvPaths(BASE).chatLogs} 2>&1; find ${devenvPaths(BASE).chatLogs} 2>&1; ls -A ${path.dirname(devenvPaths(BASE).chatLogs)} 2>&1; true`, check: (r) => (r.out.includes(SP) ? `shared chat id seen: ${r.out.slice(0, 400)}` : null) },
  // ---- second review of PR #1372: legitimate writes still reach the disk (RW1-RW3); srt's masks over hidden folders
  // and its places take no silent write, in shared and private runs (RW4, RW4b, RW5); RW6 shows the modes ----
  { id: 'RW1', what: 'shared project chat, writable project folder given whole (projects/gitp, no hidden sub-folder): a new file and folder at its top write and reach the disk', cmd: `echo rw1 > ${TEAM}/projects/gitp/rw1.md && mkdir ${TEAM}/projects/gitp/rw1d && echo rw1b > ${TEAM}/projects/gitp/rw1d/f.md && echo OK-RW1`, check: both(ok, has('OK-RW1')), o: GITPC,
    after: () => { const r = fs.existsSync(`${TEAM}/projects/gitp/rw1.md`) && fs.existsSync(`${TEAM}/projects/gitp/rw1d/f.md`) ? null : 'a legitimate write did not reach the disk'; fs.rmSync(`${TEAM}/projects/gitp/rw1.md`, { force: true }); fs.rmSync(`${TEAM}/projects/gitp/rw1d`, { recursive: true, force: true }); return r } },
  { id: 'RW2', what: 'shared project chat with a hidden sub-folder: a writable sub-folder of the opened folder (projects/web/docs) still writes to disk', cmd: `echo rw2 > ${WEB}/docs/rw2.md && mkdir -p ${WEB}/docs/rw2d/x && echo OK-RW2`, check: both(ok, has('OK-RW2')), o: SPC,
    after: () => { const r = fs.existsSync(`${WEB}/docs/rw2.md`) && fs.existsSync(`${WEB}/docs/rw2d/x`) ? null : 'a legitimate write did not reach the disk'; fs.rmSync(`${WEB}/docs/rw2.md`, { force: true }); fs.rmSync(`${WEB}/docs/rw2d`, { recursive: true, force: true }); return r } },
  { id: 'RW3', what: 'chat shared with people: the work folder and TMPDIR and HOME still write', cmd: 'echo a > rw3.txt && echo b > $TMPDIR/rw3 && echo c > $HOME/rw3 && echo OK-RW3', check: both(ok, has('OK-RW3')), o: SWC },
  { id: 'RW4', what: 'denied mount points and hidden places: users/bob, .system, salaries, hr-alicealone, a hidden skills place: no silent write', cmd: `echo x > ${TEAM}/users/bob/rw4.md || echo x > ${TEAM}/.system/rw4.md || mkdir ${TEAM}/users/rw4u || echo x > ${TEAM}/groups/marketing/salaries/rw4 || echo x > ${TEAM}/groups/marketing/hr-alicealone/rw4 || echo x > ${TEAM}/projects/rw4.md || mkdir ${TEAM}/projects/web/mine || echo x > ${TEAM}/projects/web/mine/rw4`, check: failsQuietly, o: SWC },
  { id: 'RW4b', what: 'same in the shared project chat', cmd: `echo x > ${TEAM}/users/bob/rw4.md || echo x > ${TEAM}/.system/rw4.md || echo x > ${TEAM}/projects/rw4.md || mkdir ${WEB}/mine || echo x > ${WEB}/mine/rw4 || echo x > ${TEAM}/rw4.md || mkdir ${TEAM}/shared`, check: failsQuietly, o: SPC },
  { id: 'RW5', what: 'admin in a chat shared only with herself as audience (team root given whole, read-only): denied users/ places do not take silent writes', cmd: `echo x > ${TEAM}/users/bob/rw5.md || echo x > ${TEAM}/.system/rw5.md || echo x > ${TEAM}/rw5.md`, check: failsQuietly, o: { who: CAROL, shared: { chat: '01a1ed7a-0000-7000-8000-0000000000ca', within: null, audience: [CAROL] } } },
  { id: 'RW6', what: 'locked places listed: stat of places and given entries inside the sandbox', cmd: `stat -c '%A %n' ${TEAM} ${TEAM}/projects ${WEB} ${WEB}/docs ${WEB}/index.html ${TEAM}/shared 2>&1; true`, check: () => null, o: SPC },
  { id: 'RW4c', what: 'her own chat (no project): srt\'s masks over hidden folders and its places take no silent write', cmd: `mkdir ${TEAM}/users/rw4c || echo x > ${TEAM}/.system/rw4c || echo x > ${TEAM}/groups/marketing/salaries/rw4c || echo x > ${TEAM}/rw4c.md || mkdir ${TEAM}/groups/rw4c`, check: failsQuietly, o: { work: true } },
  // review of PR #1372: a run swaps the person's TMPDIR for a link to a folder she may not open; the next run's first-
  // line files must not be written through it (they are in the run's own guard folder)
  { id: 'RX1', what: 'her own project run swaps its TMPDIR for a link to a folder she may not open (groups/finance)', cmd: `echo TMP=$TMPDIR; rm -rf "$TMPDIR" && ln -s ${TEAM}/groups/finance "$TMPDIR" && ls -ld "$TMPDIR"`, check: () => null },
  { id: 'RX2', what: 'the next run of the same person: the server must not write its lock list through that link', cmd: 'true', check: () => null,
    after: () => { const f = fs.readdirSync(`${TEAM}/groups/finance`).filter((n) => n.startsWith('.trina-')); return f.length ? `the server wrote into groups/finance: ${f.join(', ')}: ${JSON.stringify(fs.readFileSync(`${TEAM}/groups/finance/${f[0]}`, 'utf8')).slice(0, 400)}` : null } },
  { id: 'RX3', what: 'same with her own home chat (person home): link TMPDIR to groups/finance', cmd: `rm -rf "$TMPDIR" && ln -s ${TEAM}/groups/finance "$TMPDIR"; true`, check: () => null, o: { work: true } },
  { id: 'RX4', what: 'next home-chat run', cmd: 'true', check: () => null, o: { work: true },
    after: () => { const f = fs.readdirSync(`${TEAM}/groups/finance`).filter((n) => n.startsWith('.trina-')); for (const t of [path.join(personHome(BASE, ME), 'tmp'), path.join(projectHome(BASE, ME, 'projects/one'), 'tmp')]) { fs.rmSync(t, { recursive: true, force: true }); fs.mkdirSync(t, { recursive: true }) } sh(`chown -R ${SRV}:${SRV} ${devenvPaths(BASE).root}`); return f.length ? `the server wrote into groups/finance: ${f.join(', ')}` : null } },
]

fs.symlinkSync(`${BASE}/secrets`, `${DIR1}/escape`)
// preflight: a plain command must run through srt. If srt or bwrap cannot start (for example the AppArmor userns
// restriction of an Ubuntu 24.04 host), every attack that expects a failure would pass without a test.
// no folder or file in the team folder changes mode or owner on the disk during the suite (a lock inside the sandbox
// touches only srt's tmpfs; HOSTMODES at the end)
const modesNow = () => new Map(Bun.spawnSync(['bash', '-c', `find ${TEAM} -xdev \\( -type d -o -type f \\) -printf '%m %U %p\\n'`]).stdout.toString().trim().split('\n').map((l) => { const [m, u, ...p] = l.split(' '); return [p.join(' '), `${m} ${u}`] as [string, string] }))
const MODES0 = modesNow()
const pre = await run('true')
if (pre.code !== 0) {
  console.log(`FAIL preflight: \`true\` did not run through srt (exit code ${pre.code}): ${pre.out.slice(0, 300).replace(/\n/g, ' ')}`)
  server.stop(true); us.close()
  process.exit(1)
}
console.log('pass preflight: a plain command runs through srt')
let failed = 0
let firstProxy = ''
// S15 (QA TC-4928): srt's proxy login is the run's own: another run gets another one, and the first one is refused
// there (it reaches only its own run's proxy, which ended with it)
attacks.push({ id: 'S15', what: 'shared chat: the proxy login in a run\'s environment is per run and useless in the next run', cmd: 'echo "P=$http_proxy"', check: (r) => {
  const first = /P=(\S+)/.exec(r.out)?.[1] ?? ''
  if (!/^http:\/\/srt[^:]*:[0-9a-f]{32}@localhost:\d+$/.test(first)) return `no per-run proxy login in the environment: ${r.out.slice(0, 200)}`
  firstProxy = first
  return null
}, o: SWC })
attacks.push({ id: 'S15b', what: 'shared chat: the previous run\'s proxy login is another one and does not work here', cmd: 'echo "P=$http_proxy"; curl -s -m 15 -o /dev/null -w "CODE=%{http_code}" -x "@OLD_PROXY@" https://registry.npmjs.org/; true', check: (r) => {
  const first = firstProxy
  const now = /P=(\S+)/.exec(r.out)?.[1] ?? ''
  const tok = (u: string) => /:([0-9a-f]{32})@/.exec(u)?.[1] ?? ''
  if (!tok(first) || !tok(now) || tok(first) === tok(now)) return `the same proxy login in two runs: ${tok(first)} ${tok(now)}`
  return /CODE=200/.test(r.out) ? 'the previous run\'s proxy login worked in this run' : null
}, o: SWC })
for (const a of attacks) {
  a.before?.()
  // S15b uses the login S15 saw
  const r = await run(a.id === 'S15b' ? a.cmd.replace('@OLD_PROXY@', firstProxy) : a.cmd, a.o)
  const why = (r.out.includes(CANARY) ? `canary: ${r.out.slice(r.out.indexOf(CANARY) - 40, r.out.indexOf(CANARY) + 40)}` : null) ?? a.check(r) ?? a.after?.() ?? null
  console.log(`${why ? 'FAIL' : 'pass'} ${a.id} ${a.what}${why ? `\n     ${why.replace(/\n/g, ' ')}` : ''}`)
  if (a.id === 'RV2b' || a.id === 'RW6') console.log(`     ${r.out.slice(0, 900).replace(/\n/g, ' | ')}`)
  if (why) failed++
}
// L1 (QA TC-4990): with no bridge (mycel-sandbox port-bridge, started by the runner for the chat's own dev server
// only; it needs run units, so the spike VM checks it, tests/linux/srt-vm-preview.ts P8), a dev server of one run is not
// reachable from another run at the same time: each run has its own localhost. The run itself reaches it.
{
  let second: Promise<{ code: number | null; out: string }> | null = null
  const dev = `node -e "require('http').createServer((q,s)=>s.end('DEV-OF-RUN-ONE')).listen(4555,'127.0.0.1')" & sleep 6; echo SELF=$(curl -s -m 3 http://127.0.0.1:4555/); kill %1; true`
  const first = await run(dev, { during: () => { second = run('echo A=$(curl -s -m 3 http://127.0.0.1:4555/); echo B=$(curl -s -m 3 http://localhost:4555/); true', SWC) } })
  const other = second ? await second : { code: null, out: '' }
  const why = !first.out.includes('SELF=DEV-OF-RUN-ONE') ? `the run did not reach its own dev server: ${first.out.slice(0, 200)}` : other.code !== 0 ? `the second run did not run: ${other.out.slice(0, 200)}` : other.out.includes('DEV-OF-RUN-ONE') ? 'another run reached the dev server' : null
  console.log(`${why ? 'FAIL' : 'pass'} L1 a run's dev server is not reachable from another run (each its own localhost)${why ? `\n     ${why}` : ''}`)
  if (why) failed++
}
// R2b (review of #46): erin's live run writes a hook in a folder alice's run only reads, after erin's run started; alice's
// command starts while erin's still runs: its sweep takes the folders of other people's live runs too (runner.ts liveSweeps)
{
  let second: Promise<{ code: number | null; out: string }> | null = null
  const plant = `mkdir -p hk2 && sleep 2 && printf '#!/bin/sh\\necho HOOK-RAN; touch ${GMARK}\\n' > hk2/pre-commit && chmod +x hk2/pre-commit && echo PLANTED; sleep 8; true`
  const first = await run(plant, { who: ERIN, start: 'shared', during: () => { setTimeout(() => { second = run(`ls -l ${TEAM}/shared/hk2/pre-commit; /usr/bin/git -c core.hooksPath=${TEAM}/shared/hk2 ${GID} commit -q --allow-empty -m r2b && echo COMMITTED`, { start: 'projects/gitp' }) }, 2500) } })
  const other = second ? await second : { code: null, out: '' }
  const why = !first.out.includes('PLANTED') ? `erin's run did not plant: ${first.out.slice(0, 200)}` : !other.out.includes('COMMITTED') ? `alice's commit did not run: ${other.out.slice(0, 300)}` : hookNotRun(other)
  console.log(`${why ? 'FAIL' : 'pass'} R2b a hook written by another person's live run in a folder this run only reads does not run${why ? `\n     ${why}` : ''}`)
  if (why) failed++
}
// PH1 (QA TC-5349): srt's protected names are on the disk of the folder while a run lives (bwrap binds over a path
// that exists), but no person sees them: each new entry is one the server made for the run (placeholders.ts
// isRunPlaceholder: the Files tree, the AI's list, the snapshots and change notices skip them), and when the run has
// ended the folder is exactly what it was (a killed or long run leaves nothing behind)
{
  const ph = `${DIR1}/ph-fresh`
  fs.mkdirSync(ph, { recursive: true }); fs.writeFileSync(`${ph}/keep.txt`, 'a person\n'); sh(`chown -R ${SRV}:${SRV} ${ph}`)
  const list = () => (fs.existsSync(ph) ? Bun.spawnSync(['bash', '-c', `find ${ph} -mindepth 1 | sort`]).stdout.toString().trim().split('\n').filter(Boolean) : [])
  const was = list()
  let during: string[] = []
  let shown: string[] = []
  const r = await run('sleep 4; true', { cwd: 'ph-fresh', during: () => { during = list(); shown = during.filter((p) => p !== `${ph}/keep.txt` && !isRunPlaceholder(p)) } })
  const after = list()
  const why = r.code !== 0 ? `the run did not end well: ${r.code} ${r.out.slice(0, 200)}`
    : during.length <= was.length ? 'no placeholder was made during the run (the check does not test anything)'
      : shown.length ? `entries a person would see during the run: ${shown.join(', ')}`
        : after.join('|') !== was.join('|') ? `the folder is not as it was after the run: ${after.filter((p) => !was.includes(p)).join(', ')}` : null
  console.log(`${why ? 'FAIL' : 'pass'} PH1 the names made for a run are never shown (${during.length - was.length} made) and none stay after it${why ? `\n     ${why}` : ''}`)
  if (why) failed++
}
{ const m1 = modesNow(); const ch = [...MODES0].filter(([p, m]) => m1.has(p) && m1.get(p) !== m).map(([p, m]) => `${p}: ${m} -> ${m1.get(p)}`); console.log(ch.length ? `FAIL HOSTMODES changed on disk: ${ch.slice(0, 20).join(' | ')}` : `pass HOSTMODES no mode or owner changed on disk (${MODES0.size} entries)`); if (ch.length) failed++ }
server.stop(true); us.close()
console.log(failed ? `\n${failed} of ${attacks.length + 1} attacks got through` : `\nall ${attacks.length + 1} attacks held`)
process.exit(failed ? 1 : 0)
