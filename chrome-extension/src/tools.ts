// The browser tools in the person's Chrome: a port of the desktop pane's tools (desktop/src/main/pane/pane.ts exec,
// computer, screenshot, upload, resize) onto chrome.debugger. Same inputs (shared/src/browser-tools.ts), same page
// script (desktop/src/main/pane/page-script.js, here in an isolated world the page cannot see or change), same refusals
// of password and payment-card fields. What differs: tabs are the AI's tab group (tabs.ts), sites are checked
// against what the person allowed for the call (sites.ts) and a site nobody allowed comes back as needSite.
import { BROWSER_TOOLS, parseBrowserToolInput, type BrowserToolInput, type ParsedBrowserCall } from '../../shared/src/browser-tools'
import { MOD_BITS, parseKeyCombo, redactUrl, ToolError } from '../../desktop/src/common/input'
import type { PaneContent, PaneResult } from '../../desktop/src/common/browser-result'
import { cleanUploadName, uploadOrder, type UploadHow } from './upload-names'
import { cdp } from './cdp'
import { aiTabId, sha256Hex } from './ids'
import { markScripted } from './guard'
import { checkUrl, normalizeUrl, originOf, type SiteRules } from './sites'
import { live } from './state'
import { createRunTab, resolveRunTab, runTabs, useTab, type Run } from './runs'
import { attach, hold, intercept, release, tabInfo, tabUrls, waitLoaded, type TabState } from './tabs'

declare const __PAGE_SCRIPT__: string

/** The person has not allowed this site for the AI yet: nothing was done, the server asks and sends the call again. */
export class SiteNeeded extends ToolError {
  constructor(readonly host: string, readonly office?: true) {
    super(`The user has not allowed ${office ? 'the office-network address ' : ''}${host} for the AI yet; nothing was done there.`)
  }
}

export interface ToolOut extends PaneResult {
  needSite?: { host: string; office?: true }
}

export interface CallCtx {
  callId: string
  turnId: string
  /** the chat or scheduled run this call belongs to: its own window and tabs (runs.ts) */
  run: Run
  rules: SiteRules
  abort: AbortController
  cancelled: boolean
  notes: string[]
  /** the tabs this call touched (the popup counts them) */
  tabs: Set<number>
}

/** at most this many bytes of files in one file_upload in Chrome (they cross into the page as base64) */
export const CHROME_UPLOAD_MAX_BYTES = 25 * 1024 * 1024
const MAX_KEY_PRESSES = 1000
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36'
const PRESETS: Record<string, { width: number; height: number; mobile: boolean } | null> = {
  mobile: { width: 375, height: 812, mobile: true },
  tablet: { width: 768, height: 1024, mobile: false },
  desktop: null,
}
const WORLD_NAME = 'ai-browser'
const CHOOSER_WAIT_MS = 3000
/** keys allowed while a password field has focus (they type nothing) */
const SAFE_KEYS = new Set(['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'])
const PASSWORD_REFUSED = 'That is a password field. The AI may not type or click into password fields; ask the user to type it in their browser, then continue.'
const PAYMENT_REFUSED = 'That is a payment card field (card number, expiry or security code). The AI may not type or click into it; ask the user to type it in their browser, then continue.'
const OTHER_FRAME = 'Nothing was attached: that spot is inside a frame of another site embedded in the page (or a plug-in). Files are only attached to the page itself; ask the user to attach them there.'

/** password / payment-card fields (same rules as isPw in page-script.js and the desktop's PW_CHECK) */
const PW_CHECK = `(() => {
  const isPw = (el) => {
    if (!el || el.tagName !== 'INPUT') return '';
    const ac = el.getAttribute('autocomplete') || '';
    if ((el.getAttribute('type') || '').toLowerCase() === 'password' || /(^|\\s)(current-|new-)?password(\\s|$)/i.test(ac)) return 'password';
    if (/(^|\\s)cc-(number|csc|exp|exp-month|exp-year)(\\s|$)/i.test(ac)) return 'payment';
    const id = (el.getAttribute('name') || '') + ' ' + (el.id || '');
    if (/card|cvc|cvv|\\bcsc\\b|cc-?num|cc-?exp|security-?_?code/i.test(id)) return 'payment';
    return '';
  };
  const deep = (el) => { while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement; return el; };
  const at = (x, y) => { let el = document.elementFromPoint(x, y); while (el && el.shadowRoot) { const i = el.shadowRoot.elementFromPoint(x, y); if (!i || i === el) break; el = i; } return el; };
  return {
    focused: () => { const el = deep(document.activeElement); return { pw: isPw(el), inFrame: !!el && (el.tagName === 'IFRAME' || el.tagName === 'FRAME') }; },
    point: (x, y) => { const el = at(x, y); const label = el && el.closest ? el.closest('label') : null; return isPw(el) || (label ? isPw(label.control) : ''); },
  };
})()`
/** What a point lands on, followed into same-origin frames (the desktop's POINT_OWNER): ok, frame, embed, none, moved. */
const POINT_OWNER = `((x, y, mark) => {
  const top = location.origin;
  if (top === 'null') return 'frame';
  let doc = document, el = null;
  for (let depth = 0; ; depth++) {
    if (depth > 8) return 'frame';
    el = doc.elementFromPoint(x, y);
    while (el && el.shadowRoot) { const i = el.shadowRoot.elementFromPoint(x, y); if (!i || i === el) break; el = i; }
    if (!el) return 'none';
    const t = el.tagName;
    if (t === 'EMBED' || t === 'OBJECT') return 'embed';
    if (t !== 'IFRAME' && t !== 'FRAME') break;
    let inner = null;
    try { inner = el.contentDocument; if (!inner || inner.location.origin !== top) return 'frame'; } catch (e) { return 'frame'; }
    const r = el.getBoundingClientRect(), cs = el.ownerDocument.defaultView.getComputedStyle(el);
    x -= r.left + parseFloat(cs.borderLeftWidth || '0') + parseFloat(cs.paddingLeft || '0');
    y -= r.top + parseFloat(cs.borderTopWidth || '0') + parseFloat(cs.paddingTop || '0');
    doc = inner;
  }
  if (mark === 'set') window.__uploadPoint = el;
  if (mark === 'same' && window.__uploadPoint !== el) return 'moved';
  return 'ok';
})`
/** Builds File objects from base64 in the page (isolated world) and puts them into a file field. */
const PUT_FILES = `function (files) {
  const d = this.ownerDocument;
  if (!(this.tagName === 'INPUT' && String(this.type).toLowerCase() === 'file')) return { error: 'notfile' };
  if (this.disabled) return { error: 'disabled' };
  if (!this.multiple && files.length > 1) return { error: 'one' };
  if (!d || !d.defaultView || d.defaultView.location.origin !== location.origin) return { error: 'frame' };
  const dt = new DataTransfer();
  for (const f of files) {
    const bin = atob(f.b64); const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    dt.items.add(new File([bytes], f.name, { type: f.type }));
  }
  this.files = dt.files;
  this.dispatchEvent(new Event('input', { bubbles: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return { n: this.files ? this.files.length : -1 };
}`
/** A drop of the files on the element the point check kept (window.__uploadPoint, isolated world). */
const DROP_FILES = `function (files, x, y) {
  const el = window.__uploadPoint;
  if (!el || !el.isConnected) return 'gone';
  const dt = new DataTransfer();
  for (const f of files) {
    const bin = atob(f.b64); const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    dt.items.add(new File([bytes], f.name, { type: f.type }));
  }
  for (const type of ['dragenter', 'dragover', 'drop']) {
    el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, dataTransfer: dt }));
  }
  return 'ok';
}`

