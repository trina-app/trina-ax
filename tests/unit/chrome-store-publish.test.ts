// The store uploads of the Chrome extension release (scripts/chrome-store/stores.ts, .github/workflows/chrome-extension.yml):
// the Chrome Web Store API v2 calls in order, a version already there is not uploaded again, an upload in progress is
// waited for, a failed one stops before publish; Edge Add-ons' operations. No network: a recorded fetch.
import { describe, expect, test } from 'bun:test'
import { CWS_API, cwsTokenFromRefresh, EDGE_API, publishChrome, publishEdge, type Fetch } from '../../scripts/chrome-store/stores'

type Call = { url: string; method: string; headers: Record<string, string>; body?: string }
function fake(answers: ((c: Call) => Response | undefined)[]): { f: Fetch; calls: Call[] } {
  const calls: Call[] = []
  const f: Fetch = async (url, init) => {
    const c: Call = { url, method: init?.method ?? 'GET', headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)), body: typeof init?.body === 'string' ? init.body : undefined }
    calls.push(c)
    for (const a of answers) { const r = a(c); if (r) return r }
    return new Response('unexpected', { status: 500 })
  }
  return { f, calls }
}
const ok = (j: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(j), { status, headers: { 'content-type': 'application/json', ...headers } })
const ITEM = 'pfalalpmbomdafcmobbjlgekhdfjepmc'
const base = { publisher: 'pub-1', item: ITEM, token: 'tok', zip: new Uint8Array([80, 75]), version: '0.2.0' }
const quiet = { log: () => {}, sleep: async () => {} }

