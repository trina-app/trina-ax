// The srt runner of the dev environment (docs/research/srt-dev-env.md), the only runner (docs/DECISIONS.md "Dev
// environment: box runner removed, srt only"). The AI's commands run on the team server as the server account, inside
// Anthropic's sandbox runtime srt (bwrap, a proxy with a domain allowlist), in its own systemd unit with memory, CPU
// and pids limits: an instance trina-dev@<runId>.service of a root-installed template (an older install: a
// `systemd-run --scope` unit). Each command, job or dev server is one srt process in its own unit.
//
// A run is not locked to a project. It belongs to the person who owns the chat: it may read and write exactly the team
// folders that person may open now (srt/access.ts, built from the folder rules for every command and every job start),
// plus the person's home (caches) and, for a chat with no project, the chat's work folder. The folder a run starts in
// (its root) is the project folder of a project chat, else the chat's work folder.
//
// Kinds of run:
//  - command (box_shell): the call waits for it. One per root at a time. Commands and jobs share the maxRunning slots
//    of the plan and one queue for the whole team (queue.ts: FIFO with a fair share per person). A command waits for a
//    slot as a ticket row (foreground = 1) for at most 5 minutes, then the call ends ("The dev environment is full").
//  - job (job=true): a row in dev_env_runs. With no free slot it waits in the same queue (state waiting) and starts
//    when it gets a slot. At most 3 waiting jobs per person and 10 on the server. A waiting job ends "expired" after 24
//    hours.
//  - dev server (background=true): a row with kind server. At most maxRunning on the server and one per chat; no
//    queue: past that it is refused ("Preview is full").
//
// A shared chat's jobs and dev servers (docs/decisions/20261118-devenv-shared-jobs-mac-localhost.md) are rows too, with
// shared_key set: the tracker builds who sees the chat again for every check (setSharedResolver) and stops the run
// when they or their access change. Their logs are the chat's for that key (config.ts sharedLogs), never the person's.
// A command reaches the ports of its chat's own running jobs and dev servers (reachTargets), nothing else on localhost.
//
// Runs keep going when the server restarts: their output goes to files, and the tracker finds them again by the
// unit name in the row. A unit with no row is stopped. The tracker also stops a job or dev server when the person's
// folder access changes or the person may no longer use the dev environment (reason setting).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import type { DevEnvRun, DevEnvRuns } from '@mycel/shared/api'
import type { RunExit, RunJob } from './types'
import type { AppContext } from '../../context'
import { newId } from '../../db'
import { storageRoom } from '../../system/storage'
import { resolveLayout } from '../../system/layout'
import { commandMode, documentsOnlyServer, mayRunCommands, mayUseDevEnv, teamSetting } from '../setting'
import { docKit } from '../kit'
import { officeSystem } from './system-office'
import { activePeople } from '../../team-files/service'
import { ownSharedFolders, shareReaders } from '../../files/share-readers'
import { startingRun } from './alive'
import { projectZoneFolders } from '../../policy/zone'
import { othersSkillRoots } from '../../skills/script-copies'
import type { Principal } from '../../policy/access'
import { folderView, runSkillFolders, sharedFolderView, sharedPathAccess, sharedReadable, viewAccess, viewHash, type FolderView, type RunWrites } from './access'
import { writeBoxBrowser } from './box-browser'
import { writeDocSkills } from '../doc-skills'
import { sweepAfterRun } from './browser-profiles'
import { RUN_ID_RE, SRT_PATHS, boxBrowser, realGit, runGuard, chatHome, chatLogs, chatWork, sharedLogs, sharedWork, sharedWorkKey, runTmp, devPlatform, type DevPlatform, devenvPaths, boxFontsDir, BOX_FONTS_CONF, BOX_MATPLOTLIBRC, BOX_MATPLOTLIBRC_MAC, isFull, personLogs, resolveRunCwd, runHome, runLogs, runEnv, runIdOfUnit, settingsProblems, srtSettings, unitName } from './config'
import { formatOnce, netNarrowed, netSnapshot, parseOnce, parseSnapshot, personNet, type NetSnapshot } from '../sites'
import { effectiveLimits, loadPlan, NO_PLAN_MAX_RUNNING, type DevEnvPlan, type PlanState } from './plan'
import { holdPlaceholders, holdSkillFolders, isSkillPlaceholder } from './placeholders'
import { gitWrapperSource } from './git-guard'
import { othersLive, sweepHooks, sweepRoots, visibleOf } from './hook-sweep'
import { entryGuard, entryPins, hideDeniedNames, lockedTops, lockFolders, makeGuardDir, writePins } from './mounts'
import { _resetQueue, cancelTicket, endOrphanTickets, grantTicket, heldCommands, noteServed, pickNext, servedNow, startOrder, ticketIds, withoutTickets } from './queue'
import { directSystem, systemdSystem, type Forwarder, type SrtSystem } from './system'
import { macConfig, macSystem } from './system-mac'
import { END_NOTE, endRow, type EndReason } from './end'
import { forgetCopiedIn, readCopiedIn, type CopiedGroup } from './copied-in'

export const MAX_WAITING_PER_PERSON = 3
export const MAX_WAITING_SERVER = 10
export const WAIT_MAX_MS = 24 * 3600_000
export const JOB_MAX_SEC = 6 * 3600
export const SERVER_MAX_SEC = 8 * 3600
export const LOG_MAX_BYTES = 64 << 20
/** a command's stdout and stderr each: its first and last half of this (readEnds). The same as what box_shell shows
 * (devenv/tool.ts OUT_SHOWN), so the output is cut once, here, and the count of what was left out is the real one */
const OUT_READ = 32 << 10
const TAIL_BYTES = 4 << 10
/** a dev server under this CPU share for idleStopMin stops (reason idle) */
const IDLE_CPU_SHARE = 0.02

/** Where a run belongs and where it starts. root: the project folder (a project chat whose folder the person can
 * read), else the chat's work folder. */
/** A run of a shared chat (docs/decisions/20261118-devenv-shared-chats.md): who sees the chat now, read again for every
 * command and every check while it runs (so someone who joins mid-answer narrows the next command and stops this one),
 * and its project folder (null: a chat shared with people and groups). Only foreground commands: no row holds it. */
export interface SharedRun {
  audience(): readonly string[]
  within: string | null
  /** what a run is about to read (sharedReadable), with who sees the chat as its view was made: the answer records it
   * (chat/shared-answers.ts). false: not recorded, and the run does not start */
  noteReads(folders: readonly string[], audience: readonly string[]): boolean
  /** what was copied into this chat's work folder for its people now (srt/copied-in.ts): each group joins the answer's
   * record again, as a group a read card's yes covered (y). false: not recorded, and the run does not start. Absent: a
   * run that cannot record them (it does not start while the folder holds a copy) */
  noteCopied?(groups: readonly CopiedGroup[]): boolean
}
export interface Space { userId: string; chatId: string | null; projectId: string | null; root: string; shared?: SharedRun
  /** a shared chat's run: the key of its logs folder (sharedLogKey), set when the run is made */
  logKey?: string }

/** Who sees a shared chat now, rebuilt from the chat alone (devenv/shared-chat.ts sets it): the tracker checks a shared
 * chat's job or dev server against it, out of any turn. Null: the chat is not shared any more (or is gone). */
export type SharedResolver = (ctx: AppContext, chatId: string) => Pick<SharedRun, 'audience' | 'within'> | null
let sharedResolver: SharedResolver = () => null
export function setSharedResolver(r: SharedResolver) { sharedResolver = r }
/** a shared chat's run out of a turn: its reads were recorded when it was asked for (submitJob, startServer), so this
 * records nothing and the start checks that the people and their view are still those (startRow) */
const NOBODY: SharedRun = { within: null, audience: () => [], noteReads: () => false }
function sharedOfChat(ctx: AppContext, chatId: string | null): SharedRun {
  if (!chatId) return NOBODY
  let r: ReturnType<SharedResolver> = null
  try { r = sharedResolver(ctx, chatId) } catch { r = null }
  return r ? { within: r.within, audience: () => { try { return r!.audience() } catch { return [] } }, noteReads: () => false } : NOBODY
}

// ---------------- configuration ----------------

export interface SrtConfig { base: string; id: string; system: SrtSystem; planFile: string; problem?: string }

let systemOverride: SrtSystem | null = null
let configOverride: (Partial<SrtConfig> & { plan?: DevEnvPlan | null; platform?: DevPlatform }) | null = null
/** tests: a fake system, other folders, a plan (the real file must belong to root), the platform of the host lists
 * (a fake system: Linux unless it says darwin, so the tests read the same on a Mac) */
export function setSrtSystem(s: SrtSystem | null, c: (Partial<SrtConfig> & { plan?: DevEnvPlan | null; platform?: DevPlatform }) | null = null) { systemOverride = s; configOverride = c; reset() }
/** the platform of the runs: this machine's, or the tests' */
export const runPlatform = (): DevPlatform => configOverride?.platform ?? (systemOverride ? 'linux' : devPlatform())

export function srtConfig(env: Record<string, string | undefined> = process.env): SrtConfig {
  const id = configOverride?.id ?? env.MYCEL_LABEL ?? 'mycel'
  const base = configOverride?.base ?? env.MYCEL_INSTALL_BASE ?? `/var/lib/${id}`
  const planFile = configOverride?.planFile ?? path.join(base, 'root', 'dev-env.json')
  if (systemOverride || env.MYCEL_DEV_ENV_SRT_DIRECT === '1') return { id, base, system: systemOverride ?? directSystem(), planFile }
  // an office Mac (no sudo, no slot accounts): the documents profile, with the kit's srt as the signed-in user
  // (system-office.ts). Without its kit there is no run (srtProblem says why)
  if (devPlatform() === 'darwin' && documentsOnlyServer(env)) {
    const kit = docKit(env)
    return kit ? { id, base, system: officeSystem(kit), planFile } : { id, base, system: directSystem(), planFile, problem: 'the document kit is not installed or not ready (run the office installer again)' }
  }
  // a Mac team server (install-macos.sh): dev slot accounts through sudo (system-mac.ts)
  if (devPlatform() === 'darwin') {
    const m = macConfig(base, env)
    if (!m.ok) return { id, base, system: directSystem(), planFile, problem: m.reason }
    return { id, base, system: macSystem(m.c), planFile }
  }
  return { id, base, system: systemdSystem(id, base), planFile }
}

const listEnv = (v: string | undefined) => (v ?? '').split(',').map((x) => x.trim()).filter(Boolean)

/** The host names of this Trina server: its public origins, the relay, and MYCEL_DEV_ENV_DENY_HOSTS. A run may not
 * reach them through the proxy, and an admin may not allow them. */
export function teamHosts(ctx: Pick<AppContext, 'config'>, env: Record<string, string | undefined> = process.env): string[] {
  const out = new Set<string>(listEnv(env.MYCEL_DEV_ENV_DENY_HOSTS).map((h) => h.toLowerCase()))
  for (const u of [...(ctx.config.publicOrigins ?? []), ctx.config.relay?.url ?? '']) {
    try { const h = new URL(u).hostname.toLowerCase(); if (h && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(h)) out.add(h) } catch {}
  }
  return [...out]
}

/** This VM's public IPv4 from EC2's metadata service (IMDSv2), cached for a minute. Only with MYCEL_DEV_ENV_IMDS=1
 * (the install sets it on EC2). An instance with no Elastic IP gets a new address after a stop. */
let imds: { at: number; ips: string[] } | null = null
async function publicIps(env: Record<string, string | undefined> = process.env): Promise<string[]> {
  if (env.MYCEL_DEV_ENV_IMDS !== '1') return []
  if (imds && Date.now() - imds.at < 60_000) return imds.ips
  let ips: string[] = []
  try {
    const t = await fetch('http://169.254.169.254/latest/api/token', { method: 'PUT', headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '60' }, signal: AbortSignal.timeout(1000) })
    const token = await t.text()
    const r = await fetch('http://169.254.169.254/latest/meta-data/public-ipv4', { headers: { 'X-aws-ec2-metadata-token': token }, signal: AbortSignal.timeout(1000) })
    const ip = r.ok ? (await r.text()).trim() : ''
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) ips = [ip]
  } catch {}
  imds = { at: Date.now(), ips }
  return ips
}

// ---------------- state of this server process ----------------

interface Active { runId: string; space: Space; kind: 'command' | 'job' | 'server'; command: string; startedAt: string; pid: number; stopReason: EndReason | null; rowId?: string
  /** a command: the access hash it started with (accessHash's format); the tracker stops it when that changes */
  access?: string }
/** runs started by this process (the tracker also finds runs from before a restart through the rows) */
const active = new Map<string, Active>()
/** one command at a time per root folder (the change window of track.ts would mix two commands) */
const rootLocks = new Map<string, Promise<void>>()
/** dev servers: CPU time at the last poll, and since when they are idle */
const idleSince = new Map<string, { usec: number; at: number; since: number | null }>()
/** the preview forwarders of this process: "<runId>:<port>" -> the start (a forwarder, or why it did not start) */
const forwarders = new Map<string, Promise<Forwarder | { error: string }>>()
/** the time of the last preview request of a run (a previewed dev server is not idle) */
const lastPreview = new Map<string, number>()
/** The folders each live run may write, by run id (hook-sweep.ts othersLive): kept until its sweep after it ended. */
const liveSweeps = new Map<string, { userId: string; roots: string[]; rowId?: string }>()

function reset() { liveSweeps.clear(); for (const f of forwarders.values()) void f.then((x) => { if ('stop' in x) x.stop() }); forwarders.clear(); lastPreview.clear(); active.clear(); rootLocks.clear(); idleSince.clear(); imds = null; planCache = null; selfTest = null; selfTestRun = null; selfTestGen++; loggedDown = ''; _resetQueue() }

let planCache: { at: number; state: PlanState } | null = null
let selfTest: { at: number; problem: string } | null = null
/** the self-test that runs now (every caller waits for the same one: no stampede when the cache runs out) */
let selfTestRun: Promise<string> | null = null
/** bumped by reset(): a self-test started before it does not write its result after it */
let selfTestGen = 0
export function planState(c = srtConfig()): PlanState {
  if (configOverride && configOverride.plan !== undefined) return { ok: true, plan: configOverride.plan }
  if (planCache && Date.now() - planCache.at < 30_000) return planCache.state
  planCache = { at: Date.now(), state: loadPlan(c.planFile) }
  return planCache.state
}