const PAGE_SETUP = `window.__name = window.__name || ((f) => f);\n${typeof __PAGE_SCRIPT__ === 'string' ? __PAGE_SCRIPT__ : ''}\n;window.__aiCheck = ${PW_CHECK}; true`

type SecretField = 'password' | 'payment'
const asSecret = (v: unknown): SecretField | '' => (v === 'payment' ? 'payment' : v ? 'password' : '')
const ok = (text: string, images: PaneContent[] = []): ToolOut => ({ content: [{ type: 'text', text }, ...images], isError: false })
const err = (text: string): ToolOut => ({ content: [{ type: 'text', text }], isError: true })
export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true })
  })

/** Tools whose result carries what the page shows (text, tree, pixels, script values). */
function returnsPageData(call: ParsedBrowserCall): boolean {
  if (BROWSER_TOOLS[call.tool].kind === 'reads-tab' || call.tool === 'javascript_tool') return true
  return call.tool === 'computer' && (call.input.action === 'screenshot' || call.input.action === 'zoom')
}

/** May the AI use this page address in this call? Throws the hand-over sentence or SiteNeeded. */
function permit(url: string, rules: SiteRules, tool: string): void {
  const v = checkUrl(url, rules, live.link?.teamHosts ?? [])
  if (v.kind === 'blank') {
    if (tool === 'javascript_tool') throw new ToolError('javascript_tool needs a web page: open one with navigate first (the user will be asked about that site).')
    return
  }
  if (v.kind === 'blocked') throw new ToolError(v.message)
  if (v.kind === 'need') throw new SiteNeeded(v.host, v.office)
}

// ------------------------------------------------------------------ batch and single

export async function runTool(ctx: CallCtx, call: ParsedBrowserCall): Promise<ToolOut> {
  return call.tool === 'browser_batch' ? batch(ctx, call.input) : single(ctx, call)
}

async function batch(ctx: CallCtx, input: BrowserToolInput['browser_batch']): Promise<ToolOut> {
  const { actions } = input
  if (actions.some((a) => a.name === 'browser_batch')) return err('browser_batch cannot be nested; list the sub-actions directly.')
  if (actions.some((a) => a.name === 'preview_start')) return err('preview_start is not batchable; call it on its own (or start the batch with navigate).')
  if (actions.some((a) => a.name === 'file_upload')) return err('file_upload is not batchable; call it on its own.')
  const content: PaneContent[] = []
  for (let i = 0; i < actions.length; i++) {
    if (ctx.cancelled) return { content: [...content, { type: 'text', text: 'Stopped.' }], isError: true }
    const a = actions[i]
    const sub = { ...a.input }
    if (input.save_to_disk && a.name === 'computer') sub.save_to_disk = true
    const p = parseBrowserToolInput(a.name, sub)
    const r = p.ok ? await single(ctx, p.call) : err(p.error)
    content.push({ type: 'text', text: `[${i + 1}/${actions.length}] ${a.name}${r.isError ? ' failed' : ''}:` }, ...r.content)
    if (r.isError) {
      content.push({ type: 'text', text: `Stopped at action ${i + 1}; the remaining ${actions.length - i - 1} were not run.` })
      return { content, isError: true, ...(r.needSite ? { needSite: r.needSite } : {}) }
    }
  }
  return { content, isError: false }
}

