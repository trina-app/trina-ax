// Apps posting in rooms, the public address (docs/DECISIONS.md "Apps posting in rooms", server/src/rooms/apps/inbound.ts;
// QA TC-1547): the vendors' sample payloads, signatures over the raw bytes, content types, size, limits charged before
// the body, switches, a retry posting once, Sentry's delivery key without the timestamp, threads and their expiry,
// "came back" in the room, quiet, the cap / pause / resume at the team's midnight, the team cap, uniform 404s.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import crypto from 'node:crypto'
import { ROOM_APP_BURST, ROOM_APP_DAILY_CAP, ROOM_APP_TEAM_DAILY_CAP, ROOM_APP_UNKNOWN_PER_MINUTE } from '@mycel/shared/api'
import { roomAppsOf, teamDay } from '../../server/src/rooms/apps/service'
import { appText } from '../../server/src/rooms/apps/text'
import { loggablePath } from '../../server/src/http/middleware'
import { STORAGE_RETRY_AFTER_S } from '../../server/src/rooms/apps/inbound'
import { configureStorageGuard, type StatFs } from '../../server/src/system/storage'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

setDefaultTimeout(60_000)
let h: Harness
afterEach(async () => { await h?.close() })
const cm = () => 'cm-' + crypto.randomUUID()
const settle = () => new Promise((r) => setTimeout(r, 5))

async function setup() {
  h = await harness('b-room-apps-inbound', { publicOrigins: ['https://team.acme-corp.com'] })
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const rooms = (await owner.call('GET', '/api/rooms')).items as any[]
  const all = rooms.find((r) => r.kind === 'all')!.id as string
  const add = async (kind: string, roomId = all, c: Client = owner, name?: string) => {
    const r = await c.call('POST', `/api/rooms/${roomId}/apps`, { kind, ...(name ? { name } : {}) })
    return { app: r.app, address: r.address as string, token: (r.address as string).split('/in/')[1]! }
  }
  const post = (token: string, body: string, headers: Record<string, string> = {}) =>
    h.fetch(`/in/${token}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body })
  const messages = async (c: Client = owner, roomId = all) => ((await c.call('GET', `/api/rooms/${roomId}/messages`)).items as any[]).filter((m) => !m.event)
  return { owner, mia, all, add, post, messages }
}

const sentryIssue = (action: string, id = '42', extra: Record<string, unknown> = {}) => JSON.stringify({
  action, actor: { type: 'user', name: 'Jun' },
  data: { issue: { id, shortId: 'WEB-1', title: "TypeError: Cannot read properties of undefined (reading 'total')", culprit: 'app/cart/summary.ts', level: 'error', status: 'unresolved', web_url: `https://acme.sentry.io/issues/${id}/`, project: { slug: 'checkout-web' }, ...extra } },
})
const hmac = (secret: string, body: string) => crypto.createHmac('sha256', secret).update(body).digest('hex')

test('Other: a Slack-shaped text becomes a card from the app; the address is https on the team address; nothing can mention or format', async () => {
  const { owner, add, post, messages, all } = await setup()
  const { app, address, token } = await add('other', all, owner, 'Backups')
  expect(address).toMatch(/^https:\/\/team\.acme-corp\.com\/in\/tax_in_[A-Za-z0-9_-]{43}$/)
  expect(app).toMatchObject({ kind: 'other', name: 'Backups', quiet: false, signed: false, events: { message: true }, firstOkAt: null })
  const r = await post(token, JSON.stringify({ text: 'Backup finished @everyone *bold* <https://evil.example|https://good.example> <!channel>' }))
  expect(r.status).toBe(200)
  expect(await r.text()).toBe('ok\n')
  expect(r.headers.get('cache-control')).toBe('no-store')
  await settle()
  const [m] = await messages()
  expect(m).toMatchObject({ author: null, authorKind: 'user', mentions: [], app: { id: app.id, name: 'Backups', kind: 'other' } })
  expect(m.mentionsAll).toBeUndefined()
  // the misleading label shows the real address; the one link is the real one
  expect(m.appCard.title).toBe('Backup finished @everyone *bold* https://evil.example channel')
  expect(m.appCard.link).toEqual({ url: 'https://evil.example/', host: 'evil.example' })
  // the body escapes Markdown and "@": a person's message renderer shows it as text
  expect(m.body).toContain('\\@everyone \\*bold\\*')
  // the app's status line
  const list = await owner.call('GET', `/api/rooms/${all}/apps`)
  expect(list).toMatchObject({ available: true, max: 10 })
  expect(list.items[0].firstOkAt).not.toBeNull()
  expect(list.items[0].today).toBe(1)
  // the token never reaches a log line's path
  expect(loggablePath(`/in/${token}`)).toBe('/in/***')
})

