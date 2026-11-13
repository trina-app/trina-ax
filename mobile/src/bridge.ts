import { PhotoPicks, PhotoRefused } from './photos'
import { APPEARANCE_CAPABILITY, BADGE_CAPABILITY, CHANGE_TEAM_CAPABILITY, base64Size, MAX_FILE_BYTES, NAV_CAPABILITY, parseMessage, PHOTO_PICK_CAPABILITY, PUSH_CAPABILITY, PUSH_LABEL_CAPABILITY, PUSH_PERMISSION_CAPABILITY, PUSH_REGISTERED_CAPABILITY, pushPermission, sameTeam, SHARE_TEXT_CAPABILITY, TRANSFER_IDLE_MS, validPicks, validPushToken, type FileMessage, type MobileConfig, type MobileReply, type PushPermission, type PushToken } from './protocol'
export interface TransferIO {
  create(id: string, name: string, mime: string): Promise<void>
  append(id: string, b64: string): Promise<void>
  inspect(id: string): Promise<{ size: number; sha256: string }>
  share(id: string): Promise<void>
  remove(id: string): Promise<void>
}
interface Transfer { id: string; generation: number; nonce: string; size: number; hash: string; bytes: number; seq: number; queued: number; ended: boolean; cancelled: boolean; queue: Promise<void>; timer: ReturnType<typeof setTimeout> | null }
/** One transfer, bounded reservations and a queue that awaits every native write. Cancellation fences pending work
 * immediately; deletion runs after the in-flight write settles, so a late write cannot recreate a removed cache. */
export class FileTransfers {
  private active: Transfer | null = null
  private used = new Set<string>()
  constructor(private io: TransferIO, private timeout = TRANSFER_IDLE_MS) {}
  private touch(t: Transfer) {
    if (t.timer) clearTimeout(t.timer)
    t.timer = setTimeout(() => { void this.cancel(t) }, this.timeout)
  }
  private async cancel(t: Transfer) {
    t.cancelled = true
    if (t.timer) clearTimeout(t.timer)
    if (this.active === t) this.active = null
    await t.queue.catch(() => {})
    await this.io.remove(t.id).catch(() => {})
  }
  private enqueue(t: Transfer, action: () => Promise<void>): Promise<void> {
    t.queued++
    const pending = t.queue.then(async () => {
      if (t.cancelled || this.active !== t) throw new Error('transfer_cancelled')
      await action()
      if (t.cancelled) throw new Error('transfer_cancelled')
    }).catch(async () => {
      t.cancelled = true
      if (t.timer) clearTimeout(t.timer)
      if (this.active === t) this.active = null
      await this.io.remove(t.id).catch(() => {})
      throw new Error('transfer_failed')
    }).finally(() => { t.queued-- })
    t.queue = pending.catch(() => {})
    return pending
  }
  async receive(m: FileMessage): Promise<void> {
    // Also validate direct callers, not only the WebView controller.
    if (!parseMessage(JSON.stringify(m))) throw new Error('invalid_message')
    if (m.type === 'file-begin') {
      if (this.active || this.used.has(m.id) || this.used.size >= 200) throw new Error('transfer_busy')
      this.used.add(m.id)
      const t: Transfer = { id: m.id, generation: m.generation, nonce: m.nonce, size: m.size, hash: m.sha256, bytes: 0, seq: 0, queued: 0, ended: false, cancelled: false, queue: Promise.resolve(), timer: null }
      this.active = t; this.touch(t)
      return this.enqueue(t, () => this.io.create(m.id, m.name, m.mime))
    }
    const t = this.active
    if (!t || m.id !== t.id || m.generation !== t.generation || m.nonce !== t.nonce) throw new Error('transfer_missing')
    if (m.type === 'file-abort') { await this.cancel(t); return }
    if (t.ended || t.queued >= 4 || m.seq !== t.seq) { await this.cancel(t); throw new Error('transfer_sequence') }
    this.touch(t)
    if (m.type === 'file-chunk') {
      const bytes = base64Size(m.b64)!
      if (t.bytes + bytes > t.size || t.bytes + bytes > MAX_FILE_BYTES) { await this.cancel(t); throw new Error('transfer_size') }
      t.seq++; t.bytes += bytes
      return this.enqueue(t, () => this.io.append(t.id, m.b64))
    }
    t.ended = true
    return this.enqueue(t, async () => {
      if (t.bytes !== t.size) throw new Error('transfer_size')
      const actual = await this.io.inspect(t.id)
      if (t.cancelled || this.active !== t || actual.size !== t.size || actual.sha256 !== t.hash) throw new Error('transfer_integrity')
      if (t.timer) clearTimeout(t.timer)
      await this.io.share(t.id)
      await this.io.remove(t.id)
      if (this.active === t) this.active = null
    })
  }
  async clear(): Promise<void> {
    const t = this.active
    if (t) await this.cancel(t)
    this.used.clear()
  }
}