async function single(ctx: CallCtx, call: ParsedBrowserCall): Promise<ToolOut> {
  let st: TabState | undefined
  try {
    switch (call.tool) {
      case 'tabs_context': {
        const list = await runTabs(ctx.run)
        const urls = await tabUrls(list.map((t) => t.id!))
        const tabs = list.map((t) => ({ tabId: aiTabId(t.id!), origin: originOf(urls.get(t.id!) ?? ''), isActive: t.active }))
        return ok(`${JSON.stringify({ browserOpen: tabs.length > 0, tabs }, null, 2)}\nThese are the tabs of this task's own window in the user's Chrome; the AI sees no other tab.`)
      }
      case 'tabs_create': {
        const id = await createRunTab(ctx.run, ctx.turnId, Boolean(call.input.foreground))
        return ok(`Created tab ${aiTabId(id)}${call.input.foreground ? ' (fronted)' : ' in the background'}. Load a page into it with navigate and this tabId.`)
      }
      case 'tabs_select': {
        const id = (await resolveRunTab(ctx.run, ctx.turnId, call.input.tabId, true))!
        // the active tab of this task's own window only: no window is raised or focused
        await chrome.tabs.update(id, { active: true })
        return ok(`Fronted tab ${aiTabId(id)}.`)
      }
      case 'tabs_close': {
        const id = (await resolveRunTab(ctx.run, ctx.turnId, call.input.tabId, true))!
        await chrome.tabs.remove(id)
        return ok(`Closed tab ${aiTabId(id)}.`)
      }
      case 'preview_start': {
        const url = normalizeUrl(call.input.url)
        permit(url, ctx.rules, call.tool)
        const id = await createRunTab(ctx.run, ctx.turnId, true)
        st = await use(ctx, id)
        await load(ctx, st, url)
        const info = await tabInfo(id)
        return ok(`Opened ${info.url} in the user's Chrome — tabId ${aiTabId(id)}. Title: ${info.title}`)
      }
      case 'navigate': {
        const raw = call.input.url
        if (raw === 'back' || raw === 'forward') {
          const id = (await resolveRunTab(ctx.run, ctx.turnId, call.input.tabId, true))!
          await front(id)
          st = await use(ctx, id)
          return await history(ctx, st, raw)
        }
        const url = normalizeUrl(raw)
        permit(url, ctx.rules, call.tool)
        const id = (await resolveRunTab(ctx.run, ctx.turnId, call.input.tabId, false)) ?? (await createRunTab(ctx.run, ctx.turnId, true))
        await front(id)
        st = await use(ctx, id)
        st.forceLeave = Boolean(call.input.force)
        try {
          await load(ctx, st, url)
        } finally {
          st.forceLeave = false
        }
        const info = await tabInfo(id)
        return ok(`Navigated tab ${aiTabId(id)} to ${info.url} — ${info.title}`)
      }
      case 'browser_batch':
        return err('browser_batch cannot be nested.')
    }
    // every other tool acts on a group tab whose page the person allowed
    const id = (await resolveRunTab(ctx.run, ctx.turnId, (call.input as { tabId?: string }).tabId, true))!
    const before = (await tabInfo(id)).url
    permit(before, ctx.rules, call.tool)
    // Chrome slows background tabs down to seconds per command: the tab the AI acts on is the active tab of its own
    // task window (never the person's window, and the window is not raised)
    await front(id)
    st = await use(ctx, id)
    const kind = BROWSER_TOOLS[call.tool].kind
    if (kind === 'mutates-tab') await intercept(st)
    const result = await exec(ctx, st, call, before)
    // a page that moved to another site while it was read (or photographed): nothing of it goes to the AI
    if (returnsPageData(call)) {
      const now = (await tabInfo(id)).url
      if (now !== before) permit(now, ctx.rules, call.tool)
    }
    await settle(st, ctx.abort.signal)
    const moved = takeBlocked(st)
    if (moved) result.content.push({ type: 'text', text: moved.office ? `The page tried to open the office-network address ${moved.host}, which the user has not allowed; it was not loaded. Open it with navigate if it is needed (the user will be asked).` : `The page tried to open ${moved.host}, which the user has not allowed for the AI; it was not loaded. Open it with navigate if it is needed (the user will be asked).` })
    return result
  } catch (e) {
    if (e instanceof SiteNeeded) return { content: [{ type: 'text', text: e.message }], isError: true, needSite: { host: e.host, ...(e.office ? { office: true as const } : {}) } }
    return err(e instanceof ToolError ? e.message : `Error: ${String((e as Error)?.message ?? e).split('\n')[0]}`)
  } finally {
    if (st) await release(st)
  }
}

/** Attach (lazily), hold the tab for this call, remember it as the AI's last tab. */
async function use(ctx: CallCtx, tabId: number): Promise<TabState> {
  const st = await attach(tabId, ctx.rules)
  await hold(st)
  ctx.tabs.add(tabId)
  useTab(ctx.run, ctx.turnId, tabId)
  return st
}

async function load(ctx: CallCtx, st: TabState, url: string) {
  st.blockedNav = undefined
  const loaded = waitLoaded(st, 15_000, ctx.abort.signal)
  const r = await cdp<{ loaderId?: string; errorText?: string }>(st.target, 'Page.navigate', { url })
  if (r.errorText && /ERR_BLOCKED_BY_CLIENT/.test(r.errorText)) {
    const moved = takeBlocked(st)
    if (moved) throw new SiteNeeded(moved.host, moved.office)
    throw new ToolError(`Opening ${redactUrl(url)} was blocked: it led to an address the AI may not open in the user's Chrome (the team's own address or this computer).`)
  }
  if (r.errorText && !/ERR_ABORTED/.test(r.errorText)) throw new ToolError(`Could not load ${url}: ${r.errorText}`)
  if (r.loaderId && !r.errorText) await loaded
  // a redirect to a site nobody allowed was stopped (guard.ts): the person is asked about that site
  const moved = takeBlocked(st)
  if (moved) throw new SiteNeeded(moved.host, moved.office)
}

/** The page load the guard stopped during this call (guard.ts onRequestPaused), taken once. */
function takeBlocked(st: TabState): TabState['blockedNav'] {
  const moved = st.blockedNav
  st.blockedNav = undefined
  return moved
}