test('unknown, malformed, rotated and removed addresses answer the same 404; any other method too; a browser Origin is refused', async () => {
  const { owner, add, post, all } = await setup()
  const a = await add('other')
  const b = await add('other', all, owner, 'Second')
  const body = JSON.stringify({ text: 'hi' })
  const answers: string[] = []
  const unknown = await post(`tax_in_${'A'.repeat(43)}`, body)
  answers.push(`${unknown.status} ${await unknown.text()}`)
  const bad = await post('nope', body)
  answers.push(`${bad.status} ${await bad.text()}`)
  const rotated = await owner.call('POST', `/api/rooms/${all}/apps/${a.app.id}/rotate`)
  const old = await post(a.token, body)
  answers.push(`${old.status} ${await old.text()}`)
  expect((await post(rotated.address.split('/in/')[1], body)).status).toBe(200)
  await owner.call('DELETE', `/api/rooms/${all}/apps/${b.app.id}`)
  const removed = await post(b.token, body)
  answers.push(`${removed.status} ${await removed.text()}`)
  const get = await h.fetch(`/in/${rotated.address.split('/in/')[1]}`, { method: 'GET' })
  answers.push(`${get.status} ${await get.text()}`)
  expect(new Set(answers)).toEqual(new Set(['404 not_found\n']))
  expect((await post(rotated.address.split('/in/')[1], body, { origin: 'https://evil.example' })).status).toBe(403)
  // nothing about the team in an answer
  expect(unknown.headers.get('cache-control')).toBe('no-store')
})

test('content type, size and an unreadable body are refused, and the status line says why', async () => {
  const { owner, add, post, all } = await setup()
  const s = await add('sentry')
  expect((await post(s.token, 'text', { 'content-type': 'text/plain' })).status).toBe(415)
  expect((await post(s.token, 'x'.repeat(256 * 1024 + 1))).status).toBe(413)
  expect((await post(s.token, '{"no":')).status).toBe(400)
  const list = (await owner.call('GET', `/api/rooms/${all}/apps`)).items
  // one refusal a minute is written: the first one
  expect(list[0].lastRefusal.reason).toBe('format')
  roomAppsOf(h.ctx).clock = () => Date.now() + 61_000
  expect((await post(s.token, 'x'.repeat(256 * 1024 + 1))).status).toBe(413)
  expect((await owner.call('GET', `/api/rooms/${all}/apps`)).items[0].lastRefusal.reason).toBe('too_big')
})

test('the server refusing writes (full disk): 503 + Retry-After before the body, no card, the status line says why; free space and it posts (QA TC-2285)', async () => {
  const { owner, add, post, messages, all } = await setup()
  const { token } = await add('other', all, owner, 'Backups')
  const GiB = 1024 ** 3
  // 20 GiB disk, 100 MiB free: under the 512 MiB reserve, so writes are refused (system/storage.ts)
  let free = 100 * 1024 * 1024
  const disk = (): StatFs => ({ bsize: 4096, blocks: (20 * GiB) / 4096, bfree: free / 4096, bavail: free / 4096 })
  configureStorageGuard({ root: '/', statfs: disk, enforce: () => true })
  try {
    // a body the reader would refuse (unreadable JSON) still gets the 503: the body is never read
    for (const body of [JSON.stringify({ text: 'Backup finished' }), '{"no":']) {
      const r = await post(token, body)
      expect(r.status).toBe(503)
      expect(r.headers.get('retry-after')).toBe(String(STORAGE_RETRY_AFTER_S))
      expect(await r.text()).toBe('storage_full\n')
    }
    await settle()
    expect(await messages()).toEqual([])
    const app = (await owner.call('GET', `/api/rooms/${all}/apps`)).items[0]
    expect(app.lastRefusal.reason).toBe('storage_full')
    expect(app.firstOkAt).toBeNull()
    // space freed: the vendor's retry posts
    free = 10 * GiB
    expect((await post(token, JSON.stringify({ text: 'Backup finished' }))).status).toBe(200)
    await settle()
    expect((await messages()).map((m) => m.appCard?.title)).toEqual(['Backup finished'])
  } finally { configureStorageGuard(null) }
})

