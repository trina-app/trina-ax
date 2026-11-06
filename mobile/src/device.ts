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
/** Leaving a team: its device moves to the owed removals at once (no wait for the network), then a removal is tried. */
export async function leaveTeam(deps: DeviceDeps, origin: string): Promise<void> {
  const d = await currentDevice(deps, origin)
  await deps.current.set(null)
  if (!d) return
  const owed = (await read<unknown[]>(deps.pending, [])).filter(valid).filter(p => p.deviceId !== d.deviceId || p.origin !== d.origin)
  await deps.pending.set(JSON.stringify([...owed, { ...d, at: deps.now() }].slice(-MAX_PENDING)))
  await retryRemovals(deps)
}
/** Tries every owed removal once (app start, team switch); drops what is done or older than 30 days. */
export async function retryRemovals(deps: DeviceDeps): Promise<void> {
  const owed = (await read<unknown[]>(deps.pending, [])).filter(valid).filter(p => deps.now() - p.at < KEEP_MS)
  const left: TeamDevice[] = []
  for (const d of owed) if (!(await deps.remove(d).catch(() => false))) left.push(d)
  await deps.pending.set(left.length ? JSON.stringify(left) : null)
}
