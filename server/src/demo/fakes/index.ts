// The demo's fake services (docs/decisions/20261119-demo-fakes.md): on a demo server whose demo file asks for them
// (DemoFile.fakes), Gmail, Google Drive and Higgsfield are answered in this process from fake data, and every other
// call to the outside is refused before a name lookup or a socket (offline.ts). Nothing a visitor does leaves the
// machine: a mail they send is stored and answered "sent", a picture they generate is a canned one.
//
// Where each fake plugs in (the product's own code paths stay in use above them, cards included):
//   - Gmail: integrations/google-apps/library.ts workspaceLibraryOf (ready, no Python program) and transport.ts
//     libraryRequest (the library's MCP calls); google-apps/tokens.ts refreshGoogleApp (answered here, never expires)
//   - Google's token, revoke and userinfo addresses and Drive v3: google-drive/client.ts GoogleTransport
//   - Higgsfield: connections/net.ts NetOptions.answer (set by connections/service.ts) and tools/download.ts
//   - the banner maker (banners.ts): no service at all, the server's own change_banner_text (tools/demo-banner.ts)
//
// One server process serves one demo instance, so the fakes are one per process (the active one), kept per context for
// the code that has a context, and gone when the context closes.
//   <content>/gmail.json      the mailbox (gmail.ts GmailContent; default: a built-in fictional one)
//   <content>/drive.json      the Drive file tree and texts (drive.ts DriveContent)
//   <content>/higgsfield/     canned pictures, picked by the words of their file names
//   <content>/higgsfield/banner/   the banner kit change_banner_text draws from (banner.ts)
//   <dataDir>/demo-fakes/state.json   what the visitor sent, drafted, labelled and generated (state.ts)
//   <dataDir>/demo-fakes/banners/     the banners change_banner_text drew
import path from 'node:path'
import type { AppContext } from '../../context'
import { setDemoGoogleFetch } from '../../integrations/google-drive/client'
import type { NetRequest } from '../../integrations/connections/net'
import type { LibraryState, WorkspaceLibrary } from '../../integrations/google-apps/library'
import { FakeGmail, loadGmail } from './gmail'
import { FakeGoogleDrive, loadDrive } from './drive'
import { FakeHiggsfield, HIGGSFIELD_HOSTS, loadPictures } from './higgsfield'
import { loadBannerKit } from './banner'
import { DemoBanners } from './banners'
import { FakeState } from './state'
import { installOfflineGuard } from './offline'

export { DEMO_OFFLINE_TEXT, DemoOffline, demoOffline, isLoopbackHost } from './offline'

/** the address the fake library says it has: never connected to (transport.ts answers it from the fake first) */
export const FAKE_LIBRARY_URL = 'http://127.0.0.1:9/mcp'

export interface DemoFakesOptions {
  dataDir: string
  /** the content folder (gmail.json, drive.json, higgsfield/), or null for the built-in data */
  content: string | null
  warn?: (m: string) => void
}

/** A net.ts answer (status, headers, body), or null when no fake answers that address. */
export type NetAnswer = { status: number; headers?: Record<string, string>; body?: string | Buffer }

export class DemoFakes {
  readonly state: FakeState
  readonly gmail: FakeGmail
  readonly google: FakeGoogleDrive
  readonly higgsfield: FakeHiggsfield
  /** the banner maker (change_banner_text): local, never a Higgsfield tool */
  readonly banners: DemoBanners
  /** the Google Workspace library as the Gmail fake: always ready */
  readonly library: WorkspaceLibrary = {
    state: (): LibraryState => 'ready',
    want: () => {},
    endpoint: () => FAKE_LIBRARY_URL,
    whenReady: async () => true,
    close: async () => {},
  }
  constructor(o: DemoFakesOptions) {
    const warn = o.warn ?? (() => {})
    this.state = new FakeState(o.dataDir, warn)
    this.gmail = new FakeGmail(loadGmail(o.content, warn), this.state)
    this.google = new FakeGoogleDrive(loadDrive(o.content, warn))
    const kit = loadBannerKit(o.content, warn)
    this.higgsfield = new FakeHiggsfield(loadPictures(o.content, kit), this.state, kit?.lang)
    this.banners = new DemoBanners(this.state, kit)
  }

  /** connections/net.ts NetOptions.answer: a Higgsfield address, else null (then refused: the fence is on) */
  net = async (url: string, r: NetRequest): Promise<NetAnswer | null> => {
    let u: URL
    try { u = new URL(url) } catch { return null }
    if (HIGGSFIELD_HOSTS.has(u.hostname)) return this.higgsfield.answer(u, r)
    return null
  }

  /** tools/download.ts: a file only a fake has (a generated picture), or null */
  download(url: string): { bytes: Buffer; contentType: string } | null {
    return this.higgsfield.download(url)
  }
}

let active: { fakes: DemoFakes; off: () => void } | null = null
/** the fakes of this process's demo server, or null (not a demo server with fakes) */
export const activeDemoFakes = (): DemoFakes | null => active?.fakes ?? null

/** Turn fakes on for this process (the fence included). One at a time: a second one replaces the first. */
export function activateDemoFakes(o: DemoFakesOptions): DemoFakes {
  deactivateDemoFakes()
  const fakes = new DemoFakes(o)
  const unguard = installOfflineGuard()
  setDemoGoogleFetch(fakes.google.fetch)
  active = { fakes, off: () => { setDemoGoogleFetch(null); unguard() } }
  return fakes
}
export function deactivateDemoFakes() {
  if (!active) return
  const a = active
  active = null
  a.off()
}

const instances = new WeakMap<AppContext, DemoFakes>()
/**
 * The demo fakes of this server, made and turned on the first time they are asked for; null when the demo file does
 * not ask for them (every server that is not such a demo). main.ts asks once at the start, before anything goes out.
 */
export function demoFakesOf(ctx: AppContext): DemoFakes | null {
  const want = ctx.config.demo?.fakes
  if (!want) return null
  let f = instances.get(ctx)
  if (!f) {
    const content = want.content ? path.resolve(want.content) : null
    f = activateDemoFakes({ dataDir: ctx.config.dataDir, content, warn: (m) => ctx.log.warn(m) })
    instances.set(ctx, f)
    const mine = f
    ctx.onClose(() => { if (activeDemoFakes() === mine) deactivateDemoFakes() })
    ctx.log.info('demo fakes on: Gmail, Google Drive and Higgsfield answer here; every other outside call is refused', { content: content ? 'folder' : 'built-in' })
  }
  return f
}