test('Sentry: a new issue is a card; resolved goes to its thread and the card\'s status changes; came back goes to the room too; the delivery key ignores the timestamp', async () => {
  const { add, post, messages, owner, all } = await setup()
  const { token } = await add('sentry')
  const created = sentryIssue('created')
  expect((await post(token, created, { 'sentry-hook-resource': 'issue', 'sentry-hook-timestamp': '1' })).status).toBe(200)
  // the same delivery with another timestamp (not signed) is a retry: nothing new
  expect((await post(token, created, { 'sentry-hook-resource': 'issue', 'sentry-hook-timestamp': '2' })).status).toBe(200)
  await settle()
  let ms = await messages()
  expect(ms).toHaveLength(1)
  const root = ms[0]
  expect(root.appCard).toMatchObject({ kind: `${appText('sentryNew', 'ko')} · checkout-web · error`, title: "TypeError: Cannot read properties of undefined (reading 'total')", details: ['app/cart/summary.ts'],
    status: appText('status', 'ko', { status: appText('statusUnresolved', 'ko') }), link: { url: 'https://acme.sentry.io/issues/42/', host: 'acme.sentry.io' } })
  // resolved: in the thread, the card flagged unverified (no secret; no mark after the name), the root's status line changed
  expect((await post(token, sentryIssue('resolved'), { 'sentry-hook-resource': 'issue' })).status).toBe(200)
  await settle()
  ms = await messages()
  expect(ms).toHaveLength(1)
  expect(ms[0].appCard.status).toBe(appText('status', 'ko', { status: appText('sentryResolved', 'ko') }))
  expect(ms[0].thread.replyCount).toBe(1)
  const thread = await owner.call('GET', `/api/rooms/${all}/messages/${root.id}/thread`)
  expect(thread.items[0].appCard.title).toBe(appText('sentryResolvedBy', 'ko', { actor: 'Jun' }))
  expect(thread.items[0].appCard.unverified).toBe(true)
  // came back: the thread and the room
  expect((await post(token, sentryIssue('unresolved'), { 'sentry-hook-resource': 'issue' })).status).toBe(200)
  await settle()
  ms = await messages()
  expect(ms).toHaveLength(2)
  expect(ms[1]).toMatchObject({ threadRootId: root.id, alsoInRoom: true, appCard: { title: appText('sentryBack', 'ko') } })
  // installation and the like: 200, nothing shown
  expect((await post(token, JSON.stringify({ action: 'created', data: {} }), { 'sentry-hook-resource': 'installation' })).status).toBe(200)
  // an alert: its switch is off by default, but the first one turns it on by itself (once) and joins the issue's thread
  const alert = JSON.stringify({ action: 'triggered', data: { event: { title: 'TypeError again', issue_id: '42', level: 'error', web_url: 'https://acme.sentry.io/issues/42/events/1/' }, triggered_rule: 'Errors in checkout' } })
  expect((await post(token, alert, { 'sentry-hook-resource': 'event_alert' })).status).toBe(200)
  await settle()
  const t2 = await owner.call('GET', `/api/rooms/${all}/messages/${root.id}/thread`)
  expect(t2.items.at(-1).appCard.title).toBe(appText('sentryAlert', 'ko', { rule: 'Errors in checkout' }))
  expect((await owner.call('GET', `/api/rooms/${all}/apps`)).items[0].events.alert).toBe(true)
})

