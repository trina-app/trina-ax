// Runs: each chat (or scheduled task run) the AI works for gets its own background window in the person's Chrome, its
// tabs in one tab group named "<app> · <run title>". A run sees and drives only the tabs of its own group (the tabs it
// opened, tabs those open, and tabs the person drags in); another run's tab ids are "no such tab". Windows open
// without focus and are never raised; the person's own windows and tabs are not touched. At most MAX_RUNS runs have a
// window at once; a further run's call is refused at once. A run's window closes after RUN_IDLE_MS without a call;
// when the person closes it themselves, the run stops (calls.ts). Sub-agents share their chat's run, so the tab a
// call acts on when it names none is kept per turn.
import { PRODUCT } from '../../shared/src/product'
import { ToolError } from '../../desktop/src/common/input'
import { aiTabId, parseAiTabId } from './ids'
import { detach, tabState } from './tabs'

export interface Run {
  id: string
  title: string
  windowId: number | null
  groupId: number | null
  lastCall: number
  /** the tab each turn used last (sub-agents of one chat run side by side): turnId -> tab */
  lastTabs: Record<string, number>
}

export const MAX_RUNS = 4
export const RUN_IDLE_MS = 10 * 60_000
/** a run without a call for this long gives its window up when a new run needs one and all MAX_RUNS are taken (a
 * finished Claude Code session, or a chat that ended, must not hold the profile for 10 minutes) */
export const RUN_YIELD_MS = 2 * 60_000
/** the runs with a call running now (calls.ts; set by the worker, so runs.ts imports nothing from calls.ts) */
let busyRuns: () => ReadonlySet<string> = () => new Set()
export function setBusyRuns(f: () => ReadonlySet<string>) { busyRuns = f }
/** tabs in one run's window at most */
export const MAX_TABS = 20

const runs = new Map<string, Run>()
let loaded: Promise<void> | null = null
/** windows this extension closes itself (an idle run): not the person stopping the run */
const closingByUs = new Set<number>()
let onUserClosed: ((runId: string) => void) | null = null

export const runTitle = (title: string) => `${PRODUCT.displayName} · ${Array.from(title.replace(/\s+/g, ' ').trim()).slice(0, 30).join('') || '…'}`

async function load() {
  loaded ??= chrome.storage.session.get('runs').then((v) => {
    for (const r of (v.runs ?? []) as Run[]) if (r && typeof r.id === 'string') runs.set(r.id, { ...r, lastTabs: r.lastTabs ?? {} })
  }, () => {})
  await loaded
}

async function save() {
  await chrome.storage.session.set({ runs: [...runs.values()] }).catch(() => {})
}

/** The person closed a run's window: calls.ts stops that run. */
export function setRunClosedHandler(f: (runId: string) => void) {
  onUserClosed = f
}

/** The run of a call (made on its first call; no window until a call needs a tab). */
export async function runFor(id: string, title: string): Promise<Run> {
  await load()
  let r = runs.get(id)
  if (!r) {
    r = { id, title, windowId: null, groupId: null, lastCall: Date.now(), lastTabs: {} }
    runs.set(id, r)
  }
  r.lastCall = Date.now()
  if (title && title !== r.title) {
    r.title = title
    if (r.groupId !== null) await chrome.tabGroups.update(r.groupId, { title: runTitle(title) }).catch(() => {})
  }
  await save()
  return r
}

export async function allRuns(): Promise<Run[]> {
  await load()
  return [...runs.values()]
}

const openCount = () => [...runs.values()].filter((r) => r.windowId !== null).length

async function windowAlive(r: Run): Promise<boolean> {
  if (r.windowId === null) return false
  const w = await chrome.windows.get(r.windowId).catch(() => null)
  if (w) return true
  r.windowId = null
  r.groupId = null
  return false
}

export const PROFILE_BUSY = `The browser profile is busy with ${MAX_RUNS} other tasks; try again in a minute.`

/** Remember the tab a turn used (bounded: the newest turns only). */
export function useTab(r: Run, turnId: string, tabId: number) {
  delete r.lastTabs[turnId]
  r.lastTabs[turnId] = tabId
  const keys = Object.keys(r.lastTabs)
  for (const k of keys.slice(0, Math.max(0, keys.length - 20))) delete r.lastTabs[k]
}

/** The run's tab group in its window (made again when the person ungrouped every tab). */
async function ensureGroup(r: Run, tabId: number): Promise<void> {
  if (r.groupId !== null) {
    const ok = await chrome.tabs.group({ groupId: r.groupId, tabIds: [tabId] }).then(() => true, () => false)
    if (ok) return
  }
  r.groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId: r.windowId! } })
  await chrome.tabGroups.update(r.groupId, { title: runTitle(r.title), color: 'green' }).catch(() => {})
}

