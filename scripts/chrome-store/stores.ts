// Upload and publish the extension zip to the Chrome Web Store (API v2) and Microsoft Edge Add-ons (API v1.1), for
// .github/workflows/chrome-extension.yml (docs/RELEASE-CI.md "Chrome extension releases"). Neither store can create an
// item over its API: the first version is uploaded by hand in its dashboard, and publishing keeps the visibility set
// there (public, unlisted, private).
//
//   bun scripts/chrome-store/stores.ts chrome <zip> <version> [--staged] [--upload-only]
//     env: CWS_PUBLISHER_ID, CWS_ITEM_ID, and either CWS_ACCESS_TOKEN (a service account's token, from Workload
//     Identity Federation) or CWS_CLIENT_ID + CWS_CLIENT_SECRET + CWS_REFRESH_TOKEN (an OAuth client of the publisher's
//     Google account). --staged: after review it waits for "Publish" in the dashboard.
//   bun scripts/chrome-store/stores.ts edge <zip> <version> [--upload-only]
//     env: EDGE_PRODUCT_ID, EDGE_CLIENT_ID, EDGE_API_KEY (Partner Center › Microsoft Edge › Publish API)
//
// Never prints a token or a key; a store's error body is printed as it came (they hold neither).
import { readFileSync } from 'node:fs'

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>
type Log = (line: string) => void
interface Opts { fetch?: Fetch; log?: Log; sleep?: (ms: number) => Promise<void>; pollMs?: number; maxPolls?: number }

export const CWS_API = 'https://chromewebstore.googleapis.com'
export const CWS_SCOPE = 'https://www.googleapis.com/auth/chromewebstore'
export const EDGE_API = 'https://api.addons.microsoftedge.microsoft.com'
const ITEM_ID = /^[a-p]{32}$/
const PUBLISHER_ID = /^[A-Za-z0-9_-]{1,100}$/

async function body(r: Response): Promise<string> {
  try { return (await r.text()).slice(0, 2000) } catch { return '' }
}

async function json<T>(r: Response, what: string): Promise<T> {
  if (!r.ok) throw new Error(`${what}: HTTP ${r.status} ${await body(r)}`)
  return (await r.json()) as T
}

/** An access token from an OAuth client's refresh token (the publisher's own Google account). */
export async function cwsTokenFromRefresh(env: Record<string, string | undefined>, f: Fetch = fetch): Promise<string> {
  const { CWS_CLIENT_ID: id, CWS_CLIENT_SECRET: secret, CWS_REFRESH_TOKEN: refresh } = env
  if (!id || !secret || !refresh) throw new Error('no Chrome Web Store credentials: set CWS_ACCESS_TOKEN, or CWS_CLIENT_ID + CWS_CLIENT_SECRET + CWS_REFRESH_TOKEN')
  const r = await f('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: id, client_secret: secret, refresh_token: refresh, grant_type: 'refresh_token' }).toString(),
  })
  // the body of a failed exchange names the error (invalid_grant: the refresh token expired or was revoked), never a secret
  const j = await json<{ access_token?: string }>(r, 'Google token exchange')
  if (!j.access_token) throw new Error('Google token exchange: no access_token in the answer')
  return j.access_token
}

interface CwsStatus {
  lastAsyncUploadState?: string
  publishedItemRevisionStatus?: { state?: string; distributionChannels?: { crxVersion?: string; deployPercentage?: number }[] }
  submittedItemRevisionStatus?: { state?: string; distributionChannels?: { crxVersion?: string }[] }
  takenDown?: boolean
}
const versionsOf = (s?: { distributionChannels?: { crxVersion?: string }[] }) => (s?.distributionChannels ?? []).map((c) => c.crxVersion).filter((v): v is string => !!v)