test('signatures are optional for GitHub and Sentry; once a secret is set, a missing or wrong one is refused (raw bytes, keys in any order)', async () => {
  const { owner, add, post, messages, all } = await setup()
  const g = await add('github')
  const pr = (action: string, extra: Record<string, unknown> = {}) => `{"zeta":1,"action":"${action}","pull_request":{"number":7,"title":"Fix cart total","html_url":"https://github.com/acme/web/pull/7","user":{"login":"jun"},"merged":${extra.merged ? 'true' : 'false'}},"repository":{"id":99,"full_name":"acme/web"},"sender":{"login":"jun"},"alpha":2}`
  // unsigned: taken, the name as sent (the settings say "Not signed" once)
  expect((await post(g.token, pr('opened'), { 'x-github-event': 'pull_request', 'x-github-delivery': 'd1' })).status).toBe(200)
  await settle()
  expect((await messages())[0].appCard.details[0]).toBe(appText('byActor', 'ko', { actor: 'jun' }))
  // "Make it safer": a secret Trina makes, shown once here and on the address
  const s = await owner.call('PUT', `/api/rooms/${all}/apps/${g.app.id}/secret`, { generate: true })
  expect(s.secret).toMatch(/^tax_whs_[A-Za-z0-9_-]{43}$/)
  // it waits for GitHub: until a request signed with it comes, unsigned ones are still shown (copying the secret must
  // not drop what GitHub sends before it is pasted there)
  expect(s.app.signed).toBe(false)
  expect(s.app.signingPending).toBe(true)
  expect((await owner.call('GET', `/api/rooms/${all}/apps/${g.app.id}/address`)).secret).toBe(s.secret)
  expect((await post(g.token, pr('labeled'), { 'x-github-event': 'pull_request', 'x-github-delivery': 'd1b' })).status).toBe(200)
  // the first signed request (GitHub's ping) turns the check on
  expect((await post(g.token, '{"zen":"y","hook_id":1}', { 'x-github-event': 'ping', 'x-hub-signature-256': `sha256=${hmac(s.secret, '{"zen":"y","hook_id":1}')}` })).status).toBe(200)
  const on = (await owner.call('GET', `/api/rooms/${all}/apps`)).items.find((x: { id: string }) => x.id === g.app.id)
  expect(on.signed).toBe(true)
  expect(on.signingPending).toBeUndefined()
  // now unsigned and wrongly signed requests are refused; the status line says so
  expect((await post(g.token, pr('closed', { merged: true }), { 'x-github-event': 'pull_request', 'x-github-delivery': 'd2' })).status).toBe(401)
  expect((await post(g.token, pr('closed', { merged: true }), { 'x-github-event': 'pull_request', 'x-github-delivery': 'd2', 'x-hub-signature-256': `sha256=${hmac('other', pr('closed', { merged: true }))}` })).status).toBe(401)
  expect((await owner.call('GET', `/api/rooms/${all}/apps`)).items[0].lastRefusal.reason).toBe('signature')
  // signed over the raw bytes as sent (no re-serialising): taken, names not marked
  const body = pr('closed', { merged: true })
  expect((await post(g.token, body, { 'x-github-event': 'pull_request', 'x-github-delivery': 'd2', 'x-hub-signature-256': `sha256=${hmac(s.secret, body)}` })).status).toBe(200)
  await settle()
  const ms = await messages()
  expect(ms).toHaveLength(1)
  expect(ms[0].appCard.status).toBe(appText('status', 'ko', { status: appText('statusMerged', 'ko') }))
  const thread = await owner.call('GET', `/api/rooms/${all}/messages/${ms[0].id}/thread`)
  expect(thread.items[0].appCard.title).toBe(`${appText('prMerged', 'ko')} · ${appText('byActor', 'ko', { actor: 'jun' })}`)
  // ping: connected, no card
  expect((await post(g.token, '{"zen":"x","hook_id":1}', { 'x-github-event': 'ping', 'x-hub-signature-256': `sha256=${hmac(s.secret, '{"zen":"x","hook_id":1}')}` })).status).toBe(200)
  // Sentry: its Client Secret's shape is checked; then Sentry-Hook-Signature is required
  const se = await add('sentry')
  expect((await owner.try('PUT', `/api/rooms/${all}/apps/${se.app.id}/secret`, { secret: 'not-a-secret' })).status).toBe(400)
  const clientSecret = 'ab'.repeat(32)
  await owner.call('PUT', `/api/rooms/${all}/apps/${se.app.id}/secret`, { secret: clientSecret })
  const created = sentryIssue('created', '77')
  expect((await post(se.token, created, { 'sentry-hook-resource': 'issue' })).status).toBe(401)
  expect((await post(se.token, created, { 'sentry-hook-resource': 'issue', 'sentry-hook-signature': hmac(clientSecret, created) })).status).toBe(200)
  // the pasted secret is never shown again
  expect((await owner.call('GET', `/api/rooms/${all}/apps/${se.app.id}/address`)).secret).toBeUndefined()
  // taken away: unsigned again
  await owner.call('PUT', `/api/rooms/${all}/apps/${se.app.id}/secret`, { secret: null })
  expect((await post(se.token, sentryIssue('created', '78'), { 'sentry-hook-resource': 'issue' })).status).toBe(200)
  // other kinds take no secret
  const o = await add('other')
  expect((await owner.try('PUT', `/api/rooms/${all}/apps/${o.app.id}/secret`, { generate: true })).status).toBe(400)
})

test('a switch that is off skips; Quiet makes short lines with no unread and no list line; a retry after a 429 posts once', async () => {
  const { owner, mia, add, post, messages, all } = await setup()
  const g = await add('github')
  const push = JSON.stringify({ ref: 'refs/heads/main', commits: [{}, {}], head_commit: { message: 'Bump\nmore' }, compare: 'https://github.com/acme/web/compare/a...b', repository: { id: 9, full_name: 'acme/web' }, sender: { login: 'jun' } })
  // push is off by default
  expect((await post(g.token, push, { 'x-github-event': 'push', 'x-github-delivery': 'p1' })).status).toBe(200)
  await settle()
  expect(await messages()).toHaveLength(0)
  await owner.call('PATCH', `/api/rooms/${all}/apps/${g.app.id}`, { events: { push: true }, quiet: true })
  expect((await owner.try('PATCH', `/api/rooms/${all}/apps/${g.app.id}`, { events: { nope: true } })).status).toBe(400)
  const before = (await mia.client.call('GET', '/api/rooms')).items.find((r: any) => r.id === all)
  expect((await post(g.token, push, { 'x-github-event': 'push', 'x-github-delivery': 'p2' })).status).toBe(200)
  await settle()
  const ms = await messages()
  expect(ms).toHaveLength(1)
  expect(ms[0].app.quiet).toBe(true)
  expect(ms[0].appCard.kind).toBe(appText('pushedMany', 'ko', { n: 2, branch: 'main' }))
  const after = (await mia.client.call('GET', '/api/rooms')).items.find((r: any) => r.id === all)
  expect(after.unreadCount).toBe(before.unreadCount)
  expect(after.lastMessage?.id ?? null).toBe(before.lastMessage?.id ?? null)
  // a burst: past it 429 with Retry-After, before the body; the vendor's retry later posts once
  const apps = roomAppsOf(h.ctx)
  let t = Date.now()
  apps.clock = () => t
  await owner.call('PATCH', `/api/rooms/${all}/apps/${g.app.id}`, { quiet: false })
  let limited: Response | null = null
  for (let i = 0; i < ROOM_APP_BURST + 2 && !limited; i++) {
    const r = await post(g.token, '{"zen":1}', { 'x-github-event': 'ping' })
    if (r.status === 429) limited = r
  }
  expect(limited!.headers.get('retry-after')).toBe('1')
  const rel = JSON.stringify({ action: 'published', release: { tag_name: 'v1.2.0', name: 'v1.2.0', html_url: 'https://github.com/acme/web/releases/tag/v1.2.0' }, repository: { id: 9, full_name: 'acme/web' } })
  expect((await post(g.token, rel, { 'x-github-event': 'release', 'x-github-delivery': 'r1' })).status).toBe(429)
  t += 5_000
  expect((await post(g.token, rel, { 'x-github-event': 'release', 'x-github-delivery': 'r1' })).status).toBe(200)
  expect((await post(g.token, rel, { 'x-github-event': 'release', 'x-github-delivery': 'r1' })).status).toBe(200)
  await settle()
  expect((await messages()).filter((m) => m.appCard?.kind === appText('release', 'ko', { tag: 'v1.2.0' }))).toHaveLength(1)
  // the day's counters
  apps.flushDrops()
  const day = teamDay(h.ctx.db, t).day
  const c = h.ctx.db.query('SELECT received, shown, skipped, dropped FROM room_app_days WHERE app_id = ? AND day = ?').get(g.app.id, day) as any
  expect(c.dropped).toBeGreaterThanOrEqual(2)
  expect(c.shown).toBe(2)
})