export const newRunId = () => {
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789'
  return [...crypto.randomBytes(16)].map((b) => a[b % 36]).join('')
}

// ---------------- availability ----------------

/** Can this server run srt? '' = yes, else why not. Checks the files of the install and that a run unit can start. */
export async function srtProblem(c = srtConfig()): Promise<string> {
  const p = planState(c)
  if (!p.ok) return p.reason
  if (c.problem) return c.problem
  if (!systemOverride && devPlatform() === 'darwin' && documentsOnlyServer()) {
    // the office kit's files are checked by docKit (srtConfig); the self-test below starts its srt
  } else if (!systemOverride && devPlatform() === 'darwin') {
    for (const f of [SRT_PATHS.node, SRT_PATHS.cli, SRT_PATHS.cliMac, SRT_PATHS.cliFull, SRT_PATHS.runWrapMac, SRT_PATHS.sudo, '/usr/bin/sandbox-exec']) if (!fs.existsSync(f)) return `${f} is missing: run scripts/install-macos.sh again (the dev environment step)`
  } else if (!systemOverride) {
    for (const f of [SRT_PATHS.node, SRT_PATHS.cli, SRT_PATHS.runWrap]) if (!fs.existsSync(f)) return `${f} is missing: run scripts/dev-env/srt/install-srt.sh`
    for (const b of ['bwrap', 'socat', 'rg']) if (!['/usr/bin', '/bin', '/usr/local/bin'].some((d) => fs.existsSync(path.join(d, b)))) return `${b} is missing`
  }
  // a failed check is tried again after a minute: an update brings the server before install-srt.sh's new root files.
  // One self-test at a time; while it runs again, the last result is served (only the very first check is waited for)
  if (!selfTest || Date.now() - selfTest.at > (selfTest.problem ? 60_000 : 10 * 60_000)) {
    if (!selfTestRun) {
      const gen = selfTestGen
      selfTestRun = Promise.resolve().then(() => c.system.selfTest(c.id)).catch((e) => String(e))
        .then((problem) => { if (gen === selfTestGen) { selfTest = { at: Date.now(), problem }; selfTestRun = null } return problem })
    }
    if (!selfTest) return await selfTestRun
  }
  return selfTest.problem
}

/** the last answer of devEnvDownReason ('' = working): logged once per new reason, and kept while a check is late */
let loggedDown = ''
/**
 * Why the dev environment cannot run a command now ('' = it can), for a turn deciding whether to offer box_shell (QA
 * TC-4924). srtProblem is cached and serves its last result while it checks again, so only the first check after a
 * start can be slow: a check that takes longer than `waitMs` is "not known yet" and the answer before it stands (none
 * yet: working, as before this check; the tool then says what is wrong). A new reason is logged once.
 */
export async function devEnvDownReason(log?: { warn(m: string, d?: object): void }, waitMs = 3_000): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<null>((r) => { timer = setTimeout(() => r(null), waitMs) })
  const got = await Promise.race([srtProblem().catch((e) => String(e)), late]).finally(() => clearTimeout(timer))
  if (got === null) return loggedDown
  if (got && got !== loggedDown) log?.warn('dev environment is on but not working; box_shell is not offered', { reason: got.slice(0, 500) })
  loggedDown = got
  return got
}

// ---------------- the folder access of a person ----------------

/** The person's view, with only the folders that exist now (srt skips what is not there; a folder that appears later
 * changes the hash, and the tracker then stops the person's jobs). With `run`, the view of a run that starts there
 * (access.ts: only the starting folder and the person's own folder are writable). Null: the person cannot be loaded. */
export function personView(ctx: AppContext, userId: string, run?: RunWrites, shared?: SharedRun, scope?: SharedScopeNow | null, o: { hideSkills?: boolean } = {}): FolderView | null {
  let p
  try { p = ctx.files.principal(userId) } catch { return null }
  // documents mode (setting.ts commandMode): no team folder at all, only the chat's work folder (settingsFor adds it)
  if (isDocumentsMode(ctx, userId)) return { read: [], write: [], denyRead: [], denyWrite: [] }
  // a project run reads only folders that everyone who sees the project may read (access.ts, QA TC-095)
  const root = ctx.files.fx.root
  // every run hides the group and project skills folders (QA TC-4932). The hash a run is checked against is made
  // without them (hideSkills false, viewForHash): a group skills folder someone makes or removes must not stop other
  // people's jobs, nor an empty placeholder of a run (placeholders.ts holdSkillFolders, left out of the list)
  if (run && o.hideSkills !== false) run = { ...run, othersSkills: othersSkillRoots(root, isSkillPlaceholder) }
  const zones = projectZoneFolders(root).map((z) => z.join('/'))
  let v: FolderView
  if (shared) {
    // a shared chat: only what everyone who sees it now may read (access.ts sharedFolderView). Anyone who cannot be
    // loaded, or the person no longer in it: no run (fail closed)
    const s = run ? (scope ?? sharedScopeNow(ctx, shared)) : null
    if (!s) return null
    try { v = sharedFolderView(ctx.files.rules(), p, run!, s, zones) } catch { return null }
  } else {
    // the person's shared folders are read-only in a run (access.ts; files/share-readers.ts)
    const withShares = run ? { ...run, shared: ownSharedFolders(ctx.db, userId) } : undefined
    v = folderView(ctx.files.rules(), p, withShares, run?.start ? activePeople(ctx.db) : undefined, zones, (f) => shareReaders(ctx.db, f ? f.split('/') : []))
  }
  const there = (rel: string) => { try { return fs.statSync(rel === '' ? root : path.join(root, rel)).isDirectory() } catch { return false } }
  return { read: v.read.filter(there), write: v.write.filter(there), denyRead: v.denyRead.filter(there), denyWrite: v.denyWrite.filter(there) }
}

/** Does this person's command run in documents mode now (offline, work folder only)? */
export const isDocumentsMode = (ctx: Pick<AppContext, 'db' | 'files'>, userId: string) => commandMode(ctx.db, ctx.files, userId) === 'documents'

/** Who sees a shared chat now, as principals. Null when anyone of them cannot be loaded (fail closed). */
type SharedScopeNow = { audience: Principal[]; within: string | null }
function sharedScopeNow(ctx: AppContext, shared: SharedRun): SharedScopeNow | null {
  try {
    const audience = shared.audience().map((id) => ctx.files.principal(id))
    if (!audience.length || audience.some((q) => !q)) return null
    return { audience: audience as Principal[], within: shared.within }
  } catch { return null }
}

/** The work folder of a shared chat with no project now: keyed by its people and by the view a run there gets
 * (config.ts sharedWorkKey; the view of everyone in it is the same whoever asks: a people chat writes no team folder).
 * Null when the people cannot be loaded. */
export function sharedWorkOf(ctx: AppContext, chatId: string, userId: string, shared: SharedRun, scope?: SharedScopeNow | null): string | null {
  const s = scope ?? sharedScopeNow(ctx, shared)
  if (!s) return null
  let p: Principal | null = null
  try { p = ctx.files.principal(userId) } catch {}
  if (!p) return null
  let v: FolderView
  try { v = sharedFolderView(ctx.files.rules(), p, { start: null }, { audience: s.audience, within: null }, projectZoneFolders(ctx.files.fx.root).map((z) => z.join('/'))) } catch { return null }
  return sharedWork(srtConfig().base, chatId, sharedWorkKey(s.audience.map((q) => q.id), viewHash(v)))
}

/** The key of a shared chat's runs for who sees it now and what all of them may read there (the view's readable folders,
 * its root): the name of its logs folder (config.ts sharedLogs). A job's log is read by later commands of the same
 * people with the same view (a reader and a writer of the project get the same key); anyone more, or anyone whose
 * access narrowed, another key and an empty folder. Null when the people cannot be loaded. */
export function sharedLogKey(ctx: AppContext, space: Space): string | null {
  if (!space.shared) return null
  let run: RunWrites
  try { run = runWrites(ctx, srtConfig(), space) } catch { return null }
  const scope = sharedScopeNow(ctx, space.shared)
  if (!scope) return null
  const v = personView(ctx, space.userId, run, space.shared, scope)
  if (!v) return null
  const readable = [...new Set([...v.read, ...v.write])].sort()
  return sharedWorkKey(scope.audience.map((q) => q.id), viewHash({ read: readable, write: [], denyRead: [...v.denyRead].sort(), denyWrite: [] }, `logs\0${run.start ?? space.root}`))
}
/** the space with its logs key (a shared chat), or null when the people cannot be loaded; a person's space as it is */
function keyed(ctx: AppContext, space: Space): Space | null {
  if (!space.shared) return space
  const logKey = sharedLogKey(ctx, space)
  return logKey ? { ...space, logKey } : null
}

/** A shared chat's run: record what it may read for the answer (SharedRun.noteReads) before it starts. Throws when the
 * record cannot be written. */
function noteSharedRun(ctx: AppContext, space: Space, run: RunWrites, s: SharedScopeNow | null) {
  if (!space.shared) return
  let p: Principal | null = null
  try { p = ctx.files.principal(space.userId) } catch {}
  if (!s || !p) throw new Error('the person cannot use the dev environment now')
  const folders = sharedReadable(ctx.files.rules(), p, run, s, projectZoneFolders(ctx.files.fx.root).map((z) => z.join('/')))
  if (!space.shared.noteReads(folders, s.audience.map((q) => q.id))) throw new Error('what this command may read could not be recorded')
  // a shared chat's work folder (a shared project chat's scratch folder too): what the server copied into it for these
  // people joins the answer again
  const workRoot = run.start === null ? space.root : scratchOf(ctx, srtConfig(), space, s)
  if (workRoot && space.chatId && !noteCopiedIn(space.shared, space.chatId, workRoot)) throw new Error('what was copied into this work folder could not be recorded')
}

/** What was copied into a shared chat's work folder (`workRoot`, its folder for one key: sharedWorkOf) joins this
 * answer's record again (srt/copied-in.ts): every run on that key does it (noteSharedRun), and so does every read or
 * listing of the folder by the file tools (chat:work/). True when nothing was copied there. False when the record
 * cannot be read or written, or this run cannot record it: the caller does not run or read (fails closed). */
export function noteCopiedIn(shared: SharedRun | undefined, chatId: string, workRoot: string): boolean {
  if (!shared) return true
  let groups: CopiedGroup[]
  try { groups = readCopiedIn(srtConfig().base, chatId, workRoot) } catch { return false }
  if (!groups.length) return true
  if (!shared.noteCopied) return false
  try { return shared.noteCopied(groups) } catch { return false }
}

/** A shared chat's turn is about to give the AI results of the chat's jobs (their log tails): what a run there may read
 * joins this answer's record first, as for a command. False: not recorded, and no result may be given. */
export function noteSharedReads(ctx: AppContext, space: Space): boolean {
  if (!space.shared) return true
  try { noteSharedRun(ctx, space, runWrites(ctx, srtConfig(), space), sharedScopeNow(ctx, space.shared)); return true } catch { return false }
}

/** The writable starting folder of a run in `space`: the project folder (team-relative), or null for the chat's work
 * folder (outside the team folder). */
/** Is the root of this space the chat's work folder (the private one; a shared chat's: one of its own, sharedWork)? */
function inWorkFolder(c: SrtConfig, space: Space): boolean {
  if (!space.chatId) return false
  if (!space.shared) return space.root === chatWork(c.base, space.chatId)
  const top = path.join(devenvPaths(c.base).workShared, space.chatId)
  return path.dirname(space.root) === top
}

function runWrites(ctx: AppContext, c: SrtConfig, space: Space): RunWrites {
  if (inWorkFolder(c, space)) return { start: null }
  const team = ctx.files.fx.root
  if (!space.root.startsWith(team + '/')) throw new Error('the person cannot open the folder of this chat now')
  return { start: space.root.slice(team.length + 1) }
}
/** a shared chat's hash also holds who sees the chat: any change of its people stops a running command */
const runHash = (view: FolderView, run: RunWrites, scope?: SharedScopeNow | null) => viewHash(view, (run.start ?? '') + (scope ? `\0${sharedWorkKey(scope.audience.map((q) => q.id))}` : ''))

/** The hash a running job or dev server is checked against: the view of a run in this space, and whether the person
 * may still use the dev environment. */
export function accessHash(ctx: AppContext, space: Space): string {
  if (!mayRunCommands(ctx.db, ctx.files, space.userId)) return 'off'
  let run: RunWrites
  try { run = runWrites(ctx, srtConfig(), space) } catch { return 'off' }
  const scope = space.shared ? sharedScopeNow(ctx, space.shared) : null
  if (space.shared && !scope) return 'off'
  const v = personView(ctx, space.userId, run, space.shared, scope, { hideSkills: false })
  return v ? runHash(v, run, scope) : 'off'
}

/** A shared chat's run: which team paths it may name now (access.ts sharedPathAccess: the rules for the person and
 * everyone in the chat, and the path's folder on disk). The tool's notes (changes by other people, files changed in the
 * background, conflict copies) name only those: they go to everyone in the chat. Not a shared run: every path. The
 * people cannot be loaded: none. */
export function sharedVisible(ctx: AppContext, space: Space): (rel: string) => boolean {
  if (!space.shared) return () => true
  let run: RunWrites, p: Principal | null = null
  try { run = runWrites(ctx, srtConfig(), space); p = ctx.files.principal(space.userId) } catch { return () => false }
  const scope = sharedScopeNow(ctx, space.shared)
  if (!scope || !p) return () => false
  const rules = ctx.files.rules(), root = ctx.files.fx.root
  // by the rules for everyone in the chat, path by path (a renamed or trashed restricted folder has no entry in the
  // run's view, whose folders are only those on disk), and only where the folder is on disk now
  const onDisk = (rel: string) => { const d = path.posix.dirname(rel); try { return fs.lstatSync(d === '.' ? root : path.join(root, d)).isDirectory() } catch { return false } }
  return (rel) => {
    try { return onDisk(rel) && sharedPathAccess(rules, p!, run, scope, rel) !== 'none' } catch { return false }
  }
}

