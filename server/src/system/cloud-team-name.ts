// The team's name on the hosting service (shared/src/cloud-protocol/team-name.ts): a HOSTED team server tells the control
// plane the name an owner gave the team (Admin › Team settings, or the setup page), so the hosting service's console,
// billing pages and mails show the same name. A self-installed server never sends it (teamNameSyncFor is null there).
//
// The channel is the Drive broker's signed API to the same control plane origin (integrations/google-drive/broker.ts
// brokerOrigin: MYCEL_GOOGLE_DRIVE_BROKER_URL, else the edition's console; empty or "off" turns it off, a test app
// never calls the real hosting service), signed with the relay team key the control plane recorded at enroll.
//
// When: after the name changes, and once when a hosted server starts with its team set up (a name changed while the
// control plane could not be reached, or before this release, reaches it then). Only the latest name is sent; a failed
// send is tried again a few times, then left for the next change or start; a 401 is tried once more at once. The start
// report waits a random 0-60 s. The control plane answers `changed`, so a repeat is harmless. Logged: the outcome, and
// on a refusal the status and error code; never the name. An owner's save of a name the control plane would refuse
// (teamNameProblem: 1-60 characters, no hidden characters) fails with that error on a hosted server (hostedTeamName).
import crypto from 'node:crypto'
import { TEAM_NAME_MAX_BODY_BYTES, TEAM_NAME_PATH, teamNameProblem, teamNameSigningString, teamNameToSend } from '@mycel/shared/cloud-protocol/team-name'
import { driveBrokerAuthorization } from '@mycel/shared/cloud-protocol/drive-broker'
import type { AppContext } from '../context'
import { isHosted } from './deployment'
import { brokerOrigin, type BrokerIdentity } from '../integrations/google-drive/broker'
import { loadOrCreateKey } from '../relay-client/registration'

export interface TeamNameSync {
  origin: string
  identity: () => BrokerIdentity
  fetch?: typeof fetch
  now?: () => number
  /** waits before the 2nd, 3rd, ... try (ms) */
  retryMs?: number[]
}

export type TeamNameSendResult = 'sent' | 'unchanged' | 'refused' | 'failed'
/** what one report came to: the result, and the control plane's HTTP status and error code when it answered (logged
 * on a refusal; never the name) */
export interface TeamNameOutcome { result: TeamNameSendResult; status: number | null; code: string | null }

const RETRY_MS = [10_000, 60_000, 5 * 60_000]

/** Where and how this server reports its team name, or null: not hosted, or no control plane origin. */
export function teamNameSyncFor(ctx: AppContext, env: Record<string, string | undefined> = process.env): TeamNameSync | null {
  if (!isHosted(ctx.config)) return null
  const origin = brokerOrigin(env, true)
  if (!origin) return null
  return { origin, identity: () => { const { key, publicKey } = loadOrCreateKey(ctx.config.dataDir); return { key, publicKey } } }
}

/** One signed report. `refused`: the control plane answered no (a 4xx: not a hosted team, a name it does not take);
 * trying again would not help. `failed`: no answer, or the control plane failed; worth another try. A 401 (a clock
 * step, a nonce the control plane saw) is tried once more at once, with a new time and nonce. */
export async function sendTeamName(o: TeamNameSync, name: string): Promise<TeamNameOutcome> {
  const displayName = teamNameToSend(name)
  if (displayName === null) return { result: 'refused', status: null, code: 'invalid_name' }
  const text = JSON.stringify({ v: 1, displayName })
  if (Buffer.byteLength(text) > TEAM_NAME_MAX_BODY_BYTES) return { result: 'refused', status: null, code: 'too_large' }
  let id: BrokerIdentity
  try { id = o.identity() } catch { return { result: 'failed', status: null, code: 'no_key' } }
  const bodyHash = crypto.createHash('sha256').update(text).digest('hex')
  for (let attempt = 0; ; attempt++) {
    const ts = (o.now ?? Date.now)(), nonce = crypto.randomBytes(18).toString('base64url')
    const sig = crypto.sign(null, Buffer.from(teamNameSigningString(ts, nonce, bodyHash), 'utf8'), id.key).toString('base64')
    let r: Response
    try {
      r = await (o.fetch ?? fetch)(o.origin + TEAM_NAME_PATH, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(20_000),
        headers: { 'content-type': 'application/json', authorization: driveBrokerAuthorization(id.publicKey, ts, nonce, sig) }, body: text,
      })
    } catch { return { result: 'failed', status: null, code: 'unreachable' } }
    let json: any = null
    try { const raw = await r.text(); json = raw.length <= 65_536 ? JSON.parse(raw) : null } catch { json = null }
    if (r.ok && json?.ok === true) return { result: json.changed === true ? 'sent' : 'unchanged', status: r.status, code: null }
    const raw = json?.error?.code
    const code = typeof raw === 'string' && /^[a-z0-9_]{1,40}$/.test(raw) ? raw : null
    if (r.status === 401 && attempt === 0) continue
    // too many calls, or the control plane failed: later; any other refusal stays a refusal
    const result = r.status === 429 || r.status >= 500 || (!r.ok && r.status < 400) ? 'failed' : 'refused'
    return { result, status: r.status, code }
  }
}