test('unknown addresses are limited per client address before anything else', async () => {
  const { post } = await setup()
  let status = 0
  for (let i = 0; i <= ROOM_APP_UNKNOWN_PER_MINUTE; i++) status = (await post(`tax_in_${String(i).padStart(43, 'x')}`, '{}')).status
  expect(status).toBe(429)
})

test('threads: one per thing for 30 days, then a new card; an Other text again within the hour joins it', async () => {
  const { add, post, messages } = await setup()
  const apps = roomAppsOf(h.ctx)
  let t = Date.now()
  apps.clock = () => t
  const s = await add('sentry')
  await post(s.token, sentryIssue('created', '5'), { 'sentry-hook-resource': 'issue' })
  t += 31 * 86_400_000
  await post(s.token, sentryIssue('unresolved', '5'), { 'sentry-hook-resource': 'issue' })
  await settle()
  let ms = await messages()
  expect(ms).toHaveLength(2)
  expect(ms[1].threadRootId).toBeUndefined()
  const o = await add('other')
  await post(o.token, JSON.stringify({ text: 'Disk almost full' }), { 'idempotency-key': 'a' })
  await post(o.token, JSON.stringify({ text: 'Disk almost full' }), { 'idempotency-key': 'b' })
  await settle()
  ms = await messages()
  expect(ms).toHaveLength(3)
  expect(ms[2].thread.replyCount).toBe(1)
})