async function history(ctx: CallCtx, st: TabState, dir: 'back' | 'forward'): Promise<ToolOut> {
  const h = await cdp<{ currentIndex: number; entries: { id: number; url: string; title: string }[] }>(st.target, 'Page.getNavigationHistory')
  const entry = h.entries[h.currentIndex + (dir === 'back' ? -1 : 1)]
  if (!entry) return ok(`There is no page to go ${dir} to.`)
  permit(entry.url, ctx.rules, 'navigate')
  const loaded = waitLoaded(st, 10_000, ctx.abort.signal)
  await cdp(st.target, 'Page.navigateToHistoryEntry', { entryId: entry.id })
  await loaded
  const info = await tabInfo(st.tabId)
  return ok(`Went ${dir}: ${info.url} — ${info.title}`)
}

/** Let navigations started by an action finish. */
async function settle(st: TabState, signal?: AbortSignal) {
  await sleep(150, signal)
  if (st.attached && st.loading) await waitLoaded(st, 10_000, signal)
}

// ------------------------------------------------------------------ the page script (isolated world)

async function world(st: TabState): Promise<number> {
  if (st.world !== undefined) return st.world
  const w = await cdp<{ executionContextId: number }>(st.target, 'Page.createIsolatedWorld', { frameId: st.mainFrameId, worldName: WORLD_NAME, grantUniveralAccess: false })
  const r = await cdp<any>(st.target, 'Runtime.evaluate', { expression: PAGE_SETUP, contextId: w.executionContextId, returnByValue: true })
  if (r.exceptionDetails) throw new ToolError(`The page could not be read (${r.exceptionDetails.text ?? 'script error'}).`)
  st.world = w.executionContextId
  return st.world
}

/** Evaluate in the isolated world; a world gone with its document is made again once. */
async function inWorld(st: TabState, expression: string, byValue = true): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const contextId = await world(st)
    try {
      const r = await cdp<any>(st.target, 'Runtime.evaluate', { expression, contextId, returnByValue: byValue, awaitPromise: true })
      if (r.exceptionDetails) throw new ToolError(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
      return r.result
    } catch (e) {
      if (attempt === 0 && /context/i.test(String((e as Error)?.message ?? e)) && !(e instanceof ToolError)) {
        st.world = undefined
        continue
      }
      throw e
    }
  }
}

/** Call a page-script helper (window.__claude.* in the isolated world) and return its value. */
async function page(st: TabState, call: string): Promise<any> {
  return (await inWorld(st, `window.__claude.${call}`)).value
}

/** The focused field is a password or payment-card field (its kind), or ''. Frames are asked too. */
async function passwordFocused(st: TabState): Promise<SecretField | ''> {
  const top = ((await inWorld(st, '__aiCheck.focused()').catch(() => null))?.value ?? { pw: '', inFrame: false }) as { pw: unknown; inFrame: boolean }
  if (asSecret(top.pw)) return asSecret(top.pw)
  if (!top.inFrame) return ''
  // focus is inside a frame (card fields usually are): frames of this process, then other sites' frames
  const tree = await cdp<{ frameTree: FrameNode }>(st.target, 'Page.getFrameTree').catch(() => null)
  const frames: string[] = []
  const walk = (n: FrameNode) => n.childFrames?.forEach((c) => (frames.push(c.frame.id), walk(c)))
  if (tree) walk(tree.frameTree)
  for (const frameId of frames) {
    const w = await cdp<{ executionContextId: number }>(st.target, 'Page.createIsolatedWorld', { frameId, worldName: WORLD_NAME }).catch(() => null)
    if (!w) continue
    const r = await cdp<any>(st.target, 'Runtime.evaluate', { expression: `${PW_CHECK}.focused()`, contextId: w.executionContextId, returnByValue: true }).catch(() => null)
    if (asSecret(r?.result?.value?.pw)) return asSecret(r.result.value.pw)
  }
  for (const [sessionId, type] of st.children) {
    if (type !== 'iframe') continue
    const r = await cdp<any>({ tabId: st.tabId, sessionId }, 'Runtime.evaluate', { expression: `${PW_CHECK}.focused()`, returnByValue: true }).catch(() => null)
    if (asSecret(r?.result?.value?.pw)) return asSecret(r.result.value.pw)
  }
  return ''
}
interface FrameNode { frame: { id: string; url: string; securityOrigin?: string }; childFrames?: FrameNode[] }

function refusePassword(kind: SecretField = 'password'): never {
  throw new ToolError(kind === 'payment' ? PAYMENT_REFUSED : PASSWORD_REFUSED)
}

async function viewport(st: TabState): Promise<{ width: number; height: number; dpr: number }> {
  const v = (await inWorld(st, '[innerWidth, innerHeight, devicePixelRatio]').catch(() => null))?.value
  const sane = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= 16_384
  if (Array.isArray(v) && sane(v[0]) && sane(v[1])) return { width: Math.round(v[0]), height: Math.round(v[1]), dpr: sane(v[2]) ? v[2] : 1 }
  return { width: 1280, height: 800, dpr: 1 }
}

// ------------------------------------------------------------------ the tools