/** Android: a same-document navigation reported as loading gets no load end, and the bridge would stay off. After
 * `ms` the app installs it again, but only on the page that was loading then: the top-level URL on screen is still that
 * one and on the team's origin, and that page is neither ready nor failed. Cancelled on every load start, on load end,
 * on the failure screen and when the team page goes away. */
export class StuckLoad {
  private timer: ReturnType<typeof setTimeout> | null = null
  constructor(private ms: number, private set: typeof setTimeout = setTimeout, private unset: typeof clearTimeout = clearTimeout) {}
  arm(url: string, still: (url: string) => boolean, reinstall: (url: string) => void) {
    this.cancel()
    this.timer = this.set(() => { this.timer = null; if (still(url)) reinstall(url) }, this.ms)
  }
  cancel() { if (this.timer) this.unset(this.timer); this.timer = null }
  get armed() { return this.timer !== null }
}
export const stillStuck = (o: { saved: string; current: string; origin: string; ready: boolean; failed: boolean }) =>
  o.current === o.saved && sameTeam(o.origin, o.current) && !o.ready && !o.failed

/** Whether a load start fences the bridge (a new document). Android reports every same-document navigation as a load
 * start (react-native-webview's doUpdateVisitedHistory), some of them as loading: those fenced it before, and a step
 * back to the same address while the photo picker was up or its bytes came over (the attach sheet's history entry
 * closing) dropped the pick (QA TC-251). Now, on Android, a load start that is not loading, or one at the address
 * already on screen while a pick is on, is the same document: no fence. Should it have been a new document after all,
 * its load end finds no bridge there and installs it (sameDocumentScript). iOS starts (a navigation policy) come only
 * for new documents; iOS load ENDS do not: see sameDocumentScript. */
export const loadStartFences = (o: { android: boolean; loading: boolean; sameUrl: boolean; picking: boolean }) =>
  !o.android || (o.loading && !(o.sameUrl && o.picking))

/** A load end while the bridge is on: is the page still the document that has it? react-native-webview 14 on iOS
 * injects a history shim that reports every pushState, replaceState and popstate of the page as a load end (with a
 * navigationType), and Android may end a step within the page too. Installing the bridge again for those gave the page
 * a new nonce and its mycel:mobile-ready, which cancelled whatever was on its way: on iOS the attach sheet's history
 * step during the photo picker dropped every pick (QA TC-251). So the app asks the page about its document id, a
 * random id that is not the nonce (documentScript, set with the bridge): the document with that id says nothing (the
 * same document, nothing to do); any other (a new document) answers with `{ mycelNewDocument: id }` (readNewDocument),
 * and the app fences and installs the bridge there. The question never carries the nonce: a new document that hooks
 * postMessage or stays silent learns only the id, which opens nothing, and it cannot answer for the old bridge. */
export const DOCUMENT_ID = /^[0-9a-f]{32}$/
/** A new document id (16 random bytes as hex) for documentScript. */
export const documentId = (random: Uint8Array) => Array.from(random.subarray(0, 16), b => b.toString(16).padStart(2, '0')).join('')
/** Sets the document id on the page (with the bridge: App bootstrap). */
export function documentScript(id: string): string {
  if (!DOCUMENT_ID.test(id)) throw new Error('document_id')
  return `Object.defineProperty(window,'mycelDocument',{value:'${id}',configurable:true});`
}
/** The question for a load end: only a document without this id answers. No JSON.stringify of the page's is used. */
export function sameDocumentScript(id: string): string {
  if (!DOCUMENT_ID.test(id)) throw new Error('document_id')
  return `if(window.top===window.self&&window.mycelDocument!=='${id}'&&window.ReactNativeWebView){window.ReactNativeWebView.postMessage('{"mycelNewDocument":"${id}"}')}true;`
}
/** The page's answer to sameDocumentScript for `id`: a new document. Anything else: false. */
export function readNewDocument(data: string, id: string): boolean {
  if (!DOCUMENT_ID.test(id) || data.length > 200 || !data.includes('mycelNewDocument')) return false
  try { const v = JSON.parse(data) as { mycelNewDocument?: unknown }; return !!v && typeof v === 'object' && v.mycelNewDocument === id } catch { return false }
}