describe('Chrome Web Store', () => {
  test('status, upload, publish (DEFAULT_PUBLISH, no visibility or rollout of its own)', async () => {
    const { f, calls } = fake([
      (c) => c.url.endsWith(':fetchStatus') ? ok({ publishedItemRevisionStatus: { state: 'PUBLISHED', distributionChannels: [{ crxVersion: '0.1.0' }] } }) : undefined,
      (c) => c.url.endsWith(':upload') ? ok({ uploadState: 'SUCCEEDED', crxVersion: '0.2.0' }) : undefined,
      (c) => c.url.endsWith(':publish') ? ok({ state: 'PENDING_REVIEW' }) : undefined,
    ])
    expect(await publishChrome(base, { ...quiet, fetch: f })).toEqual({ state: 'PENDING_REVIEW' })
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${CWS_API}/v2/publishers/pub-1/items/${ITEM}:fetchStatus`,
      `POST ${CWS_API}/upload/v2/publishers/pub-1/items/${ITEM}:upload`,
      `POST ${CWS_API}/v2/publishers/pub-1/items/${ITEM}:publish`,
    ])
    expect(calls.every((c) => c.headers.authorization === 'Bearer tok')).toBe(true)
    expect(JSON.parse(calls[2]!.body!)).toEqual({ publishType: 'DEFAULT_PUBLISH' })
  })

  test('staged; upload only stops before publish', async () => {
    const answers = [
      (c: Call) => c.url.endsWith(':fetchStatus') ? ok({}) : undefined,
      (c: Call) => c.url.endsWith(':upload') ? ok({ uploadState: 'SUCCEEDED' }) : undefined,
      (c: Call) => c.url.endsWith(':publish') ? ok({ state: 'STAGED' }) : undefined,
    ]
    const a = fake(answers)
    await publishChrome({ ...base, staged: true }, { ...quiet, fetch: a.f })
    expect(JSON.parse(a.calls.at(-1)!.body!)).toEqual({ publishType: 'STAGED_PUBLISH' })
    const b = fake(answers)
    expect(await publishChrome({ ...base, uploadOnly: true }, { ...quiet, fetch: b.f })).toEqual({ state: 'UPLOADED' })
    expect(b.calls.some((c) => c.url.endsWith(':publish'))).toBe(false)
  })

  test('a version already published or in review is not uploaded again', async () => {
    const { f, calls } = fake([(c) => c.url.endsWith(':fetchStatus') ? ok({ submittedItemRevisionStatus: { state: 'PENDING_REVIEW', distributionChannels: [{ crxVersion: '0.2.0' }] } }) : undefined])
    expect(await publishChrome(base, { ...quiet, fetch: f })).toEqual({ state: 'ALREADY_THERE' })
    expect(calls).toHaveLength(1)
  })

  test('an upload in progress is waited for; a failed one never publishes', async () => {
    let polls = 0
    const a = fake([
      (c) => c.url.endsWith(':fetchStatus') ? ok(polls++ === 0 ? {} : { lastAsyncUploadState: polls > 2 ? 'SUCCEEDED' : 'IN_PROGRESS' }) : undefined,
      (c) => c.url.endsWith(':upload') ? ok({ uploadState: 'IN_PROGRESS' }) : undefined,
      (c) => c.url.endsWith(':publish') ? ok({ state: 'PENDING_REVIEW' }) : undefined,
    ])
    expect((await publishChrome(base, { ...quiet, fetch: a.f })).state).toBe('PENDING_REVIEW')
    const b = fake([
      (c) => c.url.endsWith(':fetchStatus') ? ok({}) : undefined,
      (c) => c.url.endsWith(':upload') ? ok({ uploadState: 'FAILED' }) : undefined,
    ])
    await expect(publishChrome(base, { ...quiet, fetch: b.f })).rejects.toThrow('FAILED')
    expect(b.calls.some((c) => c.url.endsWith(':publish'))).toBe(false)
  })

  test('the store must take the tag\'s version; bad ids stop before any call', async () => {
    const { f } = fake([
      (c) => c.url.endsWith(':fetchStatus') ? ok({}) : undefined,
      (c) => c.url.endsWith(':upload') ? ok({ uploadState: 'SUCCEEDED', crxVersion: '0.1.9' }) : undefined,
    ])
    await expect(publishChrome(base, { ...quiet, fetch: f })).rejects.toThrow('took version 0.1.9')
    const none = fake([])
    await expect(publishChrome({ ...base, publisher: '' }, { ...quiet, fetch: none.f })).rejects.toThrow('CWS_PUBLISHER_ID')
    await expect(publishChrome({ ...base, item: 'x' }, { ...quiet, fetch: none.f })).rejects.toThrow('CWS_ITEM_ID')
    expect(none.calls).toHaveLength(0)
  })

  test('the refresh-token exchange; an expired grant says so without the secret', async () => {
    const env = { CWS_CLIENT_ID: 'id', CWS_CLIENT_SECRET: 'sec', CWS_REFRESH_TOKEN: 'ref' }
    const a = fake([() => ok({ access_token: 'at' })])
    expect(await cwsTokenFromRefresh(env, a.f)).toBe('at')
    expect(new URLSearchParams(a.calls[0]!.body!).get('grant_type')).toBe('refresh_token')
    const b = fake([() => ok({ error: 'invalid_grant' }, 400)])
    const err = await cwsTokenFromRefresh(env, b.f).catch((e: Error) => e.message)
    expect(err).toContain('invalid_grant')
    expect(err).not.toContain('sec')
    await expect(cwsTokenFromRefresh({})).rejects.toThrow('no Chrome Web Store credentials')
  })
})

describe('Edge Add-ons', () => {
  const product = '01234567-89ab-cdef-0123-456789abcdef'
  test('upload operation, then the submission operation', async () => {
    const { f, calls } = fake([
      (c) => c.method === 'POST' && c.url.endsWith('/draft/package') ? new Response(null, { status: 202, headers: { location: 'op-up' } }) : undefined,
      (c) => c.url.endsWith('/draft/package/operations/op-up') ? ok({ status: 'Succeeded' }) : undefined,
      (c) => c.method === 'POST' && c.url.endsWith('/submissions') ? new Response(null, { status: 202, headers: { location: 'op-pub' } }) : undefined,
      (c) => c.url.endsWith('/submissions/operations/op-pub') ? ok({ status: 'Succeeded', message: 'Successfully created submission' }) : undefined,
    ])
    expect(await publishEdge({ product, clientId: 'cid', apiKey: 'key', zip: new Uint8Array([1]), version: '0.2.0' }, { ...quiet, fetch: f })).toEqual({ state: 'SUBMITTED' })
    expect(calls[0]!.url).toBe(`${EDGE_API}/v1/products/${product}/submissions/draft/package`)
    expect(calls[0]!.headers).toMatchObject({ authorization: 'ApiKey key', 'x-clientid': 'cid', 'content-type': 'application/zip' })
    expect(JSON.parse(calls[2]!.body!).notes).toContain('0.2.0')
  })
  test('a failed operation stops', async () => {
    const { f } = fake([
      (c) => c.method === 'POST' ? new Response(null, { status: 202, headers: { location: 'op' } }) : undefined,
      () => ok({ status: 'Failed', errorCode: 'InProgressSubmission' }),
    ])
    await expect(publishEdge({ product, clientId: 'c', apiKey: 'k', zip: new Uint8Array([1]), version: '0.2.0' }, { ...quiet, fetch: f })).rejects.toThrow('InProgressSubmission')
  })
})