interface State {
  latest: string | null; running: boolean; closed: boolean
  /** ends a wait between tries early (a new name, or the server stops) */
  wake: (() => void) | null
  /** tests: the sync to use instead of teamNameSyncFor (null = none) */
  sync?: TeamNameSync | null
}
const states = new WeakMap<AppContext, State>()

function stateOf(ctx: AppContext): State {
  let s = states.get(ctx)
  if (!s) {
    const made: State = { latest: null, running: false, closed: false, wake: null }
    ctx.onClose(() => { made.closed = true; made.wake?.() })
    states.set(ctx, s = made)
  }
  return s
}

/** tests: report through this sync (a fake control plane) instead of the environment's; still hosted servers only */
export function setTeamNameSync(ctx: AppContext, sync: TeamNameSync | null): void { stateOf(ctx).sync = sync }

/** Report the team's name to the hosting service in the background (nothing on a self-installed server). The latest
 * name wins: a rename while a report is on its way or waiting for another try is sent next. Resolves when this round
 * is over (tests wait on it). */
export function reportTeamName(ctx: AppContext, name: string): Promise<void> {
  if (!isHosted(ctx.config)) return Promise.resolve()
  const s = stateOf(ctx)
  const sync = s.sync !== undefined ? s.sync : teamNameSyncFor(ctx)
  if (!sync || s.closed) return Promise.resolve()
  s.latest = name
  if (s.running) { s.wake?.(); return Promise.resolve() }
  s.running = true
  const waits = sync.retryMs ?? RETRY_MS
  const wait = (ms: number) => new Promise<void>((res) => {
    const t = setTimeout(done, ms)
    ;(t as { unref?: () => void }).unref?.()
    function done() { clearTimeout(t); s.wake = null; res() }
    s.wake = done
  })
  return (async () => {
    try {
      while (s.latest !== null && !s.closed) {
        const sending = s.latest
        let r: TeamNameOutcome = { result: 'failed', status: null, code: null }
        for (let i = 0; i <= waits.length; i++) {
          if (i > 0) await wait(waits[i - 1]!)
          if (s.closed || s.latest !== sending) break
          r = await sendTeamName(sync, sending)
          if (r.result !== 'failed') break
        }
        if (s.closed) break
        if (s.latest !== sending) continue // renamed meanwhile: send the new name
        s.latest = null
        if (r.result === 'failed' || r.result === 'refused') ctx.log.warn('team name not reported to the hosting service', { result: r.result, status: r.status, code: r.code })
        else ctx.log.info('team name reported to the hosting service', { changed: r.result === 'sent' })
      }
    } finally { s.running = false; s.wake = null }
  })()
}

/** At start: report the name after a random 0-60 s, so the servers of a host that restart together (an update, a host
 * reboot) do not all call the control plane in the same second. Nothing on a self-installed server. */
export function reportTeamNameAtStart(ctx: AppContext, name: () => string, delayMs = Math.floor(Math.random() * 60_000)): void {
  if (!isHosted(ctx.config)) return
  const t = setTimeout(() => { void reportTeamName(ctx, name()) }, delayMs)
  ;(t as { unref?: () => void }).unref?.()
  ctx.onClose(() => clearTimeout(t))
}

/** The name an owner saves on a HOSTED server (Admin › Team settings): trimmed and NFC, or the contract's reason it is
 * not a valid name (teamNameProblem), so the owner sees the error instead of a name the hosting service never takes.
 * A self-installed server keeps its own rule (1-100 characters, shared/src/api/entities.ts TeamSettings). */
export function hostedTeamName(ctx: AppContext, name: string): { name: string } | { problem: NonNullable<ReturnType<typeof teamNameProblem>> } {
  if (!isHosted(ctx.config)) return { name }
  const n = teamNameToSend(name)
  return n === null ? { problem: teamNameProblem(name.normalize('NFC').trim()) ?? 'bad_character' } : { name: n }
}
