// The debugger side of the AI's tabs (which tabs belong to which run: runs.ts). The debugger attaches to a tab on its
// first call and detaches after a minute without calls, so Chrome's "started debugging this browser" bar shows while
// the AI works.
import { ToolError } from '../../desktop/src/common/input'
import { cdp, type Target } from './cdp'
import { aiTabId } from './ids'
import { runOfTab } from './runs'
import { applyFetch, checkDocumentSource, onRequestPaused } from './guard'
import type { SiteRules } from './sites'

export interface ConsoleEntry { level: string; text: string; host: string }
export interface NetworkEntry { id: string; method: string; url: string; type: string; status?: number | string }

export interface TabState {
  tabId: number
  target: Target
  attached: boolean
  mainFrameId: string
  /** host[:port] of the page now ('' for none) */
  host: string
  /** the page script's isolated world in the current document */
  world?: number
  /** the AI ran javascript_tool in this document: its requests to sites nobody allowed fail (guard.ts) */
  scripted: boolean
  /** what the last call on this tab allowed (the guards use it between calls) */
  rules: SiteRules
  loading: boolean
  /** navigate with force: a "Leave site?" question is answered Leave */
  forceLeave: boolean
  console: ConsoleEntry[]
  network: Map<string, NetworkEntry>
  /** child targets: out-of-process frames and workers (Target.setAutoAttach) */
  children: Map<string, string>
  /** file pickers are taken over while the AI acts (none opens over the person's screen) */
  intercepting: boolean
  /** file_upload waits for the picker its click opens */
  chooser?: (p: { backendNodeId: number; mode: string; frameId: string; child: boolean }) => void
  /** calls using this tab now */
  busy: number
  /** what the guards said since the last call on this tab: told to the AI that uses this tab next */
  notices: string[]
  /** a page load the guard stopped during this call because nobody allowed its site (guard.ts) */
  blockedNav?: { host: string; office?: true }
  idle?: ReturnType<typeof setTimeout>
  waiters: Set<() => void>
}

const MAX_LOG = 500
const MAX_ENTRY_CHARS = 10_000
const IDLE_DETACH_MS = 60_000
export const CHOOSER_SUPPRESSED = 'A file picker opened and was closed: to attach files call file_upload with the ref of that button or field.'

const states = new Map<number, TabState>()
/** what went wrong between calls (a page stopped by the guard): told to the AI with its next result */
let onUserStop: ((tabId: number) => void) | null = null

export const tabState = (tabId: number) => states.get(tabId)

/** Closing Chrome's debugging bar on a tab stops the run that owns it (calls.ts). */
export function setUserStopHandler(f: (tabId: number) => void) {
  onUserStop = f
}

export function pushConsole(st: TabState, e: ConsoleEntry) {
  if (e.text.length > MAX_ENTRY_CHARS) e.text = `${e.text.slice(0, MAX_ENTRY_CHARS)}… (cut)`
  st.console.push(e)
  if (st.console.length > MAX_LOG) st.console.splice(0, st.console.length - MAX_LOG)
}

/** Tell the AI with the next result of a call on this tab (only the run that uses the tab hears it). */
export function addNotice(st: TabState, text: string) {
  if (!st.notices.includes(text)) st.notices.push(text)
  if (st.notices.length > 10) st.notices.shift()
}

/** What the guards said on these tabs since the last call, taken out. */
export function takeNotices(tabIds: Iterable<number>): string[] {
  const out: string[] = []
  for (const id of tabIds) {
    const st = states.get(id)
    if (st) out.push(...st.notices.splice(0))
  }
  return out
}

/** What a tab's children are attached for: frames and dedicated workers always; while the AI's script lives in the
 * document also windows it opens and its service and shared workers (each waits until its guard is on). */
export function autoAttachParams(scripted: boolean) {
  const types = scripted ? ['iframe', 'worker', 'page', 'service_worker', 'shared_worker'] : ['iframe', 'worker']
  return { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [...types.map((type) => ({ type })), { exclude: true }] }
}

export const POPUP_CLOSED = 'The page opened a new window after the AI ran a script in it; that window was closed, because the AI cannot guard it. Open the page with navigate instead.'

/** Address and title of a tab, from the debugger's target list (no "tabs" permission needed). */
export async function tabInfo(tabId: number): Promise<{ url: string; title: string }> {
  const t = (await chrome.debugger.getTargets()).find((x) => x.tabId === tabId && x.type === 'page')
  if (!t) throw new ToolError(`Tab ${aiTabId(tabId)} is gone. Call tabs_context for the open tabs.`)
  return { url: t.url, title: t.title }
}