/** May a shared chat's command start in `cwd` (a real path the runner resolved)? Outside the team folder (its work
 * folder): yes; in it: only where the run may name the folder (sharedVisible). */
function sharedCwdShown(ctx: AppContext, space: Space, cwd: string): boolean {
  let team: string
  try { team = fs.realpathSync(ctx.files.fx.root) } catch { return false }
  const rel = path.relative(team, cwd)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return rel !== ''
  return sharedVisible(ctx, space)(rel.split(path.sep).join('/'))
}

/** A shared chat's run: the writable folders whose top a command cannot change because they hold a folder not
 * everyone in the chat may open (srt/mounts.ts hideDeniedNames gives them entry by entry), shallowest first. For the
 * tool's note; they are folders everyone in the chat may open. None when the run cannot be worked out (it then does not
 * start either). */
export function sharedLockedTops(ctx: AppContext, space: Space): string[] {
  if (!space.shared) return []
  try {
    const run = runWrites(ctx, srtConfig(), space)
    const scope = sharedScopeNow(ctx, space.shared)
    const view = scope ? personView(ctx, space.userId, run, space.shared, scope) : null
    return view ? lockedTops(view, hideDeniedNames(view, ctx.files.fx.root)) : []
  } catch { return [] }
}

/** May a run of this person start in `root` now? The root is the chat's work folder, or a team folder the person can
 * read. */
export function rootAllowed(ctx: AppContext, c: SrtConfig, space: Space, view: FolderView): boolean {
  if (inWorkFolder(c, space)) return true
  const team = ctx.files.fx.root
  if (space.root !== team && !space.root.startsWith(team + '/')) return false
  const rel = space.root === team ? '' : space.root.slice(team.length + 1)
  return viewAccess(view, rel) !== 'none'
}

/** The root of a chat: the project folder when the chat has a project with a folder of its own that the person can
 * read, else the chat's work folder (made here). Null: no chat and no project folder. A shared project chat
 * (`shared.within`) runs only in its project folder (null when the person cannot read it now); a chat shared with
 * people and groups only in its work folder. */
export function spaceOf(ctx: AppContext, o: { userId: string; chatId: string | null; project: { id: string; folderPath: string } | null; shared?: SharedRun }): Space | null {
  return spaceAt(ctx, o, true)
}

/** The chat's work folder that box_shell's commands of this person use now (spaceOf's choice exactly, made nowhere),
 * or null: the commands run in a project folder (a team folder `read` reaches), the person cannot use it, or the
 * folder is not there yet (no command ran). Its real path and its path as made. For read and save_work_file (chat/work-files.ts). */
export function workFolderAt(ctx: AppContext, o: { userId: string; chatId: string | null; project: { id: string; folderPath: string } | null; shared?: SharedRun }): { real: string; path: string } | null {
  const s = spaceAt(ctx, o, false)
  if (!s) return null
  // a project chat's commands start in the project folder; their scratch folder ($TRINA_WORK, scratchOf) is chat:work/
  const c = srtConfig()
  const root = inWorkFolder(c, s) ? s.root : scratchOf(ctx, c, s)
  if (!root) return null
  try {
    const st = fs.lstatSync(root)
    if (!st.isDirectory()) return null
    return { real: fs.realpathSync(root), path: root }
  } catch { return null }
}

/**
 * The scratch folder of a project chat's runs ($TRINA_WORK next to the project folder; docs/decisions/
 * 20261121-ai-scratch-files.md): downloads, clones, tool installs and previews go there, never into the team's project
 * folder. Not a team folder and not recorded. A person's own chat: the chat's private work folder (chatWork). A shared
 * project chat: a work folder of its own for the people who see it now (sharedWorkOf, never the private one), as for a
 * shared chat with no project. Null: no chat, or the people cannot be loaded. `make`: create it (a run), else only name it.
 */
export function scratchOf(ctx: AppContext, c: SrtConfig, space: Space, scope?: SharedScopeNow | null, make = false): string | null {
  if (!space.chatId) return null
  const root = space.shared ? sharedWorkOf(ctx, space.chatId, space.userId, space.shared, scope) : chatWork(c.base, space.chatId)
  if (root && make) {
    fs.mkdirSync(path.dirname(root), { recursive: true, mode: 0o700 })
    fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  }
  return root
}

/** The folder that holds every work folder of a shared chat (one per people and view: sharedWork), or null */
function sharedWorkTop(chatId: string | null): string | null {
  if (!chatId) return null
  try { return path.dirname(sharedWork(srtConfig().base, chatId, 'k')) } catch { return null }
}

/** How a shared chat's work folder relates to the ones made for its earlier people (QA TC-6936): its commands start in a
 * folder keyed by who sees the chat and what they may open (sharedWorkOf), so a change of people starts a new one.
 *   fresh  an earlier folder is there and the one for the people now is not made yet: the files made before are not here
 *   after  the folder now was made after the earlier ones were last changed (a file asked for may have been made before)
 *   null   a personal chat, nothing earlier, or the earlier folder is the newer one (the people changed back)
 * Only names and times of the folders are looked at; nothing in them is opened. */
export function workFolderChange(ctx: AppContext, o: { userId: string; chatId: string | null; shared?: SharedRun }): 'fresh' | 'after' | null {
  if (!o.shared || !o.chatId) return null
  const top = sharedWorkTop(o.chatId)
  if (!top) return null
  let names: string[]
  try { names = fs.readdirSync(top) } catch { return null }
  const now = sharedWorkOf(ctx, o.chatId, o.userId, o.shared)
  const mine = now ? path.basename(now) : null
  const old = names.filter((n) => n !== mine)
  if (!old.length) return null
  let born: number | null = null
  try { if (now) { const st = fs.lstatSync(now); born = st.isDirectory() ? (st.birthtimeMs || st.ctimeMs) : null } } catch { born = null }
  if (born === null) return 'fresh'
  let last = 0
  for (const n of old) { try { last = Math.max(last, fs.lstatSync(path.join(top, n)).mtimeMs) } catch {} }
  return born >= last ? 'after' : null
}

/** Is `p` an absolute path inside an earlier work folder of this shared chat (not the one its commands use now)? */
export function inOldWorkFolder(ctx: AppContext, o: { userId: string; chatId: string | null; shared?: SharedRun }, p: string): boolean {
  if (!o.shared || !o.chatId || !p.startsWith('/')) return false
  const top = sharedWorkTop(o.chatId)
  if (!top) return false
  const tops = [top]
  try { tops.push(fs.realpathSync(top)) } catch {}
  const at = tops.find((t) => p.startsWith(t.replace(/\/+$/, '') + '/'))
  if (!at) return false
  const key = p.slice(at.replace(/\/+$/, '').length + 1).split('/')[0]
  const now = sharedWorkOf(ctx, o.chatId, o.userId, o.shared)
  return !!key && key !== (now ? path.basename(now) : null)
}

/** Do box_shell's commands of this person in this chat run in a work folder (made or not yet), not in a project folder? */
export function runsInWorkFolder(ctx: AppContext, o: { userId: string; chatId: string | null; project: { id: string; folderPath: string } | null; shared?: SharedRun }): boolean {
  const s = spaceAt(ctx, o, false)
  return !!s && inWorkFolder(srtConfig(), s)
}

function spaceAt(ctx: AppContext, o: { userId: string; chatId: string | null; project: { id: string; folderPath: string } | null; shared?: SharedRun }, make: boolean): Space | null {
  const c = srtConfig()
  const view = personView(ctx, o.userId)
  if (!view) return null
  const shared = o.shared ? { shared: o.shared } : {}
  if (o.shared && !o.chatId) return null
  // documents mode: always the chat's work folder, never a project folder (a shared project chat's too)
  const docs = isDocumentsMode(ctx, o.userId)
  const within = docs ? null : o.shared ? o.shared.within : o.project?.folderPath ?? null
  if (within !== null && within !== '' && (!o.shared || o.project?.folderPath === within)) {
    const root = path.join(ctx.files.fx.root, within)
    if (viewAccess(view, within) !== 'none' && fs.existsSync(root)) return { userId: o.userId, chatId: o.chatId, projectId: o.project?.id ?? null, root, ...shared }
  }
  if (!docs && o.shared && o.shared.within !== null) return null
  if (!o.chatId) return null
  // a shared chat: a work folder of its own for the people who see it now (never the private one, sharedWork)
  let root: string
  if (o.shared) {
    const w = sharedWorkOf(ctx, o.chatId, o.userId, o.shared)
    if (!w) return null
    root = w
  } else root = chatWork(c.base, o.chatId)
  if (make) {
    fs.mkdirSync(path.dirname(root), { recursive: true, mode: 0o700 })
    fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  }
  return { userId: o.userId, chatId: o.chatId, projectId: o.project?.id ?? null, root, ...shared }
}

// ---------------- one run ----------------

/** Whose home and logs a run uses: the shared chat's, or the person's. A shared run with no chat is refused. */
function runOwner(space: Pick<Space, 'userId' | 'chatId' | 'shared' | 'logKey'> & { root?: string }, runId?: string, teamRoot?: string): { userId: string; sharedChat: string | null; runId?: string; projectFolder: string | null; logKey: string | null } {
  if (space.shared && !space.chatId) throw new Error('a run of a shared chat needs its chat')
  // a person's run that starts in a team folder (a project folder): a home of its own for that folder (config.ts
  // projectHome; QA TC-4939), never the home of the person's own chats
  const projectFolder = !space.shared && teamRoot && space.root && space.root.startsWith(teamRoot + path.sep) ? space.root.slice(teamRoot.length + 1) : null
  return { userId: space.userId, sharedChat: space.shared ? space.chatId : null, ...(runId ? { runId } : {}), projectFolder, logKey: space.shared ? space.logKey ?? null : null }
}

/** The git wrapper (git-guard.ts) at <base>/devenv/bin/git, written when it is missing or differs. Server-owned and
 * read-only in a run. */
function writeGitWrapper(c: SrtConfig, platform: ReturnType<typeof runPlatform>) {
  const dir = devenvPaths(c.base).bin, file = path.join(dir, 'git')
  const src = gitWrapperSource({ node: SRT_PATHS.node, realGit: realGit(platform) })
  try { if (fs.readFileSync(file, 'utf8') === src) return } catch {}
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 })
  const tmp = `${file}.${process.pid}.${Date.now()}`
  fs.writeFileSync(tmp, src, { mode: 0o755 })
  fs.renameSync(tmp, file)
}

/** The box's default fonts (config.ts BOX_FONTS_CONF, BOX_MATPLOTLIBRC) at <base>/devenv/bin/fonts/, written when
 * missing or different; Linux only (a Mac's tools find Apple's fonts). Server-owned and read-only in a run. */
function writeBoxFonts(c: SrtConfig, platform: ReturnType<typeof runPlatform>) {
  // an office Mac: matplotlib's Korean font only (fontconfig is not used there)
  if (platform === 'darwin' && !runKit()) return
  const dir = boxFontsDir(c.base)
  for (const [name, src] of (platform === 'darwin' ? [['matplotlibrc', BOX_MATPLOTLIBRC_MAC]] as const : [['fonts.conf', BOX_FONTS_CONF], ['matplotlibrc', BOX_MATPLOTLIBRC]] as const)) {
    const file = path.join(dir, name)
    try { if (fs.readFileSync(file, 'utf8') === src) continue } catch {}
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 })
    const tmp = `${file}.${process.pid}.${Date.now()}`
    fs.writeFileSync(tmp, src, { mode: 0o644 })
    fs.renameSync(tmp, file)
  }
}

/** A shared chat's command, job or dev server ended: its own home and temp folder go (nothing of it reaches a later
 * run). Its logs folder is the chat's for its people (sharedLogs): its output files are removed one by one, a job's log
 * stays for the same people's next commands. */
function dropSharedRun(c: SrtConfig, space: Pick<Space, 'userId' | 'chatId' | 'shared'>, runId: string) {
  if (!space.shared) return
  const o = runOwner(space, runId)
  for (const d of [runHome(c.base, o), runTmp(c.base, o)]) try { fs.rmSync(d, { recursive: true, force: true }) } catch {}
}
/** A shared chat's job or dev server row ended (jobs.ts endRun): its run's home and temp folder go. */
export function dropRowRun(r: Pick<RunRow, 'shared_key' | 'chat_id' | 'user_id' | 'unit'>) {
  const runId = runIdOf(r.unit)
  if (!r.shared_key || !r.chat_id || !runId) return
  dropSharedRun(srtConfig(), { userId: r.user_id, chatId: r.chat_id, shared: NOBODY }, runId)
}

interface RunSpec { runId: string; space: Space; cwd: string; command: string; network: 'open' | 'offline'; offline?: boolean; once: readonly string[]; limits: { cpus: number; memoryMiB: number; pids: number }; runtimeMaxSec: number; stdoutFile: string; stderrFile: string; stage?: string }

function prepare(c: SrtConfig, space: Pick<Space, 'userId' | 'chatId' | 'shared' | 'root' | 'logKey'>, runId: string, teamRoot: string) {
  const p = devenvPaths(c.base)
  for (const d of [p.root, p.run, p.home, p.logs, p.homeProject]) fs.mkdirSync(d, { recursive: true, mode: 0o700 })
  writeGitWrapper(c, runPlatform())
  // `chromium` and the names people expect start the pinned browser (box-browser.ts); a failure leaves the system's
  try { writeBoxBrowser(p.bin, boxBrowser(runPlatform()), SRT_PATHS.node) } catch (e) { void e }
  // the document skills, read-only in a run; a failure leaves the AI on make_file's path
  try { if (runPlatform() === 'linux' || runKit()) writeDocSkills(p.bin) } catch (e) { void e }
  // a font preference never stops a command (runEnv leaves the fonts out when fonts.conf is missing)
  try { writeBoxFonts(c, runPlatform()) } catch { /* the system's fonts */ }
  // a shared chat's runs: a home and logs of their own per command (nothing of the person's, nothing of an earlier
  // command: docs/decisions/20261118-devenv-shared-chats.md)
  const o = runOwner(space, runId, teamRoot)
  if (o.sharedChat) for (const d of [p.chatHome, p.chatLogs, p.runTmp, path.join(p.chatHome, o.sharedChat), path.join(p.chatLogs, o.sharedChat)]) fs.mkdirSync(d, { recursive: true, mode: 0o700 })
  const home = runHome(c.base, o), logs = runLogs(c.base, o)
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  fs.mkdirSync(runTmp(c.base, o), { recursive: true, mode: 0o700 })
  fs.mkdirSync(logs, { recursive: true, mode: 0o750 })
  return { ...p, personHome: home, personLogs: logs }
}