/** Upload `zip` as `version` and submit it for review (published when approved, or staged). */
export async function publishChrome(o: { publisher: string; item: string; token: string; zip: Uint8Array; version: string; staged?: boolean; uploadOnly?: boolean }, x: Opts = {}): Promise<{ state: string }> {
  const f = x.fetch ?? fetch, log = x.log ?? console.log, sleep = x.sleep ?? Bun.sleep
  if (!PUBLISHER_ID.test(o.publisher)) throw new Error('CWS_PUBLISHER_ID is missing or not an id (Developer Dashboard › Account › Publisher ID)')
  if (!ITEM_ID.test(o.item)) throw new Error('CWS_ITEM_ID is not an item id (32 letters a–p)')
  const name = `publishers/${o.publisher}/items/${o.item}`
  const auth = { authorization: `Bearer ${o.token}` }
  const status = async () => json<CwsStatus>(await f(`${CWS_API}/v2/${name}:fetchStatus`, { headers: auth }), 'Chrome Web Store status')

  const before = await status()
  const published = versionsOf(before.publishedItemRevisionStatus), submitted = versionsOf(before.submittedItemRevisionStatus)
  log(`Chrome Web Store: published ${published.join(', ') || 'none'} (${before.publishedItemRevisionStatus?.state ?? '-'}); in review ${submitted.join(', ') || 'none'} (${before.submittedItemRevisionStatus?.state ?? '-'})`)
  if (published.includes(o.version) || submitted.includes(o.version)) {
    log(`${o.version} is in the store already: nothing to upload (a run again of a published tag)`)
    return { state: 'ALREADY_THERE' }
  }
  if (submitted.length) log(`::warning::${submitted.join(', ')} is still in review: the store may refuse a new upload until that review ends or is cancelled (Developer Dashboard › the item › Cancel review)`)

  const up = await f(`${CWS_API}/upload/v2/${name}:upload`, { method: 'POST', headers: { ...auth, 'content-type': 'application/zip' }, body: o.zip as unknown as BodyInit })
  const u = await json<{ uploadState?: string; crxVersion?: string }>(up, 'Chrome Web Store upload')
  let state = u.uploadState ?? 'UPLOAD_STATE_UNSPECIFIED'
  for (let i = 0; /IN_PROGRESS/.test(state); i++) {
    if (i >= (x.maxPolls ?? 60)) throw new Error('Chrome Web Store upload still in progress after 10 minutes; see the dashboard')
    await sleep(x.pollMs ?? 10_000)
    state = (await status()).lastAsyncUploadState ?? state
  }
  if (state !== 'SUCCEEDED') throw new Error(`Chrome Web Store upload: ${state} ${JSON.stringify(u).slice(0, 1000)}`)
  if (u.crxVersion && u.crxVersion !== o.version) throw new Error(`Chrome Web Store took version ${u.crxVersion}, the tag is ${o.version}`)
  log(`uploaded ${o.version}`)
  if (o.uploadOnly) { log('upload only: submit it in the dashboard (Package › Submit for review)'); return { state: 'UPLOADED' } }

  const pub = await f(`${CWS_API}/v2/${name}:publish`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    // no deployInfos: the dashboard's rollout; visibility is always the dashboard's
    body: JSON.stringify({ publishType: o.staged ? 'STAGED_PUBLISH' : 'DEFAULT_PUBLISH' }),
  })
  const p = await json<{ state?: string; warningInfo?: unknown }>(pub, 'Chrome Web Store publish')
  if (p.warningInfo) log(`warnings: ${JSON.stringify(p.warningInfo).slice(0, 1000)}`)
  log(`submitted ${o.version}: ${p.state ?? 'unknown state'}${o.staged ? ' (staged: press Publish in the dashboard after review)' : ' (published when the review passes)'}`)
  return { state: p.state ?? 'unknown' }
}

interface EdgeOp { status?: string; message?: string; errorCode?: string | null; errors?: unknown }