/** Address of each tab (one target list for all). */
export async function tabUrls(ids: number[]): Promise<Map<number, string>> {
  const targets = await chrome.debugger.getTargets()
  return new Map(ids.map((id) => [id, targets.find((x) => x.tabId === id && x.type === 'page')?.url ?? '']))
}

// ------------------------------------------------------------------ the debugger

/** Attach to a tab (once) and set up what the tools read: console, network, dialogs, guards. */
export async function attach(tabId: number, rules: SiteRules): Promise<TabState> {
  let st = states.get(tabId)
  if (st?.attached) {
    st.rules = rules
    clearTimeout(st.idle)
    return st
  }
  st = {
    tabId, target: { tabId }, attached: false, mainFrameId: '', host: '', scripted: false, rules, loading: false, forceLeave: false,
    console: [], network: new Map(), children: new Map(), intercepting: false, busy: 0, waiters: new Set(), notices: [],
  }
  states.set(tabId, st)
  try {
    await chrome.debugger.attach({ tabId }, '1.3')
  } catch (e) {
    states.delete(tabId)
    const msg = String((e as Error)?.message ?? e)
    if (/already attached/i.test(msg)) throw new ToolError('Another debugger (DevTools or another extension) is attached to this tab. Ask the user to close it, or use another tab.')
    throw new ToolError(`The AI cannot use this tab (${msg.split('\n')[0]}). Open the page in a new tab with navigate.`)
  }
  st.attached = true
  // a background tab that was never shown may have no page process yet: its first command waits for one. Shown in its
  // own task window (never the person's window), it gets one.
  const first = cdp(st.target, 'Page.enable')
  const late = await Promise.race([first.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), 3000))])
  if (late) {
    await chrome.tabs.update(tabId, { active: true }).catch(() => {})
    await Promise.race([first, new Promise((_, j) => setTimeout(() => j(new ToolError('The tab did not answer. Close it with tabs_close and open the page in a new tab.')), 10_000))])
  }
  await cdp(st.target, 'Runtime.enable')
  // bodies stay readable for read_network_requests, within bounds
  await cdp(st.target, 'Network.enable', { maxTotalBufferSize: 32 * 1024 * 1024, maxResourceBufferSize: 4 * 1024 * 1024 })
  const tree = await cdp<{ frameTree: { frame: { id: string; url: string } } }>(st.target, 'Page.getFrameTree')
  st.mainFrameId = tree.frameTree.frame.id
  try {
    st.host = new URL(tree.frameTree.frame.url).host.toLowerCase()
  } catch {
    st.host = ''
  }
  await applyFetch(st)
  // other sites' frames and the page's workers: their requests are guarded and their file pickers taken over too.
  // They wait for the debugger until their guard is on (attachedToTarget below).
  await cdp(st.target, 'Target.setAutoAttach', autoAttachParams(false)).catch(() => {})
  return st
}

/** A call starts on this tab: no idle detach while it runs, and its page loads are checked (guard.ts). */
export async function hold(st: TabState) {
  st.busy++
  clearTimeout(st.idle)
  if (st.busy === 1) await applyFetch(st).catch(() => {})
}

/** A call ended: the person's own file pickers and page loads work as usual again; detach after a minute without
 * calls (never while the AI's script lives in the document). */
export async function release(st: TabState) {
  st.busy = Math.max(0, st.busy - 1)
  if (st.busy === 0 && st.attached) {
    await stopIntercepting(st)
    await applyFetch(st).catch(() => {})
  }
  scheduleIdle(st)
}

function scheduleIdle(st: TabState) {
  clearTimeout(st.idle)
  if (st.busy > 0 || !st.attached) return
  st.idle = setTimeout(() => {
    if (st.busy > 0 || !st.attached) return
    if (st.scripted) return scheduleIdle(st)
    void detach(st.tabId)
  }, IDLE_DETACH_MS)
}

export async function detach(tabId: number) {
  const st = states.get(tabId)
  states.delete(tabId)
  if (st) clearTimeout(st.idle)
  // a document the AI ran script in never keeps running without its guard: it goes first
  if (st?.attached && st.scripted) await cdp(st.target, 'Page.navigate', { url: 'about:blank' }).catch(() => {})
  if (st?.attached) await chrome.debugger.detach({ tabId }).catch(() => {})
}

export async function detachAll() {
  for (const id of [...states.keys()]) await detach(id)
}

/** Wait until the main frame stops loading (or `ms` passed). */
export function waitLoaded(st: TabState, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(t)
      st.waiters.delete(finish)
      resolve()
    }
    const t = setTimeout(finish, ms)
    st.waiters.add(finish)
    signal?.addEventListener('abort', finish, { once: true })
  })
}