/** The server's own folders and files, from the server's config (not from the base folder of the env): the data
 * folder (the DB), the sockets, the engine folders, the secrets, the config file and the TLS key. srtSettings hides the
 * ones outside the base folder, and settingsProblems refuses a run when one is not hidden. Only paths that exist. */
export function serverPaths(ctx: Pick<AppContext, 'config' | 'engineConfig'>): string[] {
  const out: (string | null | undefined)[] = [ctx.config.dataDir, ctx.engineConfig.runDir, ctx.engineConfig.agentRoot, ctx.config.engine.launcherSock,
    ctx.config.configFile, ctx.config.tls?.keyFile]
  try { out.push(resolveLayout(ctx.config).secretsDir) } catch {}
  return [...new Set(out.filter((p): p is string => !!p && path.isAbsolute(p) && fs.existsSync(p)).map((p) => path.resolve(p)))]
}

/** The source folders of the team's connected folders (connected.ts): srtSettings hides each one by name. */
export function connectedSources(ctx: Pick<AppContext, 'db'>): string[] {
  const rows = ctx.db.query('SELECT source FROM connected_folders').all() as { source: string }[]
  return [...new Set(rows.map((r) => r.source).filter((p) => path.isAbsolute(p)).map((p) => path.resolve(p)))]
}

/** Can this server run Full internet? full.mjs is installed (install-srt.sh). Without it Full internet acts as off:
 * the run gets the lists only (fail closed). */
export const fullAvailable = () => !!systemOverride || fs.existsSync(SRT_PATHS.cliFull)

/** macOS: where the dev server of a run listens (127.0.0.1 and the run's port), for the preview. macOS shares localhost,
 * so the server reaches it directly (Linux needs a port-forward into the run's network namespace: not built yet).
 * Null on Linux, or when the run is not there. */
export function previewTarget(runId: string): { host: '127.0.0.1'; port: number } | null {
  const sys = srtConfig().system as SrtSystem & { slotOf?: (id: string) => { port: number } | null }
  const s = sys.slotOf?.(runId)
  return s ? { host: '127.0.0.1', port: s.port } : null
}

/** The network of runs now: the team's choice cut to the plan ('offline' wins). */
export function networkNow(ctx: AppContext): 'open' | 'offline' {
  const l = limitsFor(ctx)
  return l.ok ? l.l.network : 'offline'
}

/** The network part of the person's runs now: the team's sites, her own sites and Full internet (sites.ts). */
export function personNetNow(ctx: AppContext, userId: string) {
  const p = personNet(ctx.db, userId, teamHosts(ctx))
  return { ...p, full: p.full && fullAvailable() }
}
const snapshotNow = (ctx: AppContext, userId: string): NetSnapshot => netSnapshot(teamSetting(ctx.db).extraDomains, personNetNow(ctx, userId))

/** The settings of a run, checked; throws with the reason when the run must not start. `once`: the sites allowed once
 * for this run (the turn's, or the row's). */
async function settingsFor(ctx: AppContext, c: SrtConfig, space: Space, runId: string, network: 'open' | 'offline', once: readonly string[] = [], stage?: string) {
  // documents mode: never a network, whatever the call or the team's sites say
  const docs = isDocumentsMode(ctx, space.userId)
  if (docs) { network = 'offline'; once = [] }
  const run = runWrites(ctx, c, space)
  // a shared chat: what the run may read joins the answer's record first, with who sees the chat now
  // (the view below is made for the same people as the record)
  const scope = space.shared ? sharedScopeNow(ctx, space.shared) : null
  // a shared chat's work folder belongs to the people it was made for: they changed since (spaceOf) -> no run
  if (space.shared && run.start === null && (!scope || space.root !== sharedWorkOf(ctx, space.chatId!, space.userId, space.shared, scope))) throw new Error('the people of this chat changed; run the command again')
  noteSharedRun(ctx, space, run, scope)
  const view = personView(ctx, space.userId, run, space.shared, scope)
  if (!view) throw new Error('the person cannot use the dev environment now')
  if (!rootAllowed(ctx, c, space, view)) throw new Error('the person cannot open the folder of this chat now')
  // a run in a project folder gets the chat's scratch folder too (scratchOf): writable, $TRINA_WORK, not a team folder
  const work = run.start === null ? space.root : scratchOf(ctx, c, space, scope, true)
  const hosts = teamHosts(ctx)
  // only this person's sites and switch: another person's never reach this run
  const person = docs ? { ...personNetNow(ctx, space.userId), sites: [] as string[], full: false } : personNetNow(ctx, space.userId)
  // a shared chat: no name of a folder some of its people may not open shows in a listing (srt/mounts.ts); the hash
  // below stays the view's. The entries given one by one are pinned (Linux: srt binds them, following links) and the
  // command checks them first inside the sandbox (entryGuard)
  const given = docs ? { read: [], write: [], denyRead: [], denyWrite: [] } : space.shared ? hideDeniedNames(view, ctx.files.fx.root) : view
  const pins = space.shared && runPlatform() === 'linux' ? entryPins(view, given, ctx.files.fx.root) : {}
  const input = {
    base: c.base, id: c.id, teamRoot: ctx.files.fx.root, userId: space.userId,
    view: given, start: run.start, work, network, sharedChat: runOwner(space).sharedChat, runId, projectFolder: runOwner(space, runId, ctx.files.fx.root).projectFolder, logKey: runOwner(space).logKey,
    extraDomains: teamSetting(ctx.db).extraDomains,
    userDomains: docs ? [] : [...person.sites, ...parseOnce(formatOnce(once), hosts)],
    full: docs ? false : person.full,
    denyHosts: hosts,
    denyAddrs: [...listEnv(process.env.MYCEL_DEV_ENV_DENY_ADDRS), ...await publicIps()],
    serverPaths: serverPaths(ctx),
    connectedSources: connectedSources(ctx),
    platform: runPlatform(),
    // a copy's stage folder: only for a run that starts in the work folder (a copy never goes into a team folder this
    // way, nor into a project chat's scratch folder)
    stage: stage && run.start === null ? stage : null,
    kit: runKit()?.root ?? null,
  }
  if (stage && run.start !== null) throw new Error('a copy goes only into a chat\'s work folder')
  const settings = srtSettings(input)
  const problems = settingsProblems(settings, input)
  if (problems.length) {
    // a shared chat: the reason names folders (a personal folder too) and goes to everyone in it: the log only
    if (space.shared) { ctx.log?.warn?.('devenv: refused settings of a shared chat run', { problems }); throw new Error('refused settings (see the server log)') }
    throw new Error(`refused settings: ${problems.join('; ')}`)
  }
  // every run on Linux: srt's places above what is given (the team root, groups/, every folder given entry by entry) and
  // its masks over hidden folders (users/, the group and project skills folders) are made read-only in the sandbox, so
  // a file made there fails instead of being lost in silence (mounts.ts lockFolders)
  const places = runPlatform() === 'linux' ? lockFolders(given, settings.filesystem.denyRead, ctx.files.fx.root) : []
  // the hash without the hidden skills folders (personView): as accessHash makes it
  const forHash = personView(ctx, space.userId, run, space.shared, scope, { hideSkills: false })
  if (!forHash) throw new Error('the person cannot use the dev environment now')
  return { settings, work, pins, places, hash: runHash(forHash, run, scope), net: netSnapshot(input.extraDomains, person) }
}

/** an office Mac's document kit, for the runs of this server (null on every other install, and in the tests' fake
 * systems unless they say darwin) */
const runKit = () => (runPlatform() === 'darwin' && documentsOnlyServer() ? docKit() : null)

async function spawnRun(ctx: AppContext, c: SrtConfig, s: RunSpec): Promise<{ pid: number; exited: Promise<{ code: number | null; signal: string | null }>; hash: string; net: NetSnapshot }> {
  const p = prepare(c, s.space, s.runId, ctx.files.fx.root)
  // the chat's own running jobs and dev servers this run may reach on localhost (macOS: their ports in the sandbox
  // profile; Linux: a bridge into this run's network namespace each, started below)
  // (none for a run with no network at all: a dev server of this chat has the network, devenv/tool.ts mustUndo)
  const reach = s.offline ? [] : reachTargets(ctx, s.space)
  const bridged = runPlatform() === 'darwin' ? [] : reach
  // Linux: a bridge listens only once the run's network namespace exists; the command waits for it a moment (bash's
  // /dev/tcp, at most 5 s per port; a program that is not bash goes on at once)
  const command = bridged.length ? `${bridgeWait(bridged.map((t) => t.port))}${s.command}` : s.command
  // the skill folders a run never writes are there while it lives, so srt mounts them read-only (placeholders.ts),
  // before the folder access is read
  let skills: string[] = []
  try { skills = runSkillFolders(runWrites(ctx, c, s.space), s.space.userId) } catch { /* settingsFor says why it cannot run */ }
  const releaseSkills = holdSkillFolders(ctx.files.fx.root, skills)
  let release = () => {}
  let dropGuard = () => {}
  let unsweep = () => {}
  try {
    const { settings, work, pins, places, hash, net } = await settingsFor(ctx, c, s.space, s.runId, s.network, s.once, s.stage)
    // the pinned entries and the folders to lock, in the run's own guard folder (made new, read-only in the run, removed
    // when it ends: never the TMPDIR, which an earlier run of the person can swap for a link), done by the command's
    // first line
    const g = runPlatform() === 'linux' ? runGuard(c.base, s.runId) : null
    if (runPlatform() === 'linux' && !g) throw new Error('a run needs its run id')
    if (g) dropGuard = makeGuardDir(g)
    const guard = g ? entryGuard(writePins(g, pins, places)) : ''
    // a cwd through a link out of the root folder is refused before the run (attack A10)
    const cwd = resolveRunCwd(s.space.root, s.cwd)
    if (!cwd) throw new Error('cwd must be a folder inside the folder of this chat')
    // a shared chat: a cwd in a folder the run does not show (a sub-folder some of its people may not open) is refused
    // with the same words as one that is not there (QA TC-4945)
    if (s.space.shared && !sharedCwdShown(ctx, s.space, cwd)) throw new Error('cwd must be a folder inside the folder of this chat')
    // git hooks (QA TC-5348): every file that git could run as a hook in the folders this run may write loses its exec
    // bit, now and when the run ends, so a hook another person's run left there never runs here, whatever the command
    // line sets (hook-sweep.ts). Also now: the folders other people's live runs may write that this run may read (a
    // hook written there after that run's last sweep). The run does not start when the folders cannot be checked
    const own = runOwner(s.space, s.runId, ctx.files.fx.root)
    const swept = sweepRoots(settings.filesystem.allowWrite, [runHome(c.base, own), runTmp(c.base, own)])
    const visible = visibleOf(settings.filesystem, ctx.files.fx.root)
    pruneLive(ctx)
    const before = [...new Set([...swept, ...othersLive(liveSweeps.values(), s.space.userId, visible)])]
    const sweptNow = await sweepHooks(before, { visible }).catch((e: Error) => { throw new Error(`${e.message}; the command did not run`) })
    if (sweptNow.length) ctx.log?.info?.('devenv: git hooks lost their exec bit before a run', { count: sweptNow.length })
    liveSweeps.set(s.runId, { userId: s.space.userId, roots: swept })
    const sweepAfter = () => { void sweepHooks(swept, { visible }).then((ch) => { if (ch.length) ctx.log?.info?.('devenv: git hooks lost their exec bit after a run', { count: ch.length }) }, (e: Error) => ctx.log?.warn?.('devenv: git hooks could not be checked after a run', { error: e.message })).finally(() => liveSweeps.delete(s.runId)) }
    unsweep = () => liveSweeps.delete(s.runId)
    const settingsFile = path.join(p.run, `${s.runId}.json`)
    fs.writeFileSync(settingsFile, JSON.stringify(settings), { mode: 0o600, flag: 'wx' })
    const exitFile = path.join(p.personLogs, `${s.runId}.exit`)
    // srt's write denies in the cwd stay in force while other runs share it (placeholders.ts)
    release = holdPlaceholders(cwd)
    const sp = await c.system.spawn({
    runId: s.runId, id: c.id, cwd, env: runEnv({ base: c.base, userId: s.space.userId, teamRoot: ctx.files.fx.root, work, platform: runPlatform(), sharedChat: runOwner(s.space).sharedChat, runId: s.runId, projectFolder: runOwner(s.space, s.runId, ctx.files.fx.root).projectFolder, logKey: runOwner(s.space).logKey, kit: runKit() }),
    limits: { cpus: s.limits.cpus, memoryMiB: s.limits.memoryMiB, pids: s.limits.pids, runtimeMaxSec: s.runtimeMaxSec }, exitFile, settingsFile, command: guard ? `${guard}\n${command}` : command,
    stdoutFile: s.stdoutFile, stderrFile: s.stderrFile, full: isFull(settings), writable: settings.filesystem.allowWrite, ...(s.stage ? { readable: [s.stage] } : {}),
    ...(runPlatform() === 'darwin' && reach.length ? { reach: reach.map((t) => ({ runId: t.runId, port: t.port })) } : {}),
    })
    const bridges = bridged.length ? startBridges(ctx, c, s.runId, bridged) : null
    return { ...sp, exited: sp.exited.finally(() => {
      release(); releaseSkills(); dropGuard(); bridges?.stop(); sweepAfter()
      // a killed browser's profile in a private chat's TMPDIR (a shared chat's TMPDIR goes as a whole)
      const tmp = runTmp(c.base, own)
      // (runs tracked again after a restart whose row has ended no longer count; if that cannot be read, nothing is removed)
      if (!s.space.shared) try { pruneLive(ctx); sweepAfterRun(tmp, runHome(c.base, own), s.runId, s.space.userId, liveSweeps) } catch { /* a later run's end */ }
    }), hash, net }
  } catch (e) { release(); releaseSkills(); dropGuard(); unsweep(); throw e }
}

