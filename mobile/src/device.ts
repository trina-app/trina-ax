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
export async function rememberDevice(deps: Pick<DeviceDeps, 'current'>, device: TeamDevice): Promise<void> {
  await deps.current.set(JSON.stringify(device))
}
/** One change of the stored devices at a time, per store: two runs at once (the start's retry and a team switch, or a
 * slow network) would each read the owed list and write it back, and the later write would drop the other's entry. */
const queues = new WeakMap<Slot, Promise<unknown>>()
function serial<T>(deps: Pick<DeviceDeps, 'pending'>, run: () => Promise<T>): Promise<T> {
  const before = queues.get(deps.pending) ?? Promise.resolve()
  const next = before.then(run, run)
  queues.set(deps.pending, next.catch(() => {}))
  return next
}
async function leaveNow(deps: DeviceDeps, origin: string): Promise<void> {
  const d = await currentDevice(deps, origin)
  await deps.current.set(null)
  if (!d) return
  const owed = (await read<unknown[]>(deps.pending, [])).filter(valid).filter(p => p.deviceId !== d.deviceId || p.origin !== d.origin)
  await deps.pending.set(JSON.stringify([...owed, { ...d, at: deps.now() }].slice(-MAX_PENDING)))
  await retryNow(deps)
}
async function retryNow(deps: DeviceDeps): Promise<void> {
  const owed = (await read<unknown[]>(deps.pending, [])).filter(valid).filter(p => deps.now() - p.at < KEEP_MS)
  const left: TeamDevice[] = []
  for (const d of owed) if (!(await deps.remove(d).catch(() => false))) left.push(d)
  await deps.pending.set(left.length ? JSON.stringify(left) : null)
}
/** Leaving a team: its device moves to the owed removals at once (no wait for the network), then a removal is tried. */
export function leaveTeam(deps: DeviceDeps, origin: string): Promise<void> {
  return serial(deps, () => leaveNow(deps, origin))
}
/** Tries every owed removal once (a team switch); drops what is done or older than 30 days. */
export function retryRemovals(deps: DeviceDeps): Promise<void> {
  return serial(deps, () => retryNow(deps))
}
/** At start: a device kept for another team than the one saved is a removal still owed (the app saves the new team
 * before it leaves the old one; if it stopped in between, the old team's device is found here), then every owed
 * removal is tried once. In that order, and never beside another run (serial). */
export function startRemovals(deps: DeviceDeps, savedOrigin: string | null): Promise<void> {
  return serial(deps, async () => {
    const d = await read<unknown>(deps.current, null)
    if (valid(d) && d.origin !== savedOrigin) await leaveNow(deps, d.origin)
    else await retryNow(deps)
  })
}