async function exec(ctx: CallCtx, st: TabState, call: ParsedBrowserCall, pageUrl: string): Promise<ToolOut> {
  const title = async () => (await tabInfo(st.tabId)).title
  switch (call.tool) {
    case 'read_page': {
      const i = call.input
      const r = await page(st, `tree(${JSON.stringify({ filter: i.filter === 'interactive' ? 'interactive' : 'all', depth: i.depth ?? 15, refId: i.ref_id, maxChars: i.max_chars ?? 50_000 })})`)
      if (r?.error) throw new ToolError(r.error)
      return ok(`${pageUrl} — ${await title()}\n${r?.text || '(no elements)'}`)
    }
    case 'find': {
      const r = await page(st, `find(${JSON.stringify(call.input.query)})`)
      if (!r?.matches?.length) return ok(`No elements match "${call.input.query}". Try other words or read_page.`)
      return ok(`${r.matches.join('\n')}${r.more ? '\nMore than 20 matches; use a more specific query.' : ''}`)
    }
    case 'get_page_text': {
      const max = call.input.max_chars ?? 50_000
      const text = String((await page(st, 'text()')) ?? '').replace(/\n{3,}/g, '\n\n').trim()
      return ok(`${pageUrl} — ${await title()}\n\n${text.length > max ? `${text.slice(0, max)}\n… (truncated)` : text || '(no text)'}`)
    }
    case 'form_input': {
      const { ref, value } = call.input
      const secret = asSecret(await page(st, `passwordRef(${JSON.stringify(ref)})`))
      if (secret) refusePassword(secret)
      const r = await page(st, `setValue(${JSON.stringify(ref)}, ${JSON.stringify(value)})`)
      if (!r?.ok) throw new ToolError(String(r?.error ?? `Could not set ${ref}.`).replace('in the browser pane', 'in their browser'))
      return ok(`Set ${ref}${r.name ? ` "${r.name}"` : ''} to ${JSON.stringify(value)}`)
    }
    case 'javascript_tool': {
      // from now on this document's requests to sites the person has not allowed fail (guard.ts)
      await markScripted(st)
      // replMode = DevTools console semantics: top-level await, last expression value; in the page's own world
      const r = await cdp<any>(st.target, 'Runtime.evaluate', { expression: call.input.text, replMode: true, awaitPromise: true, returnByValue: true, userGesture: false, timeout: 30_000 })
      if (r.exceptionDetails) return err(`Uncaught ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
      const v = r.result ?? { type: 'undefined' }
      const out = v.type === 'undefined' ? 'undefined' : v.value !== undefined ? (typeof v.value === 'string' ? v.value : JSON.stringify(v.value, null, 2)) : (v.description ?? v.type)
      return ok(out.length > 20_000 ? `${out.slice(0, 20_000)}\n… (truncated)` : out)
    }
    case 'read_console_messages': {
      const i = call.input
      let rows = st.console.filter((m) => m.host === st.host)
      if (i.onlyErrors) rows = rows.filter((m) => m.level === 'error')
      if (i.pattern) rows = rows.filter((m) => m.text.includes(i.pattern!))
      const shown = rows.slice(-Math.min(200, i.limit ?? 50))
      if (!shown.length) return ok(`No console messages${i.pattern ? ` containing "${i.pattern}"` : ''} on ${st.host || 'this page'} since the AI started using this tab.`)
      return ok(shown.map((m) => `[${m.level}] ${m.text}`).join('\n'))
    }
    case 'read_network_requests': {
      const i = call.input
      if (i.requestId) {
        const entry = st.network.get(i.requestId)
        if (!entry) throw new ToolError(`No request ${i.requestId} on this page.`)
        const body = await cdp<{ body: string; base64Encoded: boolean }>(st.target, 'Network.getResponseBody', { requestId: entry.id }).catch(() => null)
        if (!body) throw new ToolError(`The body of ${i.requestId} is not available (not finished, or evicted).`)
        const text = body.base64Encoded ? new TextDecoder().decode(Uint8Array.from(atob(body.body), (c) => c.charCodeAt(0))) : body.body
        return ok(`${entry.method} ${redactUrl(entry.url)} → ${entry.status ?? 'pending'}\n\n${text.length > 20_000 ? `${text.slice(0, 20_000)}\n… (truncated)` : text}`)
      }
      // method, address (auth values redacted), status and type: never headers or cookies
      let rows = [...st.network.values()].map((r) => ({ ...r, url: redactUrl(r.url) }))
      if (i.urlPattern) rows = rows.filter((r) => r.url.includes(i.urlPattern!))
      const shown = rows.slice(-(i.limit ?? 50))
      if (!shown.length) return ok('No network requests recorded for this page since the AI started using this tab.')
      return ok(shown.map((r) => `[${r.id}] ${r.method} ${r.url} → ${r.status ?? 'pending'} (${r.type})`).join('\n'))
    }
    case 'resize_window':
      return resize(st, call.input)
    case 'computer':
      return computer(ctx, st, call.input)
    case 'file_upload':
      return upload(ctx, st, call.input, pageUrl)
    default:
      return err(`${call.tool} cannot run here.`)
  }
}

/** The tab on screen in its own task window (screenshots need it; background tabs are throttled). */
async function front(tabId: number) {
  const t = await chrome.tabs.get(tabId)
  if (!t.active) {
    await chrome.tabs.update(tabId, { active: true })
    await sleep(250)
  }
}

async function screenshot(st: TabState, region?: number[], scale = 1): Promise<{ text: string; data: string }> {
  await front(st.tabId)
  const vp = await viewport(st)
  const metrics = await cdp<{ cssVisualViewport?: { pageX: number; pageY: number } }>(st.target, 'Page.getLayoutMetrics').catch(() => null)
  const px = metrics?.cssVisualViewport?.pageX ?? 0
  const py = metrics?.cssVisualViewport?.pageY ?? 0
  const fit = (v: number, max: number) => Math.min(Math.max(0, Math.round(v)), Math.max(1, Math.round(max)))
  let rect = { x: 0, y: 0, width: vp.width, height: vp.height }
  if (region) {
    const x0 = fit(Math.min(region[0], region[2]), vp.width - 1)
    const y0 = fit(Math.min(region[1], region[3]), vp.height - 1)
    const x1 = fit(Math.max(region[0], region[2]), vp.width)
    const y1 = fit(Math.max(region[1], region[3]), vp.height)
    rect = { x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) }
  }
  // screenshots in CSS pixels so coordinates match; zoom keeps device pixels for small text
  const clipScale = region ? scale : scale / vp.dpr
  const shot = await cdp<{ data: string }>(st.target, 'Page.captureScreenshot', {
    format: 'jpeg', quality: 70, captureBeyondViewport: false,
    clip: { x: px + rect.x, y: py + rect.y, width: rect.width, height: rect.height, scale: clipScale },
  })
  if (!shot?.data) throw new ToolError('The tab could not be photographed (its window may be minimized). Read it with read_page or get_page_text, or ask the user to show the window.')
  const size = region ? `region (${region.join(', ')}) magnified` : `viewport ${vp.width}x${vp.height}`
  const note = scale < 1 ? ` · image scaled to ${Math.round(scale * 100)}%; coordinates stay in the ${vp.width}x${vp.height} frame` : ''
  return { text: `Screenshot · ${size}${note}`, data: shot.data }
}

async function point(st: TabState, input: BrowserToolInput['computer']): Promise<{ x: number; y: number; name?: string }> {
  if (input.ref) {
    const c = await page(st, `center(${JSON.stringify(input.ref)})`)
    if (!c) throw new ToolError(`No element ${input.ref} on the page (it may have changed). Call read_page or find again.`)
    await sleep(50) // let scrollIntoView land
    return { x: c.x, y: c.y, name: c.name }
  }
  const c = input.coordinate
  if (!c) throw new ToolError(`${input.action} needs coordinate [x, y] or ref.`)
  return { x: c[0], y: c[1] }
}

const mouse = (st: TabState, type: string, x: number, y: number, extra: Record<string, unknown> = {}) =>
  cdp(st.target, 'Input.dispatchMouseEvent', { type, x, y, ...extra })

async function click(st: TabState, p: { x: number; y: number }, button: 'left' | 'right', clickCount: number, modifiers: number) {
  await mouse(st, 'mouseMoved', p.x, p.y, { modifiers })
  for (let i = 1; i <= clickCount; i++) {
    await mouse(st, 'mousePressed', p.x, p.y, { button, clickCount: i, modifiers, buttons: button === 'left' ? 1 : 2 })
    await mouse(st, 'mouseReleased', p.x, p.y, { button, clickCount: i, modifiers })
  }
}

async function key(st: TabState, combo: string) {
  const { def, modifiers, command } = parseKeyCombo(combo)
  const base = { key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode, modifiers }
  await cdp(st.target, 'Input.dispatchKeyEvent', {
    type: def.text ? 'keyDown' : 'rawKeyDown',
    ...base,
    ...(def.text ? { text: def.text, unmodifiedText: def.text } : {}),
    ...(command ? { commands: [command] } : {}),
  })
  await cdp(st.target, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

async function computer(ctx: CallCtx, st: TabState, input: BrowserToolInput['computer']): Promise<ToolOut> {
  const action = input.action
  const modifiers = input.modifiers ? input.modifiers.split('+').reduce((m, k) => m | (MOD_BITS[k.trim().toLowerCase()] ?? 0), 0) : 0
  switch (action) {
    case 'screenshot':
    case 'zoom': {
      if (action === 'zoom' && !input.region) throw new ToolError('zoom needs region [x0, y0, x1, y1].')
      const s = await screenshot(st, action === 'zoom' ? input.region : undefined, input.scale ?? 1)
      return ok(`${s.text}${input.save_to_disk ? '\nThe image is shown to the user in the chat.' : ''}`, [
        { type: 'image', data: s.data, mimeType: 'image/jpeg', ...(input.save_to_disk ? { share: true } : {}) },
      ])
    }
    case 'left_click':
    case 'right_click':
    case 'double_click':
    case 'triple_click': {
      const p = await point(st, input)
      const secret = asSecret((await inWorld(st, `__aiCheck.point(${Number(p.x)}, ${Number(p.y)})`).catch(() => null))?.value)
      if (secret) refusePassword(secret)
      const count = action === 'double_click' ? 2 : action === 'triple_click' ? 3 : 1
      await click(st, p, action === 'right_click' ? 'right' : 'left', count, modifiers)
      return ok(`${action.replace('_', ' ')} at (${Math.round(p.x)}, ${Math.round(p.y)})${p.name ? ` on "${p.name}"` : ''}`)
    }
    case 'hover': {
      const p = await point(st, input)
      await mouse(st, 'mouseMoved', p.x, p.y)
      return ok(`Hovered at (${Math.round(p.x)}, ${Math.round(p.y)})${p.name ? ` over "${p.name}"` : ''}`)
    }
    case 'type': {
      if (typeof input.text !== 'string') throw new ToolError('type needs text.')
      const secret = await passwordFocused(st)
      if (secret) refusePassword(secret)
      await cdp(st.target, 'Input.insertText', { text: input.text })
      return ok(`Typed ${JSON.stringify(input.text)}`)
    }
    case 'key': {
      const text = input.text?.trim()
      if (!text) throw new ToolError('key needs keys in text, e.g. "Enter" or "cmd+a".')
      const keys = text.split(/\s+/)
      if (keys.some((k) => /^(cmd|ctrl|meta|control)\+(=|-|0|\+)$/i.test(k))) throw new ToolError('Page zoom shortcuts are not supported; use the zoom action instead.')
      if (keys.length * (input.repeat ?? 1) > MAX_KEY_PRESSES) throw new ToolError(`At most ${MAX_KEY_PRESSES} key presses per call (keys × repeat); use type for text.`)
      const parsed = keys.map((k) => parseKeyCombo(k)) // throws on unknown keys before anything is pressed
      if (parsed.some((p) => !SAFE_KEYS.has(p.def.key) || p.command)) {
        const secret = await passwordFocused(st)
        if (secret) refusePassword(secret)
      }
      const repeat = input.repeat ?? 1
      for (let i = 0; i < repeat; i++) {
        for (const k of keys) {
          if (ctx.cancelled) throw new ToolError('Stopped.')
          await key(st, k)
        }
      }
      return ok(`Pressed ${text}${repeat > 1 ? ` ×${repeat}` : ''}`)
    }
    case 'scroll': {
      const vp = await viewport(st)
      const c = input.coordinate ?? [vp.width / 2, vp.height / 2]
      const ticks = input.scroll_amount ?? 3
      const dir = input.scroll_direction ?? 'down'
      const px = ticks * 100
      await mouse(st, 'mouseWheel', c[0], c[1], { deltaX: dir === 'left' ? -px : dir === 'right' ? px : 0, deltaY: dir === 'up' ? -px : dir === 'down' ? px : 0 })
      await sleep(250, ctx.abort.signal)
      return ok(`Scrolled ${dir} ${ticks} ticks at (${Math.round(c[0])}, ${Math.round(c[1])})`)
    }
    case 'scroll_to': {
      if (!input.ref) throw new ToolError('scroll_to needs ref.')
      const p = await point(st, input)
      return ok(`Scrolled ${input.ref} into view; it is now at (${Math.round(p.x)}, ${Math.round(p.y)}).`)
    }
    case 'left_click_drag': {
      const s = input.start_coordinate
      const e = input.coordinate
      if (!s || !e) throw new ToolError('left_click_drag needs start_coordinate and coordinate.')
      const from = { x: s[0], y: s[1] }
      const to = { x: e[0], y: e[1] }
      await mouse(st, 'mouseMoved', from.x, from.y)
      await mouse(st, 'mousePressed', from.x, from.y, { button: 'left', clickCount: 1, buttons: 1 })
      for (let i = 1; i <= 12; i++) await mouse(st, 'mouseMoved', from.x + ((to.x - from.x) * i) / 12, from.y + ((to.y - from.y) * i) / 12, { buttons: 1 })
      await mouse(st, 'mouseReleased', to.x, to.y, { button: 'left', clickCount: 1 })
      return ok(`Dragged from (${from.x}, ${from.y}) to (${to.x}, ${to.y})`)
    }
    case 'wait': {
      const sec = input.duration ?? 1
      await sleep(sec * 1000, ctx.abort.signal)
      return ok(`Waited ${sec}s`)
    }
  }
}

async function resize(st: TabState, input: BrowserToolInput['resize_window']): Promise<ToolOut> {
  const notes: string[] = []
  if (input.colorScheme) {
    await cdp(st.target, 'Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: input.colorScheme }] })
    notes.push(`prefers-color-scheme: ${input.colorScheme}`)
  }
  let size: { width: number; height: number; mobile: boolean } | null | undefined
  if (input.preset) size = PRESETS[input.preset]
  else if (input.width !== undefined || input.height !== undefined) {
    if (!(input.width && input.height)) throw new ToolError('Custom sizes need both width and height.')
    size = { width: input.width, height: input.height, mobile: input.width < 768 }
  }
  if (size === null) {
    await cdp(st.target, 'Emulation.clearDeviceMetricsOverride')
    await cdp(st.target, 'Emulation.setTouchEmulationEnabled', { enabled: false })
    await cdp(st.target, 'Emulation.setUserAgentOverride', { userAgent: navigator.userAgent })
    notes.push('viewport back to the window size')
  } else if (size) {
    await cdp(st.target, 'Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 0, mobile: size.mobile })
    await cdp(st.target, 'Emulation.setTouchEmulationEnabled', { enabled: size.mobile, maxTouchPoints: size.mobile ? 5 : 1 })
    if (size.mobile) await cdp(st.target, 'Emulation.setUserAgentOverride', { userAgent: MOBILE_UA })
    notes.push(`viewport ${size.width}x${size.height}${size.mobile ? ' (mobile device: touch + Android user agent; reload so load-time checks re-run)' : ''}`)
  }
  if (!notes.length) throw new ToolError('Pass a preset, width and height, or colorScheme.')
  return ok(`Tab ${aiTabId(st.tabId)}: ${notes.join('; ')}. The emulation ends when the AI stops using this tab.`)
}

// ------------------------------------------------------------------ file_upload

const MIME: Record<string, string> = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  txt: 'text/plain', csv: 'text/csv', json: 'application/json', zip: 'application/zip', mp4: 'video/mp4', mp3: 'audio/mpeg',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', hwp: 'application/x-hwp',
}
const mimeOf = (name: string) => MIME[name.split('.').pop()?.toLowerCase() ?? ''] ?? ''

function toB64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

/**
 * file_upload (docs/decisions/20261126-browser-file-upload.md): fetch each ticket from the team server with the link
 * token, check its size and sha256, and put the files into the page (main frame only): the file field behind the ref,
 * else the picker its click opens (taken over: no window opens), else a drop there. The page must still be the site
 * the person allowed for this call.
 */
async function upload(ctx: CallCtx, st: TabState, input: BrowserToolInput['file_upload'], pageUrl: string): Promise<ToolOut> {
  const link = live.link
  if (!link) throw new ToolError('This Chrome is not connected to the team; nothing was attached.')
  if (!input.ref && !input.coordinate) throw new ToolError('file_upload needs ref (or coordinate) of the file field, or of the button or area that opens the file picker. Find it with read_page or find.')
  if (input.ref && !(await page(st, `describe(${JSON.stringify(input.ref)})`))) throw new ToolError(`No element ${input.ref} on the page (it may have changed). Call read_page or find again.`)
  const total = input.files.reduce((n, f) => n + f.size, 0)
  if (total > CHROME_UPLOAD_MAX_BYTES) throw new ToolError(`These files are ${Math.ceil(total / 1024 / 1024)} MB together; at most 25 MB can be attached in one call in Chrome. Attach fewer or smaller files, or ask the user to attach them.`)
  const site = new URL(pageUrl).host
  const samePage = async () => {
    const now = (await tabInfo(st.tabId)).url
    let host = ''
    try { host = new URL(now).host } catch { host = '' }
    if (host !== site) throw new ToolError('The page moved to another site; nothing was attached. Take a screenshot and try again.')
  }
  const files: { name: string; b64: string; type: string }[] = []
  for (const f of input.files) {
    if (ctx.cancelled) throw new ToolError('Stopped.')
    const gone = new ToolError(`"${f.name}" could not be fetched from the team server (the user can no longer send it, or the call took too long); nothing was attached. Call file_upload again.`)
    let res: Response
    try {
      res = await fetch(`${link.origin}/api/chrome/uploads/${encodeURIComponent(f.ticket)}`, { headers: { Authorization: `Bearer ${link.token}` }, signal: ctx.abort.signal, credentials: 'omit', cache: 'no-store' })
    } catch {
      throw gone
    }
    if (!res.ok) throw gone
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (bytes.length !== f.size || (await sha256Hex(bytes)) !== f.sha256) throw new ToolError(`"${f.name}" did not arrive as the server sent it (its size or checksum differs); nothing was attached. Call file_upload again.`)
    const name = cleanUploadName(f.name)
    files.push({ name, b64: toB64(bytes), type: mimeOf(name) })
  }
  await samePage()
  let done: UploadHow | null = null
  const tried: string[] = []
  for (const way of uploadOrder(input.how)) {
    if (ctx.cancelled) throw new ToolError('Stopped.')
    const r = await uploadBy(way, ctx, st, input, files, samePage)
    if (r === true) {
      done = way
      break
    }
    tried.push(r)
  }
  if (!done) throw new ToolError(`Nothing was attached: ${tried.join('; ')}. Read the page again and give the ref of the file field or of the button that opens the file picker${input.how && input.how !== 'auto' ? ', or try without how' : ''}.`)
  const n = files.length
  const via = done === 'input' ? "through the page's file field" : done === 'chooser' ? 'through the file picker the click opened' : 'as a drop on that spot'
  const check = done === 'drop' ? ' A drop cannot be checked from here: take a screenshot to see whether the page took them.' : ' Take a screenshot to check they show in the page.'
  return ok(`Attached ${n} file${n === 1 ? '' : 's'} to ${site.replace(/^www\./, '')} (${files.map((f) => f.name).join(', ')}) ${via}.${check} The page's own button sends them; sending still needs the user's OK.`)
}

async function uploadBy(way: UploadHow, ctx: CallCtx, st: TabState, input: BrowserToolInput['file_upload'], files: { name: string; b64: string; type: string }[], samePage: () => Promise<void>): Promise<true | string> {
  const n = files.length
  const oneFile = () => new ToolError(`That file field takes one file, and this call has ${n}. Attach one file per call (when the page offers a new field after each), or ask the user to attach the rest.`)
  const put = async (objectId: string): Promise<true | string> => {
    await samePage()
    const r = await cdp<any>(st.target, 'Runtime.callFunctionOn', { objectId, functionDeclaration: PUT_FILES, arguments: [{ value: files }], returnByValue: true })
    void cdp(st.target, 'Runtime.releaseObject', { objectId }).catch(() => {})
    const v = r?.result?.value ?? {}
    if (v.error === 'frame' || v.error === 'notfile') throw new ToolError(OTHER_FRAME)
    if (v.error === 'disabled') return 'the file field is turned off on the page right now'
    if (v.error === 'one') throw oneFile()
    return v.n === n ? true : 'the file field did not take the files'
  }
  if (way === 'input') {
    const c = input.coordinate
    const expr = input.ref ? `window.__claude.uploadTarget(${JSON.stringify(input.ref)})` : `window.__claude.uploadTargetAt(${Number(c![0])}, ${Number(c![1])})`
    const r = await inWorld(st, expr, false).catch(() => null)
    if (r?.subtype !== 'node' || !r.objectId) return 'no file field behind it'
    return put(r.objectId)
  }
  const p = input.ref ? await point(st, { action: 'left_click', ref: input.ref }) : { x: input.coordinate![0], y: input.coordinate![1] }
  const secret = asSecret((await inWorld(st, `__aiCheck.point(${Number(p.x)}, ${Number(p.y)})`).catch(() => null))?.value)
  if (secret) refusePassword(secret)
  // a click or a drop goes to whatever frame is under the point: never one of another origin
  const owner = (await inWorld(st, `${POINT_OWNER}(${Number(p.x)}, ${Number(p.y)}, 'set')`).catch(() => null))?.value ?? 'frame'
  if (owner !== 'ok' && owner !== 'none') throw new ToolError(OTHER_FRAME)
  if (owner === 'none') return 'nothing is at that spot'
  if (way === 'chooser') {
    await intercept(st)
    if (!st.intercepting) return 'file pickers cannot be taken over on this page'
    let timer: ReturnType<typeof setTimeout> | undefined
    const opened = new Promise<{ backendNodeId: number; mode: string; frameId: string; child: boolean } | null>((resolve) => {
      st.chooser = resolve
      timer = setTimeout(() => resolve(null), CHOOSER_WAIT_MS)
      ctx.abort.signal.addEventListener('abort', () => resolve(null), { once: true })
    })
    try {
      await click(st, p, 'left', 1, 0)
      const c = await opened
      if (!c) return 'its click opened no file picker'
      if (c.child || c.frameId !== st.mainFrameId) throw new ToolError(OTHER_FRAME)
      if (c.mode === 'selectSingle' && n > 1) throw oneFile()
      const node = await cdp<any>(st.target, 'DOM.resolveNode', { backendNodeId: c.backendNodeId, executionContextId: await world(st) }).catch(() => null)
      if (!node?.object?.objectId) return "the file picker's field was gone"
      return put(node.object.objectId)
    } finally {
      clearTimeout(timer)
      st.chooser = undefined
    }
  }
  await samePage()
  const contextId = await world(st)
  const r = await cdp<any>(st.target, 'Runtime.callFunctionOn', { executionContextId: contextId, functionDeclaration: DROP_FILES, arguments: [{ value: files }, { value: p.x }, { value: p.y }], returnByValue: true }).catch(() => null)
  return r?.result?.value === 'ok' ? true : 'the drop target was gone'
}