// ---------------- a chat's own dev servers on localhost ----------------

/** A running job or dev server of this chat that a run in `space` may reach on localhost, and its port there. */
export interface ReachTarget { rowId: string; runId: string; name: string; kind: 'job' | 'server'; port: number }

/** Can a later command reach the chat's own dev server here? macOS: one localhost, each run's port is its slot's
 * (srt-mac.mjs). Linux: with the sandbox helper (port-forward and port-bridge), at the port the AI named. */
export function reachSupported(): boolean {
  const sys = srtConfig().system as SrtSystem & { slotOf?: unknown }
  return runPlatform() === 'darwin' ? typeof sys.slotOf === 'function' : !!sys.forward && !!sys.bridge
}

/** A job or dev server of this chat, or one of the person's own (not a shared chat's) in any chat, runs or waits to
 * start: it has the network, and a command may change the code it runs (a hot reload, files in users/<id>) */
export function chatRunsLive(ctx: AppContext, chatId: string, userId: string): boolean {
  try { return [...openRuns(ctx.db, 'running'), ...openRuns(ctx.db, 'waiting')].some((r) => r.chat_id === chatId || (r.user_id === userId && !r.shared_key)) } catch { return true }
}

/**
 * The ports a run in `space` may reach (docs/decisions/20261118-devenv-shared-jobs-mac-localhost.md): those of the
 * running jobs and dev servers of the same chat and folder, and only those whose view is this run's:
 *  - a person's own chat: the person's own rows that are not a shared chat's, with the access hash of a run here now
 *    (a run whose view is wider than this one's, from before the person's access narrowed, is never reached; the
 *    tracker stops it);
 *  - a shared chat: the chat's rows of the same people and view (shared_key), whoever started them.
 * macOS: the port of the row's slot (a slot that went to another run has no state for this run any more). Linux: the
 * port the AI named for the dev server. Nothing else on localhost: not the server's ports, not another chat's runs.
 */
export function reachTargets(ctx: AppContext, space: Space): ReachTarget[] {
  if (!space.chatId || !reachSupported()) return []
  const rows = openRuns(ctx.db, 'running').filter((r) => r.chat_id === space.chatId && r.root === space.root && r.unit)
  if (!rows.length) return []
  let mine: (r: RunRow) => boolean
  if (space.shared) {
    // the same people and view (the key, which counts reads and writes alike) and the same access hash as a run of this
    // person here now: a person who may only read the project never drives the dev server of one who may write it
    // (security review of #1336)
    const key = sharedLogKey(ctx, space), h = accessHash(ctx, space)
    if (!key || h === 'off') return []
    mine = (r) => r.shared_key === key && r.access === h
  } else {
    const h = accessHash(ctx, space)
    if (h === 'off') return []
    mine = (r) => !r.shared_key && r.user_id === space.userId && r.access === h
  }
  const sys = srtConfig().system as SrtSystem & { slotOf?: (id: string) => { port: number } | null }
  const mac = runPlatform() === 'darwin'
  const out: ReachTarget[] = []
  for (const r of rows) {
    if (!mine(r)) continue
    const runId = runIdOf(r.unit)
    const port = mac ? sys.slotOf?.(runId)?.port ?? null : r.port
    if (!runId || !port || previewPortProblem(port) || out.some((t) => t.port === port)) continue
    out.push({ rowId: r.id, runId, name: r.name, kind: r.kind, port })
  }
  return out.slice(0, 8)
}

/** Linux: the start of a command that waits until the bridges listen (each port at most 5 s). bash only. */
export const bridgeWait = (ports: readonly number[]) =>
  `if [ -n "$BASH_VERSION" ]; then for __p in ${ports.filter((p) => Number.isInteger(p) && p > 0 && p < 65536).join(' ')}; do for __i in $(seq 50); do (: </dev/tcp/127.0.0.1/$__p) 2>/dev/null && break; sleep 0.1; done; done; unset __p __i; fi; `

/** Linux: start a bridge into run `runId` for each target, through the target's forwarder. Stopped when the run ends. */
function startBridges(ctx: AppContext, c: SrtConfig, runId: string, targets: readonly ReachTarget[]): { stop(): void } {
  const live: Forwarder[] = []
  let stopped = false
  void (async () => {
    for (const t of targets) {
      if (stopped || !c.system.bridge) return
      const f = await forwarderFor(c, t.runId, t.port)
      if ('error' in f) { ctx.log?.warn?.('devenv: no forwarder for a bridge', { error: f.error }); continue }
      const b = await c.system.bridge({ runId, port: t.port, socket: f.socket }).catch((e) => ({ error: String((e as Error).message ?? e) }))
      if ('error' in b) { ctx.log?.warn?.('devenv: bridge did not start', { error: b.error }); continue }
      if (stopped) b.stop(); else live.push(b)
    }
  })()
  return { stop: () => { stopped = true; for (const b of live) b.stop() } }
}

function readHead(file: string, max: number): { text: string; cut: boolean } {
  let fd: number
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW) } catch { return { text: '', cut: false } }
  try {
    const buf = Buffer.alloc(max + 1)
    const n = fs.readSync(fd, buf, 0, max + 1, 0)
    return { text: buf.subarray(0, Math.min(n, max)).toString('utf8'), cut: n > max }
  } finally { fs.closeSync(fd) }
}

/** A command's output as the AI gets it (limits audit 1 #21): all of it up to `head + tail` bytes, else its first `head`
 * and its last `tail` bytes with a line that says how much was left out in between, so the error a long build prints
 * at its end is there. `head` and `tail` count characters of the hidden text. `redact` (the stored secrets of the turn, devenv/tool.ts) runs before the cuts, on each part with
 * REDACT_MARGIN bytes more past the cut, so a secret across a cut is hidden whole, never left half-shown. Neither part
 * ends inside a UTF-8 character; both cuts go to a line break when there is one near. */
export function readEnds(file: string, head: number, tail: number, redact: (s: string) => string = (x) => x): { text: string; cut: boolean } {
  let fd: number
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW) } catch { return { text: '', cut: false } }
  try {
    const size = fs.fstatSync(fd).size
    if (size <= head + tail) {
      const all = Buffer.alloc(size)
      const n = fs.readSync(fd, all, 0, size, 0)
      return { text: redact(all.subarray(0, n).toString('utf8')), cut: false }
    }
    const ha = Math.min(size, head + REDACT_MARGIN)
    const a = Buffer.alloc(ha)
    const na = fs.readSync(fd, a, 0, ha, 0)
    const tb = Math.min(size, tail + REDACT_MARGIN)
    const b = Buffer.alloc(tb)
    const nb = fs.readSync(fd, b, 0, tb, size - tb)
    // whole characters only at the window's edges, then hidden, then cut to its size (in characters of the hidden text)
    let startText = redact(utf8Whole(a.subarray(0, na), 'end'))
    let endText = redact(utf8Whole(b.subarray(0, nb), 'start'))
    startText = startText.slice(0, head).replace(/[\uD800-\uDBFF]$/, '')
    endText = endText.slice(Math.max(0, endText.length - tail)).replace(/^[\uDC00-\uDFFF]/, '')
    const lastNl = startText.lastIndexOf('\n')
    if (lastNl >= 0 && startText.length - lastNl <= LINE_SNAP) startText = startText.slice(0, lastNl + 1)
    const nl = endText.indexOf('\n')
    if (nl >= 0 && nl < LINE_SNAP) endText = endText.slice(nl + 1)
    const left = size - Buffer.byteLength(startText) - Buffer.byteLength(endText)
    return { text: `${startText}\n… (about ${Math.max(0, left)} bytes in the middle of this output were left out; the end follows) …\n${endText}`, cut: true }
  } finally { fs.closeSync(fd) }
}
/** how far a cut moves to reach a line break */
const LINE_SNAP = 4096
/** bytes read past each cut for the redaction (a stored secret is far shorter) */
const REDACT_MARGIN = 4096
/** a buffer cut at either end with no part of a UTF-8 character left there */
function utf8Whole(buf: Buffer, edge: 'start' | 'end'): string {
  if (edge === 'start') {
    let j = 0
    while (j < buf.length && j < 4 && (buf[j]! & 0xc0) === 0x80) j++
    return buf.subarray(j).toString('utf8')
  }
  let k = buf.length
  while (k > 0 && k > buf.length - 4 && (buf[k - 1]! & 0xc0) === 0x80) k--
  const lead = k > 0 ? buf[k - 1]! : 0
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1
  return (buf.length - (k - 1) < need ? buf.subarray(0, k - 1) : buf).toString('utf8')
}

function readTail(file: string, max: number): string {
  let fd: number
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW) } catch { return '' }
  try {
    const size = fs.fstatSync(fd).size
    const len = Math.min(size, max)
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, size - len)
    let t = buf.toString('utf8')
    if (size > max) t = t.slice(t.indexOf('\n') + 1)
    return t
  } finally { fs.closeSync(fd) }
}
const lastLine = (tail: string) => tail.trimEnd().split('\n').pop() ?? ''

/** the exit code that run-wrap wrote, or null */
export function readExit(file: string): number | null {
  const t = readHead(file, 16).text.trim()
  if (!/^\d{1,3}$/.test(t)) return null
  const n = Number(t)
  return n <= 255 ? n : null
}

const rm = (f: string) => { try { fs.rmSync(f, { force: true }) } catch {} }

/** The limits of a run: the team's wish, cut to the plan caps. */
function limitsFor(ctx: AppContext): { ok: true; l: ReturnType<typeof effectiveLimits> } | { ok: false; message: string } {
  const p = planState()
  if (!p.ok) return { ok: false, message: `the dev environment is not available: ${p.reason}` }
  const s = teamSetting(ctx.db)
  return { ok: true, l: effectiveLimits(s.limits, s.network, p.plan) }
}

async function withRootLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const before = rootLocks.get(root) ?? Promise.resolve()
  let release!: () => void
  const mine = new Promise<void>((r) => { release = r })
  const chain = before.then(() => mine)
  rootLocks.set(root, chain)
  await before
  try { return await fn() } finally {
    release()
    if (rootLocks.get(root) === chain) rootLocks.delete(root)
  }
}

/** Does a command or a change of this project folder run now? Commands of one project run one at a time (withRootLock). */
export const projectBusy = (root: string) => rootLocks.has(root)

/** Wait until no command runs in this project folder. False: the call was stopped while it waited. A command that waits
 * here holds no slot of the team's queue: it takes a ticket after this (tool.ts waitForSlot). */
export async function waitProjectFree(root: string, signal?: AbortSignal): Promise<boolean> {
  while (rootLocks.has(root)) {
    if (signal?.aborted) return false
    const chain = rootLocks.get(root)!
    await new Promise<void>((resolve) => {
      const done = () => { signal?.removeEventListener('abort', done); resolve() }
      signal?.addEventListener('abort', done, { once: true })
      void chain.then(done, done)
    })
  }
  return !signal?.aborted
}

/** Is there a command slot on the server? (maxRunning + 1 commands at the same time). The tool asks before the change
 * window, so a call over the limit is refused at once and does not wait. */
export function commandSlotFree(ctx: AppContext): { ok: true } | { ok: false; message: string } {
  const lim = limitsFor(ctx)
  if (!lim.ok) return lim
  const commands = [...active.values()].filter((a) => a.kind === 'command').length
  return commands >= lim.l.maxRunning + 1 ? { ok: false, message: 'busy: the dev environment is busy, try again in a minute' } : { ok: true }
}

/** Why no command or job can run now (a bad plan file), or null. A command asks before it waits in the queue, so a
 * broken plan is refused at once and does not look like a full queue (maxRunning 0) for 5 minutes. */
export function runProblem(ctx: AppContext): string | null {
  const lim = limitsFor(ctx)
  return lim.ok ? null : lim.message
}

/** A foreground command: the call waits for it. The answer is a RunExit (srt/types.ts), which tool.ts reads. */
export async function runCommand(ctx: AppContext, o: { space: Space; cwd: string; command: string; shown?: string; timeoutMs: number; signal?: AbortSignal; once?: readonly string[]; redact?: (s: string) => string
  /** a copy into the work folder (devenv/work-write.ts): its stage folder, read-only in this run */
  stage?: string
  /** no network at all for this run, whatever the team and the person allow (devenv/tool.ts: a command that went
   * without the room card, chat/turn.ts ownBoxRun) */
  offline?: boolean }): Promise<{ ok: true; value: RunExit } | { ok: false; message: string }> {
  const c = srtConfig()
  const lim = limitsFor(ctx)
  if (!lim.ok) return lim
  const slot = commandSlotFree(ctx)
  if (!slot.ok) return slot
  return withRootLock(o.space.root, async () => {
    // a shared chat: the logs folder of who sees it now (sharedLogKey); they cannot be loaded: no run
    const space = keyed(ctx, o.space)
    if (!space) return { ok: false as const, message: 'the person cannot use the dev environment now' }
    o = { ...o, space }
    const runId = newRunId()
    const p = prepare(c, o.space, runId, ctx.files.fx.root)
    const out = path.join(p.personLogs, `cmd-${runId}.out`), err = path.join(p.personLogs, `cmd-${runId}.err`), exitFile = path.join(p.personLogs, `${runId}.exit`)
    const started = Date.now()
    // the lists show this text to other people: the command with secrets hidden, as in a job's row
    const a: Active = { runId, space: o.space, kind: 'command', command: (o.shown ?? o.command).slice(0, 300), startedAt: new Date(started).toISOString(), pid: 0, stopReason: null }
    active.set(runId, a)
    let oom = false
    try {
      const sp = await spawnRun(ctx, c, {
        runId, space: o.space, cwd: o.cwd, command: o.command, network: o.offline ? 'offline' : lim.l.network, ...(o.offline ? { offline: true } : {}), once: o.offline ? [] : o.once ?? [],
        limits: lim.l, runtimeMaxSec: Math.ceil(o.timeoutMs / 1000) + 30, stdoutFile: out, stderrFile: err, ...(o.stage ? { stage: o.stage } : {}),
      })
      a.pid = sp.pid
      a.access = accessHashFrom(ctx, o.space.userId, sp.hash)
      const stop = (why: EndReason) => { if (!a.stopReason) { a.stopReason = why; void c.system.stop(runId, sp.pid) } }
      const t = setTimeout(() => stop('timeout'), o.timeoutMs)
      const onAbort = () => stop('stopped')
      o.signal?.addEventListener('abort', onAbort, { once: true })
      // the unit's cgroup goes away when the run ends, so its OOM count is read while it runs
      const watch = setInterval(() => { if ((c.system.oomKills(runId) ?? 0) > 0) oom = true }, 1000)
      const ended = await sp.exited
      clearTimeout(t); clearInterval(watch); o.signal?.removeEventListener('abort', onAbort)
      if ((c.system.oomKills(runId) ?? 0) > 0) oom = true
      const u = await c.system.unit(runId)
      if (u.result === 'oom-kill') oom = true
      if (u.state === 'failed') await c.system.forget(runId)
      const code = readExit(exitFile)
      const so = readEnds(out, OUT_READ / 2, OUT_READ / 2, o.redact), se = readEnds(err, OUT_READ / 2, OUT_READ / 2, o.redact)
      const signal = a.stopReason === 'timeout' ? 'timeout' : a.stopReason === 'setting' ? 'setting' : a.stopReason ? 'stopped' : oom ? 'oom' : ''
      return { ok: true as const, value: { ev: 'exit' as const, code: code ?? ended.code ?? 137, signal, stdout: so.text, stderr: se.text, truncated: so.cut || se.cut, ms: Date.now() - started } }
    } catch (e) {
      return { ok: false as const, message: (e as Error).message.slice(0, 300) }
    } finally {
      active.delete(runId)
      rm(out); rm(err); rm(exitFile); rm(path.join(p.run, `${runId}.json`))
      dropSharedRun(c, o.space, runId)
    }
  })
}