/** The file pickers of this tab and its frames are taken over (while the AI acts). */
export async function intercept(st: TabState) {
  if (st.intercepting) return
  st.intercepting = true
  await cdp(st.target, 'Page.setInterceptFileChooserDialog', { enabled: true }).catch(() => {
    st.intercepting = false
  })
  for (const [sid, type] of st.children) if (type === 'iframe') await cdp({ tabId: st.tabId, sessionId: sid }, 'Page.setInterceptFileChooserDialog', { enabled: true }).catch(() => {})
}

export async function stopIntercepting(st: TabState) {
  if (!st.intercepting || !st.attached) return
  st.intercepting = false
  await cdp(st.target, 'Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {})
  for (const [sid, type] of st.children) if (type === 'iframe') await cdp({ tabId: st.tabId, sessionId: sid }, 'Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {})
}

function onEvent(source: chrome.debugger.DebuggerSession, method: string, params: any) {
  const st = source.tabId !== undefined ? states.get(source.tabId) : undefined
  if (!st) return
  if (source.sessionId) return onChildEvent(st, source.sessionId, method, params)
  switch (method) {
    case 'Target.attachedToTarget': {
      const sid = String(params.sessionId)
      const type = String(params.targetInfo?.type ?? '')
      const child = { tabId: st.tabId, sessionId: sid }
      // a window a scripted document opened: its script could reach it, and it is no tab the AI guards
      if (type === 'page') {
        if (st.scripted) {
          addNotice(st, POPUP_CLOSED)
          void cdp(st.target, 'Target.closeTarget', { targetId: String(params.targetInfo?.targetId ?? '') }).catch(() => {})
        } else void cdp(child, 'Runtime.runIfWaitingForDebugger').catch(() => {})
        break
      }
      st.children.set(sid, type)
      void (async () => {
        await applyFetch(st, child).catch(() => {})
        if (type === 'iframe') {
          await cdp(child, 'Page.enable').catch(() => {})
          if (st.intercepting) await cdp(child, 'Page.setInterceptFileChooserDialog', { enabled: true }).catch(() => {})
          await cdp(child, 'Target.setAutoAttach', autoAttachParams(st.scripted)).catch(() => {})
        }
        await cdp(child, 'Runtime.runIfWaitingForDebugger').catch(() => {})
      })()
      break
    }
    case 'Target.detachedFromTarget':
      st.children.delete(String(params.sessionId))
      break
    case 'Page.frameNavigated':
      if (!params.frame?.parentId) {
        st.mainFrameId = params.frame.id
        st.world = undefined
        // a new document: the AI's script (and its timers) did not survive the navigation
        if (st.scripted) {
          st.scripted = false
          void applyFetch(st)
          void cdp(st.target, 'Target.setAutoAttach', autoAttachParams(false)).catch(() => {})
        }
        let host = ''
        try {
          host = new URL(params.frame.url).host.toLowerCase()
        } catch {
          host = ''
        }
        if (host !== st.host) st.network.clear()
        st.host = host
      }
      break
    case 'Page.frameStartedLoading':
      if (params.frameId === st.mainFrameId) st.loading = true
      break
    case 'Page.frameStoppedLoading':
    case 'Page.loadEventFired':
      if (method === 'Page.loadEventFired' || params.frameId === st.mainFrameId) {
        st.loading = false
        for (const w of [...st.waiters]) w()
      }
      break
    case 'Runtime.executionContextDestroyed':
      if (params.executionContextId === st.world) st.world = undefined
      break
    case 'Runtime.executionContextsCleared':
      st.world = undefined
      break
    case 'Runtime.consoleAPICalled':
      pushConsole(st, {
        level: params.type === 'warning' ? 'warn' : String(params.type),
        text: (params.args ?? []).map((a: any) => (a.value !== undefined ? (typeof a.value === 'string' ? a.value : JSON.stringify(a.value)) : (a.description ?? a.type))).join(' '),
        host: st.host,
      })
      break
    case 'Runtime.exceptionThrown':
      pushConsole(st, { level: 'error', text: params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? 'Uncaught exception', host: st.host })
      break
    case 'Network.requestWillBeSent':
      st.network.set(params.requestId, { id: params.requestId, method: String(params.request.method).slice(0, 20), url: String(params.request.url).slice(0, MAX_ENTRY_CHARS), type: String(params.type ?? 'Other').toLowerCase().slice(0, 40) })
      if (st.network.size > MAX_LOG) st.network.delete(st.network.keys().next().value!)
      break
    case 'Network.responseReceived': {
      const e = st.network.get(params.requestId)
      if (e) e.status = params.response?.status
      if (params.type === 'Document' && params.frameId === st.mainFrameId) void checkDocumentSource(st, params.response)
      break
    }
    case 'Network.loadingFailed': {
      const e = st.network.get(params.requestId)
      if (e) e.status = `failed (${params.errorText})`
      break
    }
    case 'Fetch.requestPaused':
      void onRequestPaused(st, st.target, params)
      break
    case 'Page.fileChooserOpened':
      if (st.chooser) st.chooser({ backendNodeId: params.backendNodeId, mode: String(params.mode ?? ''), frameId: String(params.frameId ?? ''), child: false })
      else addNotice(st, CHOOSER_SUPPRESSED)
      break
    case 'Page.javascriptDialogOpening':
      // while the AI acts a dialog would block every command: alerts are closed, other questions dismissed (a "Leave
      // site?" is answered Leave only for navigate with force); otherwise the person answers it
      if (st.busy > 0) {
        const accept = params.type === 'alert' || (params.type === 'beforeunload' && st.forceLeave)
        pushConsole(st, { level: 'warn', text: `[dialog] ${params.type}: ${params.message} (${accept ? 'closed' : 'dismissed'} automatically)`, host: st.host })
        void cdp(st.target, 'Page.handleJavaScriptDialog', { accept }).catch(() => {})
      }
      break
  }
}

function onChildEvent(st: TabState, sessionId: string, method: string, params: any) {
  const child = { tabId: st.tabId, sessionId }
  switch (method) {
    case 'Fetch.requestPaused':
      void onRequestPaused(st, child, params)
      break
    case 'Page.fileChooserOpened':
      if (st.chooser) st.chooser({ backendNodeId: params.backendNodeId, mode: String(params.mode ?? ''), frameId: String(params.frameId ?? ''), child: true })
      else addNotice(st, CHOOSER_SUPPRESSED)
      break
    case 'Target.attachedToTarget': {
      // a frame inside a frame: guarded the same way; a window it opened after the AI's script: closed
      const sid = String(params.sessionId)
      const type = String(params.targetInfo?.type ?? '')
      const grand = { tabId: st.tabId, sessionId: sid }
      if (type === 'page') {
        if (st.scripted) {
          addNotice(st, POPUP_CLOSED)
          void cdp(st.target, 'Target.closeTarget', { targetId: String(params.targetInfo?.targetId ?? '') }).catch(() => {})
        } else void cdp(grand, 'Runtime.runIfWaitingForDebugger').catch(() => {})
        break
      }
      st.children.set(sid, type)
      void applyFetch(st, grand).catch(() => {}).then(() => cdp(grand, 'Runtime.runIfWaitingForDebugger').catch(() => {}))
      break
    }
    case 'Target.detachedFromTarget':
      st.children.delete(String(params.sessionId))
      break
  }
}

function onDetach(source: chrome.debugger.Debuggee, reason: string) {
  if (source.tabId === undefined) return
  const st = states.get(source.tabId)
  states.delete(source.tabId)
  if (st) {
    st.attached = false
    clearTimeout(st.idle)
    for (const w of [...st.waiters]) w()
    // Chrome took the debugger away (its bar closed, DevTools): a scripted document must not run on unguarded
    if (st.scripted && reason !== 'target_closed') void chrome.tabs.update(source.tabId, { url: 'about:blank' }).catch(() => {})
  }
  // the person closed Chrome's "started debugging" bar (or pressed its Cancel): the AI stops
  if (reason === 'canceled_by_user') onUserStop?.(source.tabId)
}

/** Listeners are added at the worker's top level (an MV3 worker woken by an event must find them). */
export function installTabListeners() {
  chrome.debugger.onEvent.addListener(onEvent)
  chrome.debugger.onDetach.addListener(onDetach)
  // a tab or window a scripted document opened (a link to a new tab, window.open): its script could reach it and no
  // guard runs in it, so it is closed at once and the AI hears why (README "Limits": its first request may already be on
  // its way)
  chrome.tabs.onCreated.addListener((tab) => {
    const opener = tab.openerTabId !== undefined ? states.get(tab.openerTabId) : undefined
    if (!opener?.scripted || tab.id === undefined) return
    addNotice(opener, POPUP_CLOSED)
    void chrome.tabs.remove(tab.id).catch(() => {})
  })
  chrome.tabs.onRemoved.addListener((tabId) => {
    const st = states.get(tabId)
    if (st) clearTimeout(st.idle)
    states.delete(tabId)
  })
  // a tab dragged out of its run's group is the AI's no more
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (change.groupId === undefined || !states.has(tabId)) return
    void runOfTab(tabId).then((r) => {
      if (!r) void detach(tabId) // navigates a scripted tab to about:blank first
    })
  })
}