test('the day\'s cap pauses the app until the team\'s midnight: a quiet line, a notice to who manages it, 429; Resume now once a day; the team cap', async () => {
  const { owner, mia, add, post, messages, all } = await setup()
  const apps = roomAppsOf(h.ctx)
  const o = await add('other')
  const { day, next } = teamDay(h.ctx.db, Date.now())
  h.ctx.db.query("INSERT INTO room_app_days (app_id, day, room_id, kind, shown) VALUES (?, ?, ?, 'other', ?) ON CONFLICT(app_id, day) DO UPDATE SET shown = excluded.shown").run(o.app.id, day, all, ROOM_APP_DAILY_CAP)
  const r = await post(o.token, JSON.stringify({ text: 'one too many' }))
  expect(r.status).toBe(429)
  expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0)
  await settle()
  const ms = await messages()
  expect(ms.at(-1)).toMatchObject({ app: { quiet: true }, appCard: { title: appText('pausedLine', 'ko', { app: o.app.name, cap: ROOM_APP_DAILY_CAP }) } })
  const listed = (await owner.call('GET', `/api/rooms/${all}/apps`)).items[0]
  expect(listed).toMatchObject({ pausedUntil: next, canResume: true, pausedBy: 'app', pausedCap: ROOM_APP_DAILY_CAP })
  expect(listed.timeZone).toBeUndefined()
  // the owner (who manages it in the everyone room) is told; a member is not
  const ownerInbox = (await owner.call('GET', '/api/notifications')).items as any[]
  const notice = ownerInbox.find((n) => n.code === 'room_app.paused')
  expect(notice).toMatchObject({ link: 'room', roomApp: { appId: o.app.id, roomId: all, cap: ROOM_APP_DAILY_CAP, canResume: true } })
  expect(((await mia.client.call('GET', '/api/notifications')).items as any[]).some((n) => n.code === 'room_app.paused')).toBe(false)
  // still paused: skipped
  expect((await post(o.token, JSON.stringify({ text: 'later' }))).status).toBe(429)
  // a member may not resume it; the owner may, once a day
  expect((await mia.client.try('POST', `/api/rooms/${all}/apps/${o.app.id}/resume`)).status).toBe(403)
  const resumed = await owner.call('POST', `/api/rooms/${all}/apps/${o.app.id}/resume`)
  expect(resumed).toMatchObject({ pausedUntil: null, canResume: false })
  expect((await post(o.token, JSON.stringify({ text: 'back' }))).status).toBe(200)
  expect((await owner.try('POST', `/api/rooms/${all}/apps/${o.app.id}/resume`)).status).toBe(409)
  // the next day it runs again by itself
  apps.clock = () => Date.parse(next) + 1000
  expect((await post(o.token, JSON.stringify({ text: 'next day' }))).status).toBe(200)
  // the team's cap: every app pauses
  const nd = teamDay(h.ctx.db, Date.parse(next) + 1000).day
  const other = await add('other', all, owner, 'Other two')
  h.ctx.db.query("INSERT INTO room_app_days (app_id, day, room_id, kind, shown) VALUES (?, ?, ?, 'other', ?) ON CONFLICT(app_id, day) DO UPDATE SET shown = excluded.shown").run(o.app.id, nd, all, ROOM_APP_TEAM_DAILY_CAP)
  expect((await post(other.token, JSON.stringify({ text: 'team full' }))).status).toBe(429)
  // QA TC-2067: said as the team's cap everywhere, with its number (5,000, not the app's 500) and no Resume now
  const two = (await owner.call('GET', `/api/rooms/${all}/apps`)).items.find((a: any) => a.id === other.app.id)
  expect(two).toMatchObject({ canResume: false, pausedBy: 'team', pausedCap: ROOM_APP_TEAM_DAILY_CAP, timeZone: expect.any(String) })
  await settle()
  const line = (await messages()).at(-1)
  expect(line.app).toMatchObject({ id: other.app.id, quiet: true })
  expect(line.appCard.title).toBe(apps.teamCapText('ko', two.pausedUntil))
  expect(line.appCard.title).toContain('5,000')
  expect(line.appCard.title).not.toContain('Other two')
  expect(apps.teamCapText('en', two.pausedUntil)).toMatch(/^Your team's apps reached 5,000 messages today\. All apps are paused until .+\.$/)
  const teamNotice = ((await owner.call('GET', '/api/notifications')).items as any[]).find((n) => n.code === 'room_app.paused' && n.roomApp?.appId === other.app.id)
  expect(teamNotice.roomApp).toMatchObject({ cap: ROOM_APP_TEAM_DAILY_CAP, team: true, canResume: false, timeZone: expect.any(String) })
  const refused = await owner.try('POST', `/api/rooms/${all}/apps/${other.app.id}/resume`)
  expect(refused.status).toBe(409)
  // a second app of the room paused by the team's cap the same day: no second line (QA TC-2067), still its notice
  const third = await add('other', all, owner, 'Other three')
  const before = (await messages()).length
  expect((await post(third.token, JSON.stringify({ text: 'team still full' }))).status).toBe(429)
  await settle()
  expect((await messages()).length).toBe(before)
  expect((await owner.call('GET', `/api/rooms/${all}/apps`)).items.find((a: any) => a.id === third.app.id)).toMatchObject({ pausedBy: 'team' })
  expect(((await owner.call('GET', '/api/notifications')).items as any[]).some((n) => n.code === 'room_app.paused' && n.roomApp?.appId === third.app.id)).toBe(true)
})

test('Regenerate: the status waits for the service to use the new Webhook URL until a message arrives on it (QA TC-2086)', async () => {
  const { owner, add, post, all } = await setup()
  const a = await add('github')
  const ping = JSON.stringify({ zen: 'Keep it logically awesome.', hook_id: 1 })
  expect((await post(a.token, ping, { 'x-github-event': 'ping', 'x-github-delivery': 'd1' })).status).toBe(200)
  const before = (await owner.call('GET', `/api/rooms/${all}/apps`)).items[0]
  expect(before.rotatedAt).toBeNull()
  expect(before.lastOkAt).not.toBeNull()
  const r = await owner.call('POST', `/api/rooms/${all}/apps/${a.app.id}/rotate`)
  expect(r.app.rotatedAt).not.toBeNull()
  expect(Date.parse(r.app.rotatedAt)).toBeGreaterThanOrEqual(Date.parse(before.lastOkAt))
  // the service still sends to the old URL: 404, and the app still waits
  expect((await post(a.token, ping, { 'x-github-event': 'ping', 'x-github-delivery': 'd2' })).status).toBe(404)
  const waiting = (await owner.call('GET', `/api/rooms/${all}/apps`)).items[0]
  expect(waiting.lastOkAt).toBe(before.lastOkAt)
  expect(Date.parse(waiting.lastOkAt)).toBeLessThanOrEqual(Date.parse(waiting.rotatedAt))
  // the first message on the new URL: lastOkAt passes rotatedAt
  await new Promise((res) => setTimeout(res, 5))
  expect((await post(r.address.split('/in/')[1], ping, { 'x-github-event': 'ping', 'x-github-delivery': 'd3' })).status).toBe(200)
  const after = (await owner.call('GET', `/api/rooms/${all}/apps`)).items[0]
  expect(Date.parse(after.lastOkAt)).toBeGreaterThan(Date.parse(after.rotatedAt))
})