// ---------------- jobs and dev servers (rows) ----------------

export interface RunRow { id: string; user_id: string; chat_id: string | null; project_id: string | null; turn_id: string | null; name: string; command: string; root: string; cwd: string; started_at: string; run_at: string | null; state: 'waiting' | 'running' | 'ended'; kind: 'job' | 'server'; unit: string; access: string; last_line: string; log_tail: string; once_domains: string; net: string
  /** '' for a person's own chat; a shared chat's run: the key of its people and view (sharedLogKey, migration 421) */
  shared_key: string
  /** the port the AI named for a dev server, or null */
  port: number | null }
export const RCOLS = 'id, user_id, chat_id, project_id, turn_id, name, command, root, cwd, started_at, run_at, state, kind, unit, access, last_line, log_tail, once_domains, net, shared_key, port'

const openRuns = (db: Database, state: 'waiting' | 'running', kind?: 'job' | 'server') =>
  db.query(`SELECT ${RCOLS} FROM dev_env_runs WHERE ended_at IS NULL AND state = ? ${kind ? 'AND kind = ?' : ''} ORDER BY started_at, id`).all(...(kind ? [state, kind] : [state])) as RunRow[]
/** The space of a row: a shared chat's with who sees that chat now (sharedResolver), read again for every check */
const spaceOfRow = (ctx: AppContext, r: RunRow): Space => ({ userId: r.user_id, chatId: r.chat_id, projectId: r.project_id, root: r.root,
  ...(r.shared_key ? { shared: sharedOfChat(ctx, r.chat_id), logKey: r.shared_key } : {}) })

const runIdOf = runIdOfUnit
/** the logs folder of a row: the person's, or a shared chat's for the row's people (sharedLogs) */
const rowLogs = (c: SrtConfig, r: Pick<RunRow, 'user_id' | 'chat_id' | 'shared_key'>) => (r.shared_key && r.chat_id ? sharedLogs(c.base, r.chat_id, r.shared_key) : personLogs(c.base, r.user_id))
const logFile = (c: SrtConfig, r: Pick<RunRow, 'user_id' | 'chat_id' | 'shared_key' | 'name'>) => path.join(rowLogs(c, r), `${r.name}.log`)

/** Does a job or dev server with this log name still run or wait in this log folder? (A person's log is per person; a
 * shared chat's per chat and key.) */
export function runNameInUse(ctx: AppContext, space: Space, name: string): boolean {
  if (!space.shared) return !!ctx.db.query("SELECT 1 FROM dev_env_runs WHERE user_id = ? AND name = ? AND shared_key = '' AND ended_at IS NULL").get(space.userId, name)
  const key = sharedLogKey(ctx, space)
  return !key || !!ctx.db.query('SELECT 1 FROM dev_env_runs WHERE chat_id = ? AND name = ? AND shared_key = ? AND ended_at IS NULL').get(space.chatId, name, key)
}

export type SubmitResult = { ok: true; state: 'running' | 'waiting'; position: number | null; rowId: string } | { ok: false; message: string }

/** The command of a row that has not started: a file in the run folder (0600, hidden from the sandbox). The row keeps
 * only the text with secrets hidden (`shown`). */
const commandFile = (c: SrtConfig, rowId: string) => path.join(devenvPaths(c.base).run, `${rowId}.cmd`)
function keepCommand(rowId: string, command: string) {
  const c = srtConfig()
  fs.mkdirSync(devenvPaths(c.base).run, { recursive: true, mode: 0o700 })
  fs.writeFileSync(commandFile(c, rowId), command, { mode: 0o600 })
}
function takeCommand(c: SrtConfig, rowId: string): string | null {
  const f = commandFile(c, rowId)
  try { const t = fs.readFileSync(f, 'utf8'); rm(f); return t } catch { return null }
}

interface NewRow { space: Space; name: string; turnId: string; command: string; shown: string; cwd: string; once?: readonly string[]
  /** a dev server: the port the AI named */
  port?: number }
function insertRow(ctx: AppContext, j: NewRow, kind: 'job' | 'server', shared: { access: string; key: string } | null): string {
  const id = newId()
  keepCommand(id, j.command)
  // the once-allowed sites go with the row: a waiting job builds its settings later, outside the turn
  ctx.db.query('INSERT INTO dev_env_runs (id, user_id, chat_id, project_id, turn_id, kind, name, command, root, cwd, state, started_at, ai_told_at, once_domains, access, shared_key, port) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, j.space.userId, j.space.chatId, j.space.projectId, j.turnId, kind, j.name, j.shown.slice(0, 500), j.space.root, j.cwd, 'waiting', new Date().toISOString(), kind === 'server' ? new Date().toISOString() : null, formatOnce(j.once ?? []),
      shared?.access ?? '', shared?.key ?? '', kind === 'server' && j.port ? j.port : null)
  return id
}

/**
 * A shared chat's job or dev server is asked for (docs/decisions/20261118-devenv-shared-jobs-mac-localhost.md): what it
 * may read joins this answer's record with who sees the chat now, as for a command, and the row keeps the access hash
 * and the key of those people and their view. The run starts only while they are the same (startRow), and the tracker
 * stops it when they change. A shared chat's work folder for other people than now: refused.
 */
function sharedRowStart(ctx: AppContext, space: Space): { ok: true; access: string; key: string } | { ok: false; message: string } {
  const c = srtConfig()
  let run: RunWrites
  try { run = runWrites(ctx, c, space) } catch (e) { return { ok: false, message: (e as Error).message } }
  const scope = sharedScopeNow(ctx, space.shared!)
  if (run.start === null && (!scope || space.root !== sharedWorkOf(ctx, space.chatId!, space.userId, space.shared!, scope))) return { ok: false, message: 'the people of this chat changed; run the command again' }
  try { noteSharedRun(ctx, space, run, scope) } catch (e) { return { ok: false, message: (e as Error).message } }
  const access = accessHash(ctx, space), key = sharedLogKey(ctx, space)
  if (access === 'off' || !key) return { ok: false, message: 'the person cannot use the dev environment now' }
  return { ok: true, access, key }
}

/** Start a job, or put it in the queue. `shown` is the command with secrets hidden: the text of the row. */
export async function submitJob(ctx: AppContext, j: NewRow): Promise<SubmitResult> {
  const lim = limitsFor(ctx)
  if (!lim.ok) return lim
  const waiting = withoutTickets(ctx.db, openRuns(ctx.db, 'waiting'))
  if (waiting.filter((r) => r.user_id === j.space.userId).length >= MAX_WAITING_PER_PERSON) return { ok: false, message: `queue full: ${MAX_WAITING_PER_PERSON} of your jobs wait already. Wait for one to start, or stop one.` }
  if (waiting.length >= MAX_WAITING_SERVER) return { ok: false, message: `queue full: ${MAX_WAITING_SERVER} jobs wait on this server. Try again later.` }
  const shared = j.space.shared ? sharedRowStart(ctx, j.space) : null
  if (shared && !shared.ok) return shared
  const id = insertRow(ctx, j, 'job', shared)
  await startWaiting(ctx)
  const row = ctx.db.query('SELECT state, ended_at, end_note FROM dev_env_runs WHERE id = ?').get(id) as { state: string; ended_at: string | null; end_note: string }
  if (row.ended_at) return { ok: false, message: row.end_note || 'the job could not start' }
  if (row.state === 'running') return { ok: true, state: 'running', position: null, rowId: id }
  return { ok: true, state: 'waiting', position: placeInLine(ctx, id), rowId: id }
}

/** One start at a time. The tracker, submitJob and every box_shell call (pollSrt) start waiting jobs; two of them
 * must not take the same row (the second one ended a running job as "lost" and left its scope with no row), or
 * start more than maxRunning. */
let startChain: Promise<unknown> = Promise.resolve()
function oneStart<T>(fn: () => Promise<T>): Promise<T> {
  const next = startChain.then(fn, fn)
  startChain = next.catch(() => {})
  return next
}

/** Start a dev server now, or refuse (no queue). */
export function startServer(ctx: AppContext, j: NewRow): Promise<{ ok: true; rowId: string; port: number | null } | { ok: false; message: string }> {
  return oneStart(() => startServerNow(ctx, j))
}
async function startServerNow(ctx: AppContext, j: NewRow): Promise<{ ok: true; rowId: string; port: number | null } | { ok: false; message: string }> {
  const lim = limitsFor(ctx)
  if (!lim.ok) return lim
  const servers = openRuns(ctx.db, 'running', 'server')
  const mine = servers.filter((r) => (j.space.chatId ? r.chat_id === j.space.chatId : r.root === j.space.root))
  if (mine.length) return { ok: false, message: `a dev server runs in this chat already (${mine.map((r) => r.name).join(', ')}). Stop it first (the dev environment list, or ask the person).` }
  if (servers.length >= lim.l.maxRunning) return { ok: false, message: `${PREVIEW_FULL} (${servers.length} dev servers run on this server, the most it allows.)` }
  const shared = j.space.shared ? sharedRowStart(ctx, j.space) : null
  if (shared && !shared.ok) return shared
  const id = insertRow(ctx, j, 'server', shared)
  const row = ctx.db.query(`SELECT ${RCOLS} FROM dev_env_runs WHERE id = ?`).get(id) as RunRow
  const r = await startRow(ctx, row)
  if (!r.ok) return r
  // where a later command of this chat reaches it: macOS the run's own port ($PORT), Linux the port the AI named
  const unit = (ctx.db.query('SELECT unit FROM dev_env_runs WHERE id = ?').get(id) as { unit: string } | null)?.unit ?? ''
  const sys = srtConfig().system as SrtSystem & { slotOf?: (id: string) => { port: number } | null }
  const port = !reachSupported() ? null : runPlatform() === 'darwin' ? sys.slotOf?.(runIdOf(unit))?.port ?? null : j.port ?? null
  return { ok: true, rowId: id, port }
}

async function startRow(ctx: AppContext, row: RunRow): Promise<{ ok: true } | { ok: false; message: string }> {
  const c = srtConfig()
  // the person must still be allowed at the start (the setting or the folder rules can change while a job waits);
  // spawnRun builds the folder access again and checks the root
  // jobs and dev servers are the dev environment's alone (documents mode runs foreground commands only)
  if (!mayUseDevEnv(ctx.db, ctx.files, row.user_id)) {
    takeCommand(c, row.id)
    endRow(ctx, row.id, { code: null, reason: 'setting', tail: '', lastLine: '' })
    return { ok: false, message: 'the dev environment is off for this person now' }
  }
  const lim = limitsFor(ctx)
  if (!lim.ok) { takeCommand(c, row.id); endRow(ctx, row.id, { code: null, reason: 'setting', tail: '', lastLine: '' }); return lim }
  const command = takeCommand(c, row.id)
  if (command === null) { endRow(ctx, row.id, { code: null, reason: 'lost', tail: '', lastLine: '' }); return { ok: false, message: 'the command of this job is gone' } }
  const runId = newRunId()
  const log = logFile(c, row)
  let space = spaceOfRow(ctx, row)
  if (row.shared_key) {
    // a shared chat's job: its reads were recorded with the people who saw the chat when it was asked for (submitJob);
    // it starts only while they and their view are still those (it may have waited in the queue)
    if (accessHash(ctx, space) !== row.access || sharedLogKey(ctx, space) !== row.shared_key) {
      takeCommand(c, row.id)
      endRow(ctx, row.id, { code: null, reason: 'setting', tail: '', lastLine: '' })
      return { ok: false, message: 'the people of this chat or their access changed; run it again' }
    }
    space = { ...space, shared: { ...space.shared!, noteReads: () => true, noteCopied: () => true } }
  }
  prepare(c, space, runId, ctx.files.fx.root)
  rm(log)
  // from the view's making (spawnRun) until the row says running, the run counts as alive: a folder share added in
  // between would otherwise miss a run whose view lets it write there (alive.ts, files/folder-shares.ts)
  const started = startingRun(row.user_id)
  try {
    const sp = await spawnRun(ctx, c, {
      runId, space, cwd: row.cwd, command, network: lim.l.network, once: parseOnce(row.once_domains ?? '', teamHosts(ctx)), limits: lim.l,
      runtimeMaxSec: row.kind === 'server' ? SERVER_MAX_SEC : JOB_MAX_SEC, stdoutFile: log, stderrFile: log,
    })
    active.set(runId, { runId, space, kind: row.kind, command: row.command.slice(0, 300), startedAt: new Date().toISOString(), pid: sp.pid, stopReason: null, rowId: row.id })
    void sp.exited.then(() => { const a = active.get(runId); if (a) active.delete(runId) })
    const set = ctx.db.query("UPDATE dev_env_runs SET state = 'running', run_at = ?, unit = ?, access = ?, net = ? WHERE id = ? AND ended_at IS NULL").run(new Date().toISOString(), unitName(runId), accessHashFrom(ctx, row.user_id, sp.hash), JSON.stringify(sp.net), row.id)
    if (!set.changes) {
      // the row ended while the run started (a stop of a waiting job): no run may live with no open row
      const a = active.get(runId)
      if (a) a.stopReason = 'stopped'
      await c.system.stop(runId, sp.pid)
      active.delete(runId)
      return { ok: false, message: 'the job was stopped before it started' }
    }
    return { ok: true }
  } catch (e) {
    const m = (e as Error).message.slice(0, 300)
    endRow(ctx, row.id, { code: null, reason: /cannot use|cannot open/.test(m) ? 'setting' : 'lost', tail: m, lastLine: '' })
    return { ok: false, message: m }
  } finally { started() }
}
/** the hash of the view the run started with (accessHash's format) */
const accessHashFrom = (ctx: AppContext, userId: string, viewHashValue: string) => (mayRunCommands(ctx.db, ctx.files, userId) ? viewHashValue : 'off')