async function edgeWait(f: Fetch, url: string, headers: Record<string, string>, what: string, x: Opts): Promise<EdgeOp> {
  const sleep = x.sleep ?? Bun.sleep
  for (let i = 0; ; i++) {
    const r = await f(url, { headers })
    if (!r.ok && r.status !== 202) throw new Error(`${what}: HTTP ${r.status} ${await body(r)}`)
    const op = (await r.json()) as EdgeOp
    if (op.status === 'Succeeded') return op
    if (op.status === 'Failed') throw new Error(`${what}: ${op.errorCode ?? 'Failed'} ${op.message ?? ''} ${JSON.stringify(op.errors ?? []).slice(0, 1000)}`)
    if (i >= (x.maxPolls ?? 60)) throw new Error(`${what}: still ${op.status ?? 'in progress'} after 10 minutes; see Partner Center`)
    await sleep(x.pollMs ?? 10_000)
  }
}

/** Upload `zip` as the draft's package and submit it for certification. */
export async function publishEdge(o: { product: string; clientId: string; apiKey: string; zip: Uint8Array; version: string; uploadOnly?: boolean }, x: Opts = {}): Promise<{ state: string }> {
  const f = x.fetch ?? fetch, log = x.log ?? console.log
  if (!/^[0-9a-f-]{36}$/i.test(o.product)) throw new Error('EDGE_PRODUCT_ID is not a product id (Partner Center › Extension identity)')
  if (!o.clientId || !o.apiKey) throw new Error('no Edge Add-ons credentials: set EDGE_CLIENT_ID and EDGE_API_KEY')
  const headers = { authorization: `ApiKey ${o.apiKey}`, 'x-clientid': o.clientId }
  const base = `${EDGE_API}/v1/products/${o.product}/submissions`
  const up = await f(`${base}/draft/package`, { method: 'POST', headers: { ...headers, 'content-type': 'application/zip' }, body: o.zip as unknown as BodyInit })
  if (up.status !== 202) throw new Error(`Edge Add-ons upload: HTTP ${up.status} ${await body(up)}`)
  const upOp = up.headers.get('location')
  if (!upOp) throw new Error('Edge Add-ons upload: no operation id (Location)')
  await edgeWait(f, `${base}/draft/package/operations/${encodeURIComponent(upOp)}`, headers, 'Edge Add-ons upload', x)
  log(`Edge Add-ons: uploaded ${o.version}`)
  if (o.uploadOnly) { log('upload only: publish the draft in Partner Center'); return { state: 'UPLOADED' } }
  const pub = await f(base, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ notes: `Version ${o.version}. The same package as the Chrome Web Store item.` }) })
  if (pub.status !== 202) throw new Error(`Edge Add-ons publish: HTTP ${pub.status} ${await body(pub)}`)
  const pubOp = pub.headers.get('location')
  if (!pubOp) throw new Error('Edge Add-ons publish: no operation id (Location)')
  const op = await edgeWait(f, `${base}/operations/${encodeURIComponent(pubOp)}`, headers, 'Edge Add-ons publish', x)
  log(`Edge Add-ons: submitted ${o.version} for certification (${op.message ?? 'ok'})`)
  return { state: 'SUBMITTED' }
}

if (import.meta.main) {
  const [store, zipPath, version, ...flags] = process.argv.slice(2)
  if ((store !== 'chrome' && store !== 'edge') || !zipPath || !version) {
    console.error('usage: bun scripts/chrome-store/stores.ts chrome|edge <zip> <version> [--staged] [--upload-only]')
    process.exit(2)
  }
  const env = process.env
  const zip = new Uint8Array(readFileSync(zipPath))
  const uploadOnly = flags.includes('--upload-only')
  try {
    if (store === 'chrome') {
      const token = env.CWS_ACCESS_TOKEN || (await cwsTokenFromRefresh(env))
      await publishChrome({ publisher: env.CWS_PUBLISHER_ID ?? '', item: env.CWS_ITEM_ID ?? '', token, zip, version, staged: flags.includes('--staged'), uploadOnly })
    } else {
      await publishEdge({ product: env.EDGE_PRODUCT_ID ?? '', clientId: env.EDGE_CLIENT_ID ?? '', apiKey: env.EDGE_API_KEY ?? '', zip, version, uploadOnly })
    }
  } catch (e) {
    console.error(`::error::${(e as Error).message}`)
    process.exit(1)
  }
}