test('Google Forms: a response is a card with the respondent\'s email by default (a switch turns it off); an edit goes to its thread', async () => {
  const { owner, add, post, messages, all } = await setup()
  const f = await add('google_forms')
  expect(f.app.events).toEqual({ response: true, email: true })
  const resp = (at: string, email = 'kim@acme-corp.com') => JSON.stringify({ form: 'Sign-up', id: 'r1', at, email, answers: [{ q: 'Name', a: 'Kim' }, { q: 'Team', a: 'Sales' }, { q: 'Size', a: ['S', 'M'].join(', ') }, { q: 'Note', a: 'hi' }] })
  expect((await post(f.token, resp('2026-11-14T01:00:00Z'))).status).toBe(200)
  await settle()
  let [m] = await messages()
  expect(m.appCard.kind).toBe(appText('formsNew', 'ko', { form: 'Sign-up' }))
  expect(m.appCard.title).toBe('Name: Kim')
  expect(m.appCard.details[0]).toBe(appText('formsEmail', 'ko', { email: 'kim@acme-corp.com' }))
  expect(m.body).toContain('Note: hi')
  // edited: same id, new time: in the thread
  expect((await post(f.token, resp('2026-11-14T02:00:00Z'))).status).toBe(200)
  await owner.call('PATCH', `/api/rooms/${all}/apps/${f.app.id}`, { events: { email: false } })
  expect((await post(f.token, JSON.stringify({ form: 'Sign-up', id: 'r2', at: 'x', email: 'lee@acme-corp.com', answers: [{ q: 'Name', a: 'Lee' }] }))).status).toBe(200)
  await settle()
  const ms = await messages()
  expect(ms).toHaveLength(2)
  expect(ms[0].thread.replyCount).toBe(1)
  expect(ms[1].body).not.toContain('lee@')
  // too many answers: unreadable
  expect((await post(f.token, JSON.stringify({ form: 'x', id: 'r3', at: 'y', answers: Array.from({ length: 51 }, () => ({ q: 'a', a: 'b' })) }))).status).toBe(400)
  m = ms[0]
})

