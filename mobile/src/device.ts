// The phone's device on its current team, and the removals still owed to teams it left. Pure (storage and network are
// passed in) so tests can drive it. The removal key comes from the team at registration (POST /api/push/devices); with
// it the app removes the device from a team it leaves without that team's session, also later when the team server
// could not be reached at the switch.
export interface TeamDevice { origin: string; deviceId: string; removeKey: string; at: number }
export interface Slot { get(): Promise<string | null>; set(value: string | null): Promise<void> }
export interface DeviceDeps { current: Slot; pending: Slot; remove(device: TeamDevice): Promise<boolean>; now(): number }
const MAX_PENDING = 4, KEEP_MS = 30 * 86_400_000

const valid = (d: unknown): d is TeamDevice => !!d && typeof d === 'object' && typeof (d as TeamDevice).origin === 'string'
  && /^[A-Za-z0-9_-]{1,100}$/.test((d as TeamDevice).deviceId) && /^[A-Za-z0-9_-]{43}$/.test((d as TeamDevice).removeKey) && Number.isFinite((d as TeamDevice).at)
async function read<T>(slot: Slot, fallback: T): Promise<T> { try { const raw = await slot.get(); return raw ? JSON.parse(raw) as T : fallback } catch { return fallback } }

export async function currentDevice(deps: Pick<DeviceDeps, 'current'>, origin: string): Promise<TeamDevice | null> {
  const d = await read<unknown>(deps.current, null)
  return valid(d) && d.origin === origin ? d : null
}
export function rememberDevice(deps: Pick<DeviceDeps, 'current' | 'pending'>, device: TeamDevice): Promise<void> {
  return locked(deps, () => deps.current.set(JSON.stringify(device)))
}
/** The stored devices change one step at a time, per store: each step reads and writes them with no network in
 * between, so a slow removal never holds back a leave or a registration, and two runs (the start's and a team
 * switch's) cannot write an older list over the other's entry. */
const queues = new WeakMap<Slot, Promise<unknown>>()
function locked<T>(deps: Pick<DeviceDeps, 'pending'>, run: () => Promise<T>): Promise<T> {
  const next = (queues.get(deps.pending) ?? Promise.resolve()).then(run, run)
  queues.set(deps.pending, next.catch(() => {}))
  return next
}
const same = (a: TeamDevice, b: TeamDevice) => a.deviceId === b.deviceId && a.origin === b.origin
const fresh = (deps: DeviceDeps) => async () => (await read<unknown[]>(deps.pending, [])).filter(valid).filter(p => deps.now() - p.at < KEEP_MS)
/** The current device moves to the owed removals if it is not for `keep` (a team left, or another team than the one
 * saved). Storage only. */
function owe(deps: DeviceDeps, keep: (d: TeamDevice) => boolean): Promise<void> {
  return locked(deps, async () => {
    const d = await read<unknown>(deps.current, null)
    if (!valid(d) || keep(d)) return
    await deps.current.set(null)
    const owed = (await fresh(deps)()).filter(p => !same(p, d))
    await deps.pending.set(JSON.stringify([...owed, { ...d, at: deps.now() }].slice(-MAX_PENDING)))
  })
}

/** Leaving a team: its device moves to the owed removals at once (no wait for the network), then a removal is tried. */
export async function leaveTeam(deps: DeviceDeps, origin: string): Promise<void> {
  await owe(deps, d => d.origin !== origin)
  await retryRemovals(deps)
}
/** Tries every owed removal once (a team switch, the start); drops what is done or older than 30 days. Only what was
 * removed leaves the list: an entry added while the network answered stays. */
export async function retryRemovals(deps: DeviceDeps): Promise<void> {
  const owed = await locked(deps, async () => {
    const list = await fresh(deps)()
    await deps.pending.set(list.length ? JSON.stringify(list) : null)
    return list
  })
  const done: TeamDevice[] = []
  for (const d of owed) if (await deps.remove(d).catch(() => false)) done.push(d)
  if (done.length) await locked(deps, async () => {
    const left = (await fresh(deps)()).filter(p => !done.some(d => same(d, p)))
    await deps.pending.set(left.length ? JSON.stringify(left) : null)
  })
}
/** At start: a device kept for another team than the one saved is a removal still owed (the app saves the new team
 * before it leaves the old one; if it stopped in between, the old team's device is found here); then every owed
 * removal is tried once. The first step is queued before anything else can change the stored devices. */
export async function startRemovals(deps: DeviceDeps, savedOrigin: string | null): Promise<void> {
  await owe(deps, d => d.origin === savedOrigin)
  await retryRemovals(deps)
}