/** The script that hands a reply to the page. Delivered only if the document on screen still has the bridge the reply
 * answers (its nonce): a document that came in the meantime has none yet or its own, and drops it, so no file bytes
 * (photo-pick-v1) or token reach the next page. `bootstrap`: the next config, installed first (a session reset's). */
export function replyScript(reply: MobileReply, bootstrap = ''): string {
  return `if(window.top===window.self&&window.mycelMobile&&window.mycelMobile.nonce===${JSON.stringify(reply.nonce)}){${bootstrap}window.dispatchEvent(new CustomEvent('mycel:mobile',{detail:${JSON.stringify(reply)}}));}true;`
}

/** True at most once per `ms`: open-settings, so a page cannot keep sending the person to the phone's Settings. */
export function onceEvery(ms: number, now: () => number = Date.now): () => boolean {
  let last = -Infinity
  return () => { const t = now(); if (t - last < ms) return false; last = t; return true }
}

/** The only push failures the web page learns: the person said no, or this build/device cannot receive push. */
export class PushRefused extends Error { constructor(readonly code: 'push_denied' | 'push_unavailable') { super(code) } }
/** token: ask the OS (permission prompt) for the device token; registered: the page registered it with its team;
 * permission: what the OS says so far, never a prompt; openSettings: this app's page in the phone's Settings; labelHash
 * (push-label-v1): the hash of the label key the notification extension asks this team with; signedOut: no one is
 * signed in any more (notifications on screen and the label key go, before the reset is answered); badge (badge-v1):
 * the app icon's number. */
export interface PushBridge {
  token(): Promise<PushToken>; registered(device: { deviceId: string; removeKey: string }): Promise<void>
  permission?(): Promise<PushPermission>; openSettings?(): Promise<void>
  labelHash?(): Promise<string | null>; signedOut?(): Promise<void>; badge?(count: number): Promise<void>
}

/** Where Back goes in the page on screen (nav-v1): `home` is true unless the page said it is on another tab. */
export interface PageNav { canGoBack: boolean; home: boolean }
/** Native side: source URL plus a top-frame-only capability nonce bind requests to this WebView document. `share`
 * (share-text-v1): the phone's share sheet with a text, answered once the sheet is up or closed. `photos`
 * (photo-pick-v1): the phone's photo picker and the picked files' bytes, fenced with the file transfers. */