/** Give free slots to waiting jobs and commands (queue.ts: one queue, fair share). Expired jobs end; tickets with no
 * waiting call end (lost). */
export function startWaiting(ctx: AppContext): Promise<void> {
  return oneStart(() => startWaitingNow(ctx))
}
const slotsMax = () => { const p = planState(); return p.ok ? (p.plan?.maxRunning ?? NO_PLAN_MAX_RUNNING) : 0 }
/** the person of every held slot: running jobs (rows of any process) and commands of this process */
const slotHolders = (db: Database) => [...openRuns(db, 'running', 'job').map((r) => r.user_id), ...heldCommands()]
async function startWaitingNow(ctx: AppContext): Promise<void> {
  const max = slotsMax()
  endOrphanTickets(ctx.db)
  const tickets = ticketIds(ctx.db)
  for (const w of openRuns(ctx.db, 'waiting', 'job')) {
    if (!tickets.has(w.id) && Date.now() - Date.parse(w.started_at) > WAIT_MAX_MS) { takeCommand(srtConfig(), w.id); endRow(ctx, w.id, { code: null, reason: 'expired', tail: '', lastLine: '' }) }
  }
  // one start per round, read again each round: a start awaits, and a stop may end a row meanwhile. Each round starts
  // an entry (a slot less) or ends one (an entry less), so the loop ends.
  for (;;) {
    const waiting = openRuns(ctx.db, 'waiting', 'job')
    const id = pickNext(waiting.map((r) => ({ id: r.id, userId: r.user_id })), slotHolders(ctx.db), max, servedNow())
    if (!id) return
    const w = waiting.find((r) => r.id === id)!
    // a ticket added while a start awaited is in the DB, not in `tickets`
    if (ticketIds(ctx.db).has(id)) { grantTicket(ctx.db, id); continue }
    noteServed(w.user_id)
    await startRow(ctx, w)
  }
}

/** The place in line of a waiting job or command (1 = next), from the start order of queue.ts. Null: not waiting. */
export function placeInLine(ctx: AppContext, rowId: string): number | null {
  const i = queueOrder(ctx).indexOf(rowId)
  return i < 0 ? null : i + 1
}
const queueOrder = (ctx: AppContext) => startOrder(openRuns(ctx.db, 'waiting', 'job').map((r) => ({ id: r.id, userId: r.user_id })), slotHolders(ctx.db), slotsMax(), servedNow())

/** what a dev server over the limit says (the AI passes it on to the person) */
export const PREVIEW_FULL = 'Preview is full. Close another preview or wait.'