test('addresses in outside text never link; lengths fit the contract; a deleted card keeps only its sender; a body that never ends gets 408', async () => {
  const { owner, add, post, messages, all } = await setup()
  const o = await add('other')
  const long = '😀'.repeat(400)
  expect((await post(o.token, JSON.stringify({ title: long, text: 'Log in at http://evil.example/login or www.evil.example', link: `https://acme-corp.com/${'é'.repeat(400)}` }))).status).toBe(200)
  await settle()
  const [m] = await messages()
  expect(m.body).not.toMatch(/https?:\/\/evil|www\.evil/)
  expect(m.body).toContain('http:\\/\\/evil')
  expect(m.appCard.title.length).toBeLessThanOrEqual(200)
  expect(m.appCard.link).toBeUndefined()
  // deleted by the owner: the card's content goes from the row too
  await owner.call('DELETE', `/api/rooms/${all}/messages/${m.id}`)
  const row = h.ctx.db.query('SELECT body, app_card FROM room_messages WHERE id = ?').get(m.id) as { body: string; app_card: string }
  expect(row.body).toBe('')
  expect(row.app_card).not.toContain('evil')
  expect(JSON.parse(row.app_card).app.kind).toBe('other')
  // a sender that never finishes its body: 408 at the deadline, not the server's idle timeout
  const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"text":')) } })
  const t0 = Date.now()
  const r = await h.fetch(`/in/${o.token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: stream, duplex: 'half' } as never)
  expect(r.status).toBe(408)
  expect(Date.now() - t0).toBeLessThan(15_000)
})

test('Other: a plain form post (text=…, no payload field) is read like JSON, with the same limits (QA TC-2405)', async () => {
  const { add, post, messages } = await setup()
  const o = await add('other', undefined, undefined, 'Feeds')
  const form = { 'content-type': 'application/x-www-form-urlencoded' }
  expect((await post(o.token, 'text=Hello form', form)).status).toBe(200)
  expect((await post(o.token, `title=Nightly&text=${encodeURIComponent('line one\nline two')}&url=${encodeURIComponent('https://ci.example.com/run/1')}&thread=n1`, form)).status).toBe(200)
  // Slack's payload field as before; a form with none of the fields is unreadable (400)
  expect((await post(o.token, `payload=${encodeURIComponent(JSON.stringify({ text: 'From payload' }))}`, form)).status).toBe(200)
  expect((await post(o.token, 'foo=bar', form)).status).toBe(400)
  // mentions stay plain words, as in JSON
  expect((await post(o.token, `text=${encodeURIComponent('Heads up <!here>')}`, form)).status).toBe(200)
  await settle()
  const ms = (await messages()).sort((a, b) => a.seq - b.seq)
  expect(ms.map((m) => m.appCard.title)).toEqual(['Hello form', 'Nightly', 'From payload', 'Heads up here'])
  expect(ms[1].appCard.details).toEqual(['line one', 'line two'])
  expect(ms[1].appCard.link).toEqual({ url: 'https://ci.example.com/run/1', host: 'ci.example.com' })
  expect(ms[3].mentions).toEqual([])
})

test('a secret changed or taken away clears its old "didn\'t match" line; Toss Payments and PortOne name their own field; the hourly add limit says how long to wait', async () => {
  const { owner, add, post, all } = await setup()
  const s = await add('sentry')
  await owner.call('PUT', `/api/rooms/${all}/apps/${s.app.id}/secret`, { secret: 'cd'.repeat(32) })
  expect((await post(s.token, sentryIssue('created', '91'), { 'sentry-hook-resource': 'issue' })).status).toBe(401)
  const app = async () => ((await owner.call('GET', `/api/rooms/${all}/apps`)).items as any[]).find((x) => x.id === s.app.id)
  expect((await app()).lastRefusal.reason).toBe('signature')
  await owner.call('PUT', `/api/rooms/${all}/apps/${s.app.id}/secret`, { secret: null })
  expect((await app()).lastRefusal).toBeNull()
  // the field's own name in the refusal
  const toss = await owner.call('POST', `/api/rooms/${all}/apps`, { kind: 'other', preset: 'toss_payments' })
  const bad = await owner.try('PUT', `/api/rooms/${all}/apps/${toss.app.id}/secret`, { secret: 'not-hex-not-hex-not-hex-not-hex-' })
  expect(bad.status).toBe(400)
  expect([appText('tossKeyShape', 'ko'), appText('tossKeyShape', 'en')]).toContain(bad.body.error.message)
  const portone = await owner.call('POST', `/api/rooms/${all}/apps`, { kind: 'other', preset: 'portone' })
  const bad2 = await owner.try('PUT', `/api/rooms/${all}/apps/${portone.app.id}/secret`, { secret: 'hello-not-a-secret-at-all' })
  expect([appText('portoneSecretShape', 'ko'), appText('portoneSecretShape', 'en')]).toContain(bad2.body.error.message)
  // ten an hour per person (three added above; the room holds ten, so one is removed first): the eleventh says the
  // minutes to wait, not "shortly"
  for (let i = 0; i < 7; i++) await owner.call('POST', `/api/rooms/${all}/apps`, { kind: 'other', name: `Feed ${i}` })
  await owner.call('DELETE', `/api/rooms/${all}/apps/${portone.app.id}`)
  const r = await owner.try('POST', `/api/rooms/${all}/apps`, { kind: 'other', name: 'One too many' })
  expect(r.status).toBe(429)
  expect(r.body.error.retryAfter).toBeGreaterThan(3000)
  expect(r.body.error.message).toMatch(/60/)
})

test('a secret Trina makes waits only the first time: once one is enforced, a new one is enforced at once; the first signed request clears waiting only for the secret it was checked with (security review of #880)', async () => {
  const { owner, add, post, all } = await setup()
  const g = await add('github')
  const ping = '{"zen":"x","hook_id":1}'
  const signedPing = (secret: string) => post(g.token, ping, { 'x-github-event': 'ping', 'x-hub-signature-256': `sha256=${hmac(secret, ping)}` })
  const unsigned = () => post(g.token, ping, { 'x-github-event': 'ping' })
  const gen = async () => (await owner.call('PUT', `/api/rooms/${all}/apps/${g.app.id}/secret`, { generate: true })) as { secret: string; app: { signed: boolean; signingPending?: true } }
  // the first one waits: unsigned still taken until its first signed request
  const first = await gen()
  expect(first.app.signingPending).toBe(true)
  // a signed request checked with an older sealed secret clears nothing (a secret set again meanwhile keeps waiting)
  roomAppsOf(h.ctx).signingSeen(g.app.id, 'not-the-current-secret')
  expect((h.ctx.db.query('SELECT secret_pending FROM room_apps WHERE id = ?').get(g.app.id) as { secret_pending: number }).secret_pending).toBe(1)
  expect((await unsigned()).status).toBe(200)
  expect((await signedPing(first.secret)).status).toBe(200)
  expect((await unsigned()).status).toBe(401)
  // making another after that: enforced at once, unsigned refused, the old secret refused, the new one taken
  const second = await gen()
  expect(second.app.signed).toBe(true)
  expect(second.app.signingPending).toBeUndefined()
  expect((await unsigned()).status).toBe(401)
  expect((await signedPing(first.secret)).status).toBe(401)
  expect((await signedPing(second.secret)).status).toBe(200)
  // taken away and made again: nothing is enforced any more, so it waits again
  await owner.call('PUT', `/api/rooms/${all}/apps/${g.app.id}/secret`, { secret: null })
  expect((await gen()).app.signingPending).toBe(true)
})