export class MobileReceiver {
  private enabled = true
  constructor(readonly origin: string, public config: MobileConfig, private files: FileTransfers, private external: (url: string) => Promise<void>, private push?: PushBridge, private appearance?: (look: { dark: boolean; system: boolean }) => void, private nav?: (nav: PageNav) => void, private share?: (text: string) => Promise<void>, private photos?: PhotoPicks, private changeTeam?: () => void) {}
  private changeTeamOnce = onceEvery(3000)
  private async fence() { await this.files.clear(); await this.photos?.clear() }
  /** The bridge is on and a photo pick is under way (the picker on screen, or its bytes not all fetched yet). */
  get picking(): boolean { return this.enabled && !!this.photos?.busy }
  async disable() { this.enabled = false; this.config = { ...this.config, generation: this.config.generation + 1 }; await this.fence() }
  activate(config: MobileConfig) { this.config = config; this.enabled = true }
  async receive(raw: string, sourceUrl: string): Promise<MobileReply | null> {
    if (!this.enabled || !sameTeam(this.origin, sourceUrl)) return null
    const m = parseMessage(raw), current = this.config
    if (!m || m.generation !== current.generation || m.nonce !== current.nonce) return null
    const reply: MobileReply = { v: 1, type: 'mobile-result', id: m.id, nonce: m.nonce, generation: m.generation, for: m.type, ok: true, ...('seq' in m ? { seq: m.seq } : {}) }
    if (m.type === 'session-reset') {
      // Fence old work synchronously, before the first await.
      this.config = { ...current, generation: current.generation + 1 }
      // the session ended: names must not stay on the lock screen, and the extension must not ask for more; done before
      // the answer, so the next sign-in's key is never deleted by this
      if (m.signedOut === true) await this.push?.signedOut?.().catch(() => {})
      await this.fence()
      return this.enabled && this.config.nonce === current.nonce ? { ...reply, nextGeneration: this.config.generation } : null
    }
    try {
      if (m.type === 'external-open') await this.external(m.url)
      else if (m.type === 'push-token') {
        // Same origin/nonce/generation checks as files; the token goes only to the document that asked.
        if (!this.push || !current.capabilities.includes(PUSH_CAPABILITY)) throw new PushRefused('push_unavailable')
        const token = await this.push.token()
        if (!validPushToken(token)) throw new PushRefused('push_unavailable')
        reply.push = { platform: token.platform, token: token.token, environment: token.environment }
        // push-label-v1: the page registers the label key's hash with the token (the key stays in the keychain)
        if (token.platform === 'ios' && this.push.labelHash && current.capabilities.includes(PUSH_LABEL_CAPABILITY)) {
          const labelHash = await this.push.labelHash().catch(() => null)
          if (labelHash && /^[0-9a-f]{64}$/.test(labelHash)) reply.labelHash = labelHash
        }
      } else if (m.type === 'push-registered') {
        if (!this.push || !current.capabilities.includes(PUSH_REGISTERED_CAPABILITY)) throw new PushRefused('push_unavailable')
        await this.push.registered({ deviceId: m.deviceId, removeKey: m.removeKey })
      } else if (m.type === 'push-permission' || m.type === 'open-settings') {
        if (!this.push?.permission || !this.push.openSettings || !current.capabilities.includes(PUSH_PERMISSION_CAPABILITY)) throw new PushRefused('push_unavailable')
        if (m.type === 'open-settings') await this.push.openSettings()
        else {
          const permission = await this.push.permission()
          if (!pushPermission(permission)) throw new PushRefused('push_unavailable')
          reply.permission = permission
        }
      } else if (m.type === 'badge') {
        if (!this.push?.badge || !current.capabilities.includes(BADGE_CAPABILITY)) throw new Error('unsupported')
        await this.push.badge(m.count)
      } else if (m.type === 'appearance') {
        if (!this.appearance || !current.capabilities.includes(APPEARANCE_CAPABILITY)) throw new Error('unsupported')
        this.appearance({ dark: m.dark, system: m.system === true })
      } else if (m.type === 'nav') {
        if (!this.nav || !current.capabilities.includes(NAV_CAPABILITY)) throw new Error('unsupported')
        this.nav({ canGoBack: m.canGoBack, home: m.home !== false })
      } else if (m.type === 'change-team') {
        // the app's own screen, at most once a few seconds (a page cannot keep covering itself with it)
        if (!this.changeTeam || !current.capabilities.includes(CHANGE_TEAM_CAPABILITY) || !this.changeTeamOnce()) throw new Error('unsupported')
        this.changeTeam()
      } else if (m.type === 'share-text') {
        if (!this.share || !current.capabilities.includes(SHARE_TEXT_CAPABILITY)) throw new Error('unsupported')
        await this.share(m.text)
      } else if (m.type === 'photo-pick' || m.type === 'photo-chunk' || m.type === 'photo-done') {
        if (!this.photos || !current.capabilities.includes(PHOTO_PICK_CAPABILITY)) throw new Error('unsupported')
        const owner = { id: m.id, generation: m.generation, nonce: m.nonce }
        if (m.type === 'photo-pick') {
          const picks = await this.photos.pick({ ...owner, limit: m.limit })
          // the page checks the same again (web/src/lib/mobile.ts)
          if (!validPicks(picks.files, picks.tooBig, m.limit)) { await this.photos.done(owner).catch(() => {}); throw new Error('photo_invalid') }
          reply.files = picks.files; reply.tooBig = picks.tooBig
        } else if (m.type === 'photo-chunk') reply.b64 = await this.photos.chunk({ ...owner, seq: m.seq, index: m.index, offset: m.offset })
        else await this.photos.done(owner)
      } else await this.files.receive(m)
    } catch (error) { reply.ok = false; reply.error = error instanceof PushRefused || error instanceof PhotoRefused ? error.code : 'mobile_operation_failed' }
    return this.enabled && this.config === current ? reply : null
  }
}