/** A new tab for the run: in its window (a new background window for the run's first tab). */
export async function createRunTab(r: Run, turnId: string, active: boolean): Promise<number> {
  if (!(await windowAlive(r))) {
    if (openCount() >= MAX_RUNS) {
      // the run idle longest gives its window up (never one with a call running, never this one)
      const busy = busyRuns(), now = Date.now()
      const idle = [...runs.values()].filter((x) => x !== r && x.windowId !== null && !busy.has(x.id) && now - x.lastCall >= RUN_YIELD_MS).sort((a, b) => a.lastCall - b.lastCall)[0]
      if (!idle) throw new ToolError(PROFILE_BUSY)
      await closeRun(idle)
    }
    const w = await chrome.windows.create({ focused: false, state: 'normal', url: 'about:blank' })
    r.windowId = w.id!
    const first = w.tabs?.[0]?.id ?? (await chrome.tabs.query({ windowId: r.windowId }))[0]?.id
    if (first === undefined) throw new ToolError('Chrome did not open a window for this task. Ask the user to check Chrome.')
    r.groupId = null
    await ensureGroup(r, first)
    useTab(r, turnId, first)
    await save()
    return first
  }
  if ((await runTabs(r)).length >= MAX_TABS) throw new ToolError(`This task already has ${MAX_TABS} tabs open. Close some with tabs_close first.`)
  const t = await chrome.tabs.create({ windowId: r.windowId!, url: 'about:blank', active })
  await ensureGroup(r, t.id!)
  useTab(r, turnId, t.id!)
  await save()
  return t.id!
}

/** The tabs of the run: its group's (the person may drag tabs in or out). */
export async function runTabs(r: Run): Promise<chrome.tabs.Tab[]> {
  if (!(await windowAlive(r)) || r.groupId === null) return []
  return chrome.tabs.query({ groupId: r.groupId }).catch(() => [])
}

async function owns(r: Run, tabId: number): Promise<chrome.tabs.Tab | null> {
  if (r.groupId === null) return null
  const t = await chrome.tabs.get(tabId).catch(() => null)
  return t && t.groupId === r.groupId ? t : null
}

/** The tab a call acts on: its tabId (must be the run's), else the tab this turn used last, else the active tab of the
 * run's window. */
export async function resolveRunTab(r: Run, turnId: string, raw: string | undefined, required: boolean): Promise<number | null> {
  if (raw !== undefined && raw !== '') {
    const id = parseAiTabId(raw)
    if (id === null || !(await owns(r, id))) throw new ToolError(`No tab ${raw} in this task's window. Call tabs_context for the open tabs.`)
    useTab(r, turnId, id)
    return id
  }
  const tabs = await runTabs(r)
  const pick = tabs.find((t) => t.id === r.lastTabs[turnId]) ?? tabs.find((t) => t.active) ?? tabs[0]
  if (pick?.id !== undefined) {
    useTab(r, turnId, pick.id)
    return pick.id
  }
  if (required) throw new ToolError("No tab is open for this task yet. Open one with navigate or preview_start and a url.")
  return null
}

/** Which run a tab belongs to (by its group), if any. */
export async function runOfTab(tabId: number): Promise<Run | null> {
  await load()
  const t = await chrome.tabs.get(tabId).catch(() => null)
  if (!t || t.groupId < 0) return null
  return [...runs.values()].find((r) => r.groupId === t.groupId) ?? null
}

export const describeTab = (tabId: number) => aiTabId(tabId)

/** Close a run's window (idle, or the run ended): the extension's own close, not the person's. */
export async function closeRun(r: Run): Promise<void> {
  const w = r.windowId
  runs.delete(r.id)
  await save()
  if (w !== null) {
    closingByUs.add(w)
    await chrome.windows.remove(w).catch(() => closingByUs.delete(w))
  }
}

/** A run the person stopped (or a link that ended): its tabs let go first (a scripted page goes to about:blank, the
 * debugger detaches, so Chrome's "debugging" bar goes once no other task holds a tab), then its window closes. */
export async function endRun(runId: string): Promise<void> {
  await load()
  const r = runs.get(runId)
  if (!r) return
  for (const t of await runTabs(r)) if (t.id !== undefined) await detach(t.id)
  await closeRun(r)
}

/** Every run's window (Disconnect, the link revoked). */
export async function closeAllRuns(): Promise<void> {
  await load()
  for (const r of [...runs.values()]) await endRun(r.id)
}

/** Close the windows of runs without a call for RUN_IDLE_MS (alarm, every minute). `busy`: runs with a call running. */
export async function sweepRuns(busy: ReadonlySet<string>): Promise<void> {
  await load()
  const now = Date.now()
  for (const r of [...runs.values()]) {
    if (busy.has(r.id) || now - r.lastCall < RUN_IDLE_MS) continue
    await closeRun(r)
  }
}

export function installRunListeners() {
  chrome.windows.onRemoved.addListener((windowId) => {
    void (async () => {
      await load()
      const byUs = closingByUs.delete(windowId)
      const r = [...runs.values()].find((x) => x.windowId === windowId)
      if (!r) return
      runs.delete(r.id)
      await save()
      if (!byUs) onUserClosed?.(r.id)
    })()
  })
  chrome.tabGroups.onRemoved.addListener((g) => {
    void load().then(() => {
      for (const r of runs.values()) if (r.groupId === g.id) r.groupId = null
      return save()
    })
  })
  // a tab opened by a run's own tab (a link in a new tab, window.open into a tab) joins that run's group; a page's
  // popup window cannot hold a tab group and stays the person's. Other new tabs never join a run.
  chrome.tabs.onCreated.addListener((tab) => {
    if (tab.openerTabId === undefined || tab.id === undefined) return
    void (async () => {
      if (tabState(tab.openerTabId!)?.scripted) return // closed instead (tabs.ts)
      const opener = await chrome.tabs.get(tab.openerTabId!).catch(() => null)
      if (!opener || opener.groupId < 0 || tab.groupId === opener.groupId || tab.windowId !== opener.windowId) return
      await load()
      if ([...runs.values()].some((r) => r.groupId === opener.groupId)) await chrome.tabs.group({ groupId: opener.groupId, tabIds: [tab.id!] }).catch(() => {})
    })()
  })
}