/** What the tracker reads for one running row: still running, or ended with a code and a reason. */
async function rowStatus(c: SrtConfig, r: RunRow): Promise<{ running: true; tail: string } | { running: false; code: number | null; reason: EndReason; tail: string }> {
  const runId = runIdOf(r.unit)
  const log = logFile(c, r)
  const tail = readTail(log, TAIL_BYTES)
  if (!runId) return { running: false, code: null, reason: 'lost', tail }
  const exitFile = path.join(rowLogs(c, r), `${runId}.exit`)
  const code = readExit(exitFile)
  const a = active.get(runId)
  if (code !== null) {
    rm(exitFile); rm(path.join(devenvPaths(c.base).run, `${runId}.json`))
    return { running: false, code, reason: a?.stopReason ?? 'exit', tail }
  }
  const u = await c.system.unit(runId)
  // a run this process just spawned: systemd may not know its unit yet (''), or know it but not have started it yet
  // (inactive; an instance of the template is always known). While its process (systemd-run, or systemctl start
  // --wait) lives it runs; ending it here would delete its settings file before srt reads it
  if (u.state === 'active' || u.state === 'activating' || u.state === 'deactivating' || (a && !a.stopReason && (u.state === '' || u.state === 'inactive') && a.pid && alive(a.pid))) {
    // a large log: cut it, the AI reads only the end
    try { if (fs.statSync(log).size > LOG_MAX_BYTES) { fs.truncateSync(log, 0); fs.appendFileSync(log, '(log cut at 64 MiB)\n') } } catch {}
    return { running: true, tail }
  }
  if (u.state === 'failed') await c.system.forget(runId)
  rm(path.join(devenvPaths(c.base).run, `${runId}.json`))
  // run-wrap writes the exit file before its unit ends: a run that ended after the first read has it now (QA TC-6586)
  const late = readExit(exitFile)
  if (late !== null) { rm(exitFile); return { running: false, code: late, reason: a?.stopReason ?? 'exit', tail: readTail(log, TAIL_BYTES) } }
  const reason: EndReason = a?.stopReason ?? (u.result === 'oom-kill' ? 'oom' : u.result === 'timeout' ? 'timeout' : 'lost')
  return { running: false, code: null, reason, tail }
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

/** The tracker's step for the srt runner: end rows whose run ended, stop runs whose person's access changed, stop idle
 * dev servers, stop everything at the disk floor. Returns the RunJob view of each row it read, for jobs.ts, and the
 * people whose runs stopped at the disk floor. */
export async function pollRuns(ctx: AppContext, filter?: { chatId?: string; userId?: string }): Promise<{ rows: Map<string, RunJob & { reason?: EndReason }>; diskStopped: string[] }> {
  const c = srtConfig()
  const out = new Map<string, RunJob & { reason?: EndReason }>()
  const room = storageRoom(0)
  const diskStopped = room && !room.ok ? await stopAll(ctx, 'disk') : []
  // the access of a run depends on the person and on its starting folder (only that folder is writable)
  const hashes = new Map<string, string>()
  const nets = new Map<string, NetSnapshot>()
  // a foreground command too: its person may lose the folder (taken out of the project) or the dev environment while
  // it runs, and it has the folder open for writing until it ends
  for (const a of [...active.values()]) {
    if (a.kind !== 'command' || !a.access || a.stopReason) continue
    if (filter?.chatId && a.space.chatId !== filter.chatId) continue
    if (filter?.userId && a.space.userId !== filter.userId) continue
    // a shared chat's command: its own key (the view depends on who sees that chat)
    const key = `${a.space.userId}\0${a.space.root}${a.space.shared ? `\0${a.space.chatId}` : ''}`
    if (!hashes.has(key)) hashes.set(key, accessHash(ctx, a.space))
    if (hashes.get(key) !== a.access) { a.stopReason = 'setting'; try { await c.system.stop(a.runId, a.pid) } catch (e) { ctx.log?.warn?.('devenv: stopping a command failed', { error: (e as Error).message }) } }
  }
  for (const r of openRuns(ctx.db, 'running')) {
    if (filter?.chatId && r.chat_id !== filter.chatId) continue
    if (filter?.userId && r.user_id !== filter.userId) continue
    // the run's access: built again each poll, once per person and starting folder
    // a shared chat's row: its own key (the view depends on who sees that chat)
    const key = `${r.shared_key ? `row\0${r.chat_id}\0` : ''}${r.user_id}\0${r.root}`
    if (!hashes.has(key)) hashes.set(key, accessHash(ctx, spaceOfRow(ctx, r)))
    if (r.access && hashes.get(key) !== r.access) { await stopRow(ctx, r, 'setting'); continue }
    // the network got narrower (the person removed a site, turned Full internet off; the team removed a site): stop it.
    // A row from an older build has no snapshot and is not checked
    const started = parseSnapshot(r.net ?? '')
    if (started) {
      if (!nets.has(r.user_id)) nets.set(r.user_id, snapshotNow(ctx, r.user_id))
      if (netNarrowed(started, nets.get(r.user_id)!)) { await stopRow(ctx, r, 'setting'); continue }
    }
    const s = await rowStatus(c, r)
    const seconds = Math.round((Date.now() - Date.parse(r.run_at ?? r.started_at)) / 1000)
    // the time limit of a job or dev server: systemd 255 cannot give a run unit its own RuntimeMaxSec (the template
    // has the longest kind's), so the tracker stops it
    if (s.running && seconds > (r.kind === 'server' ? SERVER_MAX_SEC : JOB_MAX_SEC)) { await stopRow(ctx, r, 'timeout'); continue }
    if (s.running) {
      out.set(r.id, { name: r.name, state: 'running', code: null, seconds, tail: s.tail, lastLine: lastLine(s.tail) })
      if (r.kind === 'server') await idleCheck(ctx, c, r)
    } else {
      out.set(r.id, { name: r.name, state: 'ended', code: s.code, seconds, tail: s.tail, lastLine: lastLine(s.tail), why: END_NOTE[s.reason], reason: s.reason })
      const runId = runIdOf(r.unit)
      active.delete(runId); idleSince.delete(runId); closeForwarders(runId)
    }
  }
  return { rows: out, diskStopped }
}

async function idleCheck(ctx: AppContext, c: SrtConfig, r: RunRow) {
  const runId = runIdOf(r.unit)
  const usec = c.system.cpuUsec(runId)
  if (usec === null) return
  const now = Date.now()
  const prev = idleSince.get(runId)
  if (!prev) { idleSince.set(runId, { usec, at: now, since: null }); return }
  const share = (usec - prev.usec) / 1000 / Math.max(1, now - prev.at)
  const idleMin = teamSetting(ctx.db).limits.idleStopMin
  // idle: under 2 % CPU and no preview request for idleStopMin
  const previewed = (lastPreview.get(runId) ?? 0) > now - idleMin * 60_000
  const since = share < IDLE_CPU_SHARE && !previewed ? (prev.since ?? prev.at) : null
  idleSince.set(runId, { usec, at: now, since })
  if (since !== null && now - since >= idleMin * 60_000) await stopRow(ctx, r, 'idle')
}

async function stopRow(ctx: AppContext, r: RunRow, reason: EndReason) {
  const c = srtConfig()
  // a command's ticket: the waiting call ends (cancelled or stopped); no notice, no result as a job
  if (r.state === 'waiting' && cancelTicket(ctx.db, r.id, reason)) return
  if (r.state === 'waiting') { takeCommand(c, r.id); endRow(ctx, r.id, { code: null, reason, tail: '', lastLine: '' }); return }
  const runId = runIdOf(r.unit)
  const a = active.get(runId)
  // a run that already ended by itself (its exit file is there) ends with its own code, not as stopped: its end can
  // change the access hash this stop came from (its skills placeholder goes; QA TC-6586)
  const code = runId ? readExit(path.join(rowLogs(c, r), `${runId}.exit`)) : null
  if (code === null) {
    if (a) a.stopReason = reason
    if (runId) await c.system.stop(runId, a?.pid)
  }
  const tail = readTail(logFile(c, r), TAIL_BYTES)
  rm(path.join(rowLogs(c, r), `${runId}.exit`))
  endRow(ctx, r.id, { code, reason: code === null ? reason : 'exit', tail, lastLine: lastLine(tail) })
  active.delete(runId); idleSince.delete(runId); closeForwarders(runId)
}

/** An open run by its row id or run id (a command of this process). */
export function findRun(ctx: AppContext, id: string): { row: RunRow } | { command: { runId: string; space: Space } } | null {
  const row = ctx.db.query(`SELECT ${RCOLS} FROM dev_env_runs WHERE id = ? AND ended_at IS NULL`).get(id) as RunRow | null
  if (row) return { row }
  const a = RUN_ID_RE.test(id) ? active.get(id) : undefined
  return a && a.kind === 'command' ? { command: { runId: a.runId, space: a.space } } : null
}

/** Stop one run by its row id or run id. False when there is no such run here. The caller checks who may stop it. */
export async function stopRun(ctx: AppContext, id: string, reason: EndReason = 'stopped'): Promise<boolean> {
  const f = findRun(ctx, id)
  if (!f) return false
  if ('row' in f) { await stopRow(ctx, f.row, reason); return true }
  const a = active.get(f.command.runId)!
  a.stopReason = reason
  await srtConfig().system.stop(a.runId, a.pid)
  return true
}

/** Stop every run (and waiting job) that matches: a project's, a person's, or all. */
export async function stopWhere(ctx: AppContext, match: (s: { id: string; userId: string; projectId: string | null; chatId: string | null }) => boolean, reason: EndReason): Promise<string[]> {
  const people = new Set<string>()
  const rows = ctx.db.query(`SELECT ${RCOLS} FROM dev_env_runs WHERE ended_at IS NULL`).all() as RunRow[]
  for (const r of rows) if (match({ id: r.id, userId: r.user_id, projectId: r.project_id, chatId: r.chat_id })) { people.add(r.user_id); await stopRow(ctx, r, reason) }
  for (const a of active.values()) if (a.kind === 'command' && match({ ...a.space, id: a.runId })) { people.add(a.space.userId); a.stopReason = reason; await srtConfig().system.stop(a.runId, a.pid) }
  return [...people]
}

/** Stop everything (the disk floor, the team setting changed). Returns the people whose runs stopped. */
export const stopAll = (ctx: AppContext, reason: EndReason) => stopWhere(ctx, () => true, reason)

/** After a restart: a trina-dev unit with no open row and no command of this process is stopped. Rows with no unit
 * end at the next poll (lost). */
export async function reconcile(ctx: AppContext): Promise<void> {
  const c = srtConfig()
  // the calls of waiting commands went with the old process
  endOrphanTickets(ctx.db)
  // so did the preview forwarders (their stdin closed): their sockets stay as files
  try { for (const f of fs.readdirSync(devenvPaths(c.base).run)) if (PREVIEW_SOCK_RE.test(f) && ![...forwarders.keys()].some((k) => f === sockName(k))) rm(path.join(devenvPaths(c.base).run, f)) } catch {}
  const known = new Set((ctx.db.query("SELECT unit FROM dev_env_runs WHERE ended_at IS NULL AND unit != ''").all() as { unit: string }[]).map((r) => r.unit))
  for (const a of active.values()) known.add(unitName(a.runId))
  for (const u of await c.system.units()) {
    if (known.has(u)) continue
    const runId = runIdOf(u)
    await c.system.stop(runId)
    await c.system.forget(runId)
  }
  // git hooks (QA TC-5348) after a restart: the runs that live on are tracked again as other people's live runs, and the
  // whole team folder is checked once (a run that was live then never had its sweep after it ended). Not awaited
  for (const r of openRuns(ctx.db, 'running')) { const id = runIdOf(r.unit); if (id && !liveSweeps.has(id)) liveSweeps.set(id, { userId: r.user_id, roots: rowRoots(ctx, r), rowId: r.id }) }
  const root = ctx.files.fx.root
  // links are not followed here (no person's view: a link's target might be a file its maker may not open)
  void sweepHooks([root], { timeoutMs: 15 * 60_000, visible: { read: [] } })
    .then((ch) => { if (ch.length) ctx.log?.info?.('devenv: git hooks lost their exec bit at start', { count: ch.length }) }, (e: Error) => ctx.log?.warn?.('devenv: git hooks could not be checked at start', { error: e.message }))
}

/** The folders a run of this row may write: its folder (a project folder or the chat's work folder) and the person's own
 * folder (Q0 (b)). */
const rowRoots = (ctx: AppContext, r: Pick<RunRow, 'root' | 'user_id'>) => [r.root, path.join(ctx.files.fx.root, 'users', r.user_id)]

/** The live runs tracked again after a restart (a row id) whose row has ended since: their sweep after the run, then
 * they are no longer live. */
function pruneLive(ctx: AppContext) {
  for (const [id, l] of liveSweeps) {
    if (!l.rowId) continue
    const open = ctx.db.query('SELECT 1 FROM dev_env_runs WHERE id = ? AND ended_at IS NULL').get(l.rowId)
    if (open) continue
    liveSweeps.delete(id)
    // a link's target only inside its own folders (no view of that run is kept)
    void sweepHooks(l.roots, { visible: { read: l.roots } }).catch((e: Error) => ctx.log?.warn?.('devenv: git hooks could not be checked after a run', { error: e.message }))
  }
}

/** What runs and what waits: of a project's chats (the project page), or of one person (every chat). The queue
 * position counts every waiting job of the team. */
export async function runsOf(ctx: AppContext, filter: { projectId: string } | { userId: string }): Promise<DevEnvRuns> {
  const c = srtConfig()
  const match = (s: { userId: string; projectId: string | null }) => ('projectId' in filter ? s.projectId === filter.projectId : s.userId === filter.userId)
  const names = (ids: string[]) => new Map((ids.length ? ctx.db.query(`SELECT id, name FROM users WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as { id: string; name: string }[] : []).map((u) => [u.id, u.name]))
  const running = openRuns(ctx.db, 'running').filter((r) => match({ userId: r.user_id, projectId: r.project_id }))
  const waitingAll = openRuns(ctx.db, 'waiting')
  const commands = [...active.values()].filter((a) => a.kind === 'command' && match(a.space))
  const who = names([...new Set([...running, ...waitingAll].map((r) => r.user_id).concat(commands.map((a) => a.space.userId)))])
  const ref = (id: string) => ({ id, name: who.get(id) ?? id })
  // a person sees the chat of their own runs only
  const chatOf = (userId: string, chatId: string | null) => ('userId' in filter && userId === filter.userId ? chatId : null)
  const out: DevEnvRun[] = []
  for (const r of running) {
    const u = await c.system.unit(runIdOf(r.unit))
    // a shared chat's run: its log line only to the person who started it (the project page may have other readers
    // than the chat; the chat's people get its results in the chat)
    const line = r.shared_key && !('userId' in filter && filter.userId === r.user_id) ? '' : r.last_line
    out.push({ id: r.id, kind: r.kind, name: r.name, by: ref(r.user_id), startedAt: r.started_at, runAt: r.run_at, position: null, memoryMiB: u.memoryBytes === null ? null : Math.round(u.memoryBytes / 1048576), lastLine: line, chatId: chatOf(r.user_id, r.chat_id), projectId: r.project_id })
  }
  for (const a of commands) out.push({ id: a.runId, kind: 'command', name: a.command.slice(0, 80), by: ref(a.space.userId), startedAt: a.startedAt, runAt: a.startedAt, position: null, memoryMiB: null, lastLine: '', chatId: chatOf(a.space.userId, a.space.chatId), projectId: a.space.projectId })
  // a command's ticket shows as a waiting command; the place in line follows the start order (queue.ts)
  const tickets = ticketIds(ctx.db), order = queueOrder(ctx)
  const place = (id: string, i: number) => { const p = order.indexOf(id); return p < 0 ? i + 1 : p + 1 }
  const waiting = waitingAll.map((r, i) => ({ r, i })).filter(({ r }) => match({ userId: r.user_id, projectId: r.project_id }))
    .map(({ r, i }) => ({ id: r.id, kind: tickets.has(r.id) ? 'command' as const : r.kind, name: tickets.has(r.id) ? r.command.slice(0, 80) : r.name, by: ref(r.user_id), startedAt: r.started_at, runAt: null, position: place(r.id, i), memoryMiB: null, lastLine: '', chatId: chatOf(r.user_id, r.chat_id), projectId: r.project_id }))
    .sort((a, b) => a.position - b.position)
  return { running: out, waiting }
}

/** The runs of other people in the same project (the first call of a turn tells the AI what else runs there): kinds,
 * names and who, never logs. */
export function othersInProject(ctx: AppContext, projectId: string, userId: string): { kind: string; name: string; by: string; position: number | null }[] {
  const waitingAll = openRuns(ctx.db, 'waiting')
  const rows = [...openRuns(ctx.db, 'running'), ...waitingAll].filter((r) => r.project_id === projectId && r.user_id !== userId)
  const names = new Map((ctx.db.query('SELECT id, name FROM users').all() as { id: string; name: string }[]).map((u) => [u.id, u.name]))
  const tickets = ticketIds(ctx.db), order = queueOrder(ctx)
  return rows.map((r) => ({ kind: tickets.has(r.id) ? 'command' : r.kind, name: tickets.has(r.id) ? 'a command' : r.name, by: names.get(r.user_id) ?? '?', position: r.state === 'waiting' ? order.indexOf(r.id) + 1 || waitingAll.findIndex((w) => w.id === r.id) + 1 : null }))
}

// ---------------- preview (docs/DECISIONS.md "Dev environment on srt: preview") ----------------

/** the ports a preview never forwards: srt's proxy relays in the run's network namespace */
export const SRT_RELAY_PORTS: readonly number[] = [3128, 1080]
export const previewPortProblem = (port: number): string | null =>
  !Number.isInteger(port) || port < 1 || port > 65535 ? 'not a port' : SRT_RELAY_PORTS.includes(port) ? 'this port is the sandbox proxy, not a dev server' : null
const PREVIEW_SOCK_RE = /^[a-z0-9]{16}-\d{1,5}\.sock$/
const sockName = (key: string) => key.replace(':', '-') + '.sock'

/** this server can serve previews: a system with port-forward (systemd scopes and the sandbox helper) */
export const previewSupported = () => !!srtConfig().system.forward

/** The open dev server row of a preview link, or null: the row must be open, running, a dev server, and still the same
 * run (its unit). A person's own chat: only the person who started it (the run has that person's folder access). A
 * shared chat's (docs/decisions/20261118-devenv-shared-jobs-mac-localhost.md): everyone who sees that chat now and
 * whose own run there would have the row's key and access hash now (sharedPreviewer: the same view and the same writes),
 * and the person who started it may still use the dev environment. */
export function previewRow(ctx: AppContext, o: { rowId: string; runId?: string; userId: string }): RunRow | null {
  const r = ctx.db.query(`SELECT ${RCOLS} FROM dev_env_runs WHERE id = ? AND ended_at IS NULL`).get(o.rowId) as RunRow | null
  if (!r || r.kind !== 'server' || r.state !== 'running') return null
  if (r.shared_key ? !sharedPreviewer(ctx, r, o.userId) : r.user_id !== o.userId) return null
  const runId = runIdOf(r.unit)
  if (!runId || (o.runId !== undefined && runId !== o.runId)) return null
  return r
}

/** A shared chat's dev server and a viewer: in the chat now, and a run of the viewer there would have the row's key and
 * access hash (the same people and view, and the same writes: a reader never drives a writer's dev server; a guest
 * only when they pass the same check). Fails closed. */
function sharedPreviewer(ctx: AppContext, r: RunRow, userId: string): boolean {
  try {
    const shared = sharedOfChat(ctx, r.chat_id)
    if (!shared.audience().includes(userId)) return false
    const space: Space = { userId, chatId: r.chat_id, projectId: r.project_id, root: r.root, shared }
    const h = accessHash(ctx, space)
    return h !== 'off' && h === r.access && sharedLogKey(ctx, space) === r.shared_key
  } catch { return false }
}

/** May `userId` open (or keep using) a preview of this dev server now? previewRow, and the dev environment allowed for
 * the person whose run it is: the viewer on a person's own dev server, its starter on a shared chat's. */
export function previewAllowed(ctx: AppContext, o: { rowId: string; runId?: string; userId: string }): RunRow | null {
  const r = previewRow(ctx, o)
  if (!r) return null
  try { return mayUseDevEnv(ctx.db, ctx.files, r.shared_key ? r.user_id : o.userId) ? r : null } catch { return null }
}

/** The unix socket that reaches a port of a running dev server (row rowId), for the preview gateway. The run comes from
 * the row, never from the request: a link of run A can only ever reach run A's namespace (attack A26). One forwarder
 * per run and port; it ends with the run (stopRow, pollRuns) or with this process. */
export async function previewSocket(ctx: AppContext, o: { rowId: string; runId: string; userId: string; port: number }): Promise<{ ok: true; socket: string } | { ok: false; message: string }> {
  const c = srtConfig()
  if (previewPortProblem(o.port)) return { ok: false, message: previewPortProblem(o.port)! }
  if (!c.system.forward) return { ok: false, message: 'this server has no preview (no systemd scopes)' }
  if (!previewAllowed(ctx, o)) return { ok: false, message: 'the dev server is not running' }
  lastPreview.set(o.runId, Date.now())
  const f = await forwarderFor(c, o.runId, o.port)
  return 'error' in f ? { ok: false, message: f.error } : { ok: true, socket: f.socket }
}

/** The forwarder of a run's port (one per run and port; it ends with the run or this process). */
async function forwarderFor(c: SrtConfig, runId: string, port: number): Promise<Forwarder | { error: string }> {
  if (!c.system.forward) return { error: 'this server has no preview (no systemd scopes)' }
  const key = `${runId}:${port}`
  let start = forwarders.get(key)
  if (start) {
    const f = await start
    if ('error' in f) forwarders.delete(key)
    else return f
  }
  const socket = path.join(devenvPaths(c.base).run, sockName(key))
  start = c.system.forward({ runId, port, socket }).catch((e) => ({ error: String((e as Error).message ?? e).slice(0, 300) }))
  forwarders.set(key, start)
  const f = await start
  if ('error' in f) { if (forwarders.get(key) === start) forwarders.delete(key); return f }
  void f.exited.then(() => { if (forwarders.get(key) === start) forwarders.delete(key); rm(socket) })
  return f
}

/** Stop the preview forwarders of a run (it ended or stopped). */
export function closeForwarders(runId: string) {
  if (!runId) return
  lastPreview.delete(runId)
  for (const [key, start] of forwarders) {
    if (!key.startsWith(runId + ':')) continue
    forwarders.delete(key)
    void start.then((f) => { if ('stop' in f) { f.stop(); rm(f.socket) } })
  }
}

/** The work folder of a chat goes with the chat (chat/forget.ts, after the purge). */
export function forgetChatWork(chatId: string) {
  const base = srtConfig().base
  let dirs: string[]
  try { dirs = [chatWork(base, chatId), path.join(devenvPaths(base).workShared, chatWork(base, chatId).split(path.sep).pop()!), chatHome(base, chatId), chatLogs(base, chatId)] } catch { return }
  for (const d of dirs) try { fs.rmSync(d, { recursive: true, force: true }) } catch {}
  forgetCopiedIn(base, chatId)
}

/** People and chats with a run now (this process's, or a waiting or running row), for the disk clean-up
 * (system/devenv-clean.ts): nothing of theirs is removed meanwhile. */
export function busyOwners(ctx: AppContext): { users: Set<string>; chats: Set<string> } {
  const users = new Set<string>(), chats = new Set<string>()
  for (const a of active.values()) { users.add(a.space.userId); if (a.space.chatId) chats.add(a.space.chatId) }
  try {
    for (const r of ctx.db.query('SELECT user_id, chat_id FROM dev_env_runs WHERE ended_at IS NULL').all() as { user_id: string; chat_id: string | null }[]) { users.add(r.user_id); if (r.chat_id) chats.add(r.chat_id) }
  } catch {}
  return { users, chats }
}

/** tests */
export function _active() { return active }
export function _forwarders() { return forwarders }
export function _liveSweeps() { return liveSweeps }
