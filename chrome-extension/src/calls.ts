// browser.call from the team server: ack at once, run once per callId (a replay after a reconnect gets the kept
// result), within the call's deadline (server clock), and answer browser.result in the shared contract's shape. Stop
// (the popup's Stop of one task, closing that task's window, or closing Chrome's debugging bar on one of its tabs) ends
// that run's calls and refuses its further calls for a while.
import { BrowserResult, type BrowserCall } from '../../shared/src/api/browser'
import type { ChromeClientFrame } from '../../shared/src/api/chrome'
import { parseBrowserToolInput } from '../../shared/src/browser-tools'
import { errorResult, resultBytes, toBrowserResult } from '../../desktop/src/common/browser-result'
import { ToolError } from '../../desktop/src/common/input'
import { live, refreshBadge } from './state'
import { runFor } from './runs'
import { takeNotices } from './tabs'
import { runTool, type CallCtx, type ToolOut } from './tools'

export const STOPPED = 'The user stopped the AI in Chrome. Do not retry; ask the user what to do.'
export const WINDOW_CLOSED = "The user closed this task's window in Chrome, which stops the AI there. Do not retry; ask the user what to do."
/** a stopped run's calls are refused this long */
const STOP_HOLD_MS = 2 * 60_000
const KEEP_MS = 15 * 60_000
const KEEP_COUNT = 300
const KEEP_BYTES = 48 * 1024 * 1024
/** longest a call may run whatever deadline it carries */
const MAX_CALL_MS = 30 * 60_000

type Send = (f: ChromeClientFrame) => void

const running = new Map<string, CallCtx>()
const kept = new Map<string, { result: BrowserResult; at: number; bytes: number }>()
let keptBytes = 0
/** runs the person stopped: their calls are refused until `until`, with that sentence */
const stoppedRuns = new Map<string, { until: number; why: string }>()
/** calls the person stopped (not a deadline or the turn's own stop): their result says stopped, so an MCP app pauses */
const stoppedCalls = new Set<string>()

export function runningCalls(): CallCtx[] {
  return [...running.values()]
}

export function handleCall(call: BrowserCall, send: Send): void {
  send({ type: 'browser.ack', callId: call.callId })
  const prev = kept.get(call.callId)
  if (prev) return send({ type: 'browser.result', result: prev.result })
  if (running.has(call.callId)) return
  void runOnce(call).then((result) => {
    // a needSite answer is not kept: the server sends the same call again once the person allowed the site
    if (!result.needSite) keep(call.callId, result)
    send({ type: 'browser.result', result })
  })
}

export function cancelCall(callId: string): void {
  const c = running.get(callId)
  if (c) cancel(c, 'The turn was stopped.')
}

/** Stop one run: its running calls end, and its calls for the next two minutes are refused with `why`. */
export function stopRun(runId: string, why = STOPPED): void {
  live.stoppedAt = Date.now()
  stoppedRuns.set(runId, { until: Date.now() + STOP_HOLD_MS, why })
  while (stoppedRuns.size > 200) stoppedRuns.delete(stoppedRuns.keys().next().value!)
  for (const c of running.values()) if (c.run.id === runId) { stoppedCalls.add(c.callId); cancel(c, why) }
}

/** Chrome's debugging bar was closed: every run of this profile stops (the bar is the browser's, not one task's). */
export function stopAllRuns(): void {
  for (const id of new Set([...running.values()].map((c) => c.run.id))) stopRun(id)
}

/** The runs working now, for the popup: title and how many tabs their calls use. */
export function workingRuns(): { id: string; title: string; tabs: number }[] {
  const by = new Map<string, { id: string; title: string; tabs: Set<number> }>()
  for (const c of running.values()) {
    const e = by.get(c.run.id) ?? { id: c.run.id, title: c.run.title, tabs: new Set<number>() }
    for (const t of c.tabs) e.tabs.add(t)
    by.set(c.run.id, e)
  }
  return [...by.values()].map((e) => ({ id: e.id, title: e.title, tabs: e.tabs.size }))
}

function cancel(c: CallCtx, reason: string) {
  if (c.cancelled) return
  c.cancelled = true
  c.abort.abort(new ToolError(reason))
}

function keep(callId: string, result: BrowserResult) {
  const bytes = resultBytes(result)
  kept.set(callId, { result, at: Date.now(), bytes })
  keptBytes += bytes
  const now = Date.now()
  for (const [id, e] of kept) {
    if (kept.size <= KEEP_COUNT && keptBytes <= KEEP_BYTES && now - e.at < KEEP_MS) break
    kept.delete(id)
    keptBytes -= e.bytes
  }
}

function changed() {
  live.running = running.size
  refreshBadge()
}

async function runOnce(call: BrowserCall): Promise<BrowserResult> {
  // every call names its run (a chat, or a scheduled task's run): its own window and tabs
  if (!call.run) return errorResult(call.callId, 'This browser call names no run (no run); nothing was done. The team server is older than this extension.')
  const runId = call.run.id
  const stopped = stoppedRuns.get(runId)
  if (stopped && stopped.until > Date.now()) return { ...errorResult(call.callId, stopped.why), stopped: true }
  if (stopped) stoppedRuns.delete(runId)
  const remaining = call.deadline - (Date.now() + live.clockOffset)
  if (remaining <= 0) return errorResult(call.callId, 'The browser call arrived after its deadline; nothing was done.')
  const parsed = parseBrowserToolInput(call.tool, call.args)
  if (!parsed.ok) return errorResult(call.callId, parsed.error)
  const run = await runFor(runId, call.run.title)
  const ctx: CallCtx = {
    callId: call.callId, turnId: call.turnId, run, abort: new AbortController(), cancelled: false, notes: [], tabs: new Set(),
    // only the sites this profile may use (the server's list); "all websites" is never sent for Chrome
    rules: { sites: call.sites ?? [], office: call.office ?? [] },
  }
  running.set(call.callId, ctx)
  live.stoppedAt = 0
  changed()
  const deadline = setTimeout(() => cancel(ctx, 'The browser call took too long and was stopped.'), Math.min(remaining, MAX_CALL_MS))
  try {
    const aborted = new Promise<ToolOut>((resolve) =>
      ctx.abort.signal.addEventListener('abort', () => resolve({ content: [{ type: 'text', text: String((ctx.abort.signal.reason as Error)?.message ?? 'Stopped.') }], isError: true }), { once: true }),
    )
    const out = await Promise.race([runTool(ctx, parsed.call), aborted])
    // what happened between calls (a page the guard stopped, a file picker it closed) goes to the AI now
    const said = [...ctx.notes, ...takeNotices(ctx.tabs)]
    const r = toResult(call.callId, said.length ? { ...out, content: [{ type: 'text', text: said.join('\n') }, ...out.content] } : out)
    return stoppedCalls.has(call.callId) ? { ...r, ok: false, stopped: true } : r
  } catch (e) {
    return errorResult(call.callId, `Error: ${String((e as Error)?.message ?? e).split('\n')[0]}`)
  } finally {
    clearTimeout(deadline)
    running.delete(call.callId)
    stoppedCalls.delete(call.callId)
    changed()
  }
}

/** The wire shape, checked against the contract before it goes out. */
export function toResult(callId: string, out: ToolOut): BrowserResult {
  let r = toBrowserResult(callId, out)
  if (out.needSite) r = { ...r, ok: false, error: `site_needed: ${out.needSite.host}`, needSite: out.needSite }
  const checked = BrowserResult.safeParse(r)
  return checked.success ? checked.data : errorResult(callId, 'The browser result did not fit the answer format; nothing more could be sent.')
}
