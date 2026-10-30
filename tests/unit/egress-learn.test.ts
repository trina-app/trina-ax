// This server's public exit address on every install (docs/DECISIONS.md "Exit address on every install"; QA 0.2.12 B1).
// A server without a relay (Linux behind a Cloudflare tunnel, likely hosted ones too) never knew its exit address, so
// every web_fetch asked with an "office address" card (also addresses the person typed: the link budget never
// applied), and the schedule card promised "opens without asking on each run" while every run was refused. Now:
//  - probeExitAddresses asks the feed's /ip over IPv4 and over IPv6 the way web_fetch connects (a fake feed on
//    loopback; the name lookup and this machine's interfaces are stubs): both families, an older Worker (404), no
//    IPv4 on the machine, wrong answers, a feed that resolves privately
//  - what "known" means (IPv4, or IPv6 when there is no IPv4; the relay), the learner's rounds, retries and log lines,
//    and web_fetch waiting a moment for the first round after a start
//  - unknown stays fail-safe: the card asks (neutral wording), an unattended run opens nothing and says why, and the
//    schedule cards (create and "다시 확인") say runs cannot open the addresses yet instead of promising
// Nothing here resolves a real name or leaves this machine.
import dnsP from 'node:dns/promises'
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, type Locale } from '@mycel/shared/api'
import { uuidv7 } from '@mycel/shared'
import { startHarness, type Harness } from '../lib/b-harness'
import { waitFor } from '../lib/wait'
import { createLogger } from '../../server/src/log'
import { egressOf, egressSettled, EXIT_ADDRESS_URL, hasDefaultRoute4, learnExitAddresses, noteEgressIp, probeExitAddresses, startEgressLearning, exitAddressCheckOff, type ProbeResult } from '../../server/src/tools/egress'
import { ToolError } from '../../server/src/policy/errors'
import { gateUrl, type ConfirmExtra, type TurnPerson } from '../../server/src/tools/url-gate'
import { scheduleCard, TEXT as SCHEDULE_TEXT } from '../../server/src/tools/schedules'
import { toolRegistry } from '../../server/src/tools/registry'
import { TurnFiles } from '../../server/src/files/service'

setDefaultTimeout(60_000)

// ---------------- a fake feed on loopback ----------------
const PUBLIC4 = '93.184.216.77', PUBLIC6 = '2606:4700:3030::6815:1001'
let mode: 'ok' | 'old' | 'garbage' | 'private' | 'swap' = 'ok'
const seen: { path: string; family: string; ua: string | null; accept: string | null; method: string }[] = []
const answer = (family: string) => {
  const v6 = family === 'IPv6'
  if (mode === 'old') return new Response('Not found\n', { status: 404 })
  if (mode === 'garbage') return new Response('<html>hello</html>')
  if (mode === 'private') return new Response(v6 ? 'fd00::5\n' : '10.0.0.5\n')
  if (mode === 'swap') return new Response(v6 ? `${PUBLIC4}\n` : `${PUBLIC6}\n`)
  return new Response(`${v6 ? PUBLIC6 : PUBLIC4}\n`, { headers: { 'cache-control': 'no-store' } })
}
const handler = (req: Request, srv: { requestIP(r: Request): { family: string } | null }) => {
  const fam = srv.requestIP(req)?.family ?? '?'
  seen.push({ path: new URL(req.url).pathname, family: fam, ua: req.headers.get('user-agent'), accept: req.headers.get('accept'), method: req.method })
  return answer(fam)
}
const feed4 = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handler })
let feed6: ReturnType<typeof Bun.serve> | null = null
try { feed6 = Bun.serve({ hostname: '::1', port: feed4.port, fetch: handler }) } catch { /* no IPv6 loopback here */ }
const FEED = `http://feed.test:${feed4.port}/ip`
const lookupBoth = async () => [{ address: '127.0.0.1', family: 4 }, ...(feed6 ? [{ address: '::1', family: 6 }] : [])]
const loopback = (ip: string) => ip === '127.0.0.1' || ip === '::1'
const nic = (address: string, family: 'IPv4' | 'IPv6') => ({ address, family, internal: false, netmask: family === 'IPv4' ? '255.255.255.0' : 'ffff:ffff:ffff:ffff::', mac: '02:00:00:00:00:01', cidr: `${address}/${family === 'IPv4' ? 24 : 64}`, ...(family === 'IPv6' ? { scopeid: 0 } : {}) })
const DUAL = { en0: [nic('192.168.1.10', 'IPv4'), nic('2001:db8:1::10', 'IPv6'), nic('fe80::1', 'IPv6')] } as never
const V6ONLY = { en0: [nic('2001:db8:1::10', 'IPv6'), nic('169.254.3.3', 'IPv4')] } as never
const V4ONLY = { en0: [nic('192.168.1.10', 'IPv4'), nic('fe80::1', 'IPv6')] } as never
const probe = (o: Parameters<typeof probeExitAddresses>[0] = {}) => probeExitAddresses({ url: FEED, lookup: lookupBoth, testAllow: loopback, interfaces: DUAL, timeoutMs: 3000, ...o })

afterAll(() => { feed4.stop(true); feed6?.stop(true) })

describe('asking the feed (probeExitAddresses)', () => {
  test('the production address is the release feed\'s /ip', () => {
    expect(EXIT_ADDRESS_URL).toBe('https://updates.trina.app/ip')
  })

  test('both families: one GET /ip over each, the answer is the address the feed saw', async () => {
    mode = 'ok'; seen.length = 0
    const r = await probe()
    expect(r.v4).toEqual({ ip: PUBLIC4, family: 4 })
    if (feed6) expect(r.v6).toEqual({ ip: '2606:4700:3030:0000:0000:0000:6815:1001', family: 6 })
    expect(seen.map((s) => [s.method, s.path, s.family]).sort()).toEqual([['GET', '/ip', 'IPv4'], ...(feed6 ? [['GET', '/ip', 'IPv6']] : [])])
    expect(seen.every((s) => s.ua === 'Trina-AX-exit-address/1' && s.accept === 'text/plain')).toBe(true)
  })

  test('an older feed Worker (404), an answer that is no address, a private answer, a swapped family', async () => {
    mode = 'old'
    expect((await probe()).v4).toEqual({ error: 'the feed answered HTTP 404' })
    mode = 'garbage'
    expect((await probe()).v4).toEqual({ error: 'the feed did not answer with an address' })
    // a private answer is never taken (only the test's own loopback feed address is allowed)
    mode = 'private'
    expect((await probe({ testAllow: (ip) => ip === '127.0.0.1' || ip === '::1' })).v4).toEqual({ error: 'the feed answered with an address that is not public' })
    // the other family than asked: reported as it is (learnExitAddresses counts it for neither)
    mode = 'swap'
    expect((await probe()).v4).toEqual({ ip: '2606:4700:3030:0000:0000:0000:6815:1001', family: 6 })
    mode = 'ok'
  })

  test('no IPv4 address on this machine: IPv4 has no route (nothing is sent over it); no global IPv6: the same for IPv6', async () => {
    seen.length = 0
    const r = await probe({ interfaces: V6ONLY })
    expect(r.v4).toEqual({ noRoute: 'no IPv4 address on this machine' })
    if (feed6) expect('ip' in r.v6).toBe(true)
    expect(seen.some((s) => s.family === 'IPv4')).toBe(false)
    expect((await probe({ interfaces: V4ONLY })).v6).toEqual({ noRoute: 'no IPv6 address on this machine' })
  })

  test('"no IPv4 route" only from the machine itself: an unreachable answer while an IPv4 default route exists is a failed round', async () => {
    // a router's or firewall's ICMP "network unreachable / prohibited" for the feed's IPv4 address (or a forged one)
    // gives the same ENETUNREACH as a machine without IPv4 routing; believing it would make the IPv6 answer enough while
    // every other IPv4 site leaves through the NAT'd address nobody learned
    const fails = (code: string) => (async (t: { family: 4 | 6 }) => {
      if (t.family === 4) throw new ToolError(`could not connect (${code})`)
      return { status: 200, headers: {}, body: Buffer.from(`${PUBLIC6}\n`), truncated: false }
    }) as never
    // the request is a stub: nothing connects (also where this machine has no IPv6 loopback)
    const both = async () => [{ address: '127.0.0.1', family: 4 }, { address: '::1', family: 6 }]
    for (const code of ['ENETUNREACH', 'EADDRNOTAVAIL']) {
      const withRoute = await probe({ lookup: both, request: fails(code), defaultRoute4: () => true })
      expect(withRoute.v4).toEqual({ error: `could not connect (${code})` })
      expect(withRoute.v6).toEqual({ ip: '2606:4700:3030:0000:0000:0000:6815:1001', family: 6 })
      const a = {}
      learnExitAddresses(a, withRoute)
      expect(egressOf(a).known).toBe(false)
      // cannot tell (not Linux, no /proc): the same, fail-safe
      expect((await probe({ lookup: both, request: fails(code), defaultRoute4: () => null })).v4).toEqual({ error: `could not connect (${code})` })
      // no IPv4 default route at all (an IPv6-only server with a Docker bridge): no route, IPv6 is enough
      const noRoute = await probe({ lookup: both, request: fails(code), defaultRoute4: () => false })
      expect(noRoute.v4).toEqual({ noRoute: `could not connect (${code})` })
      const b = {}
      learnExitAddresses(b, noRoute)
      expect(egressOf(b).known).toBe(true)
    }
    // no IPv4 in the kernel: no route whatever the table says
    expect((await probe({ lookup: both, request: fails('EAFNOSUPPORT'), defaultRoute4: () => true })).v4).toEqual({ noRoute: 'could not connect (EAFNOSUPPORT)' })
  })

  test('the IPv4 default route from /proc/net/route', () => {
    const head = 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n'
    const def = 'eth0\t00000000\t0101A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0\n'
    const lan = 'eth0\t0001A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0\n'
    const docker = 'docker0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0\n'
    expect(hasDefaultRoute4(head + def + lan)).toBe(true)
    expect(hasDefaultRoute4(head + lan + docker)).toBe(false)
    expect(hasDefaultRoute4(head)).toBe(false)
    // a default route that is down does not count
    expect(hasDefaultRoute4(head + def.replace('\t0003\t', '\t0002\t'))).toBe(false)
  })

  test('a feed name that does not resolve, or resolves to a private address, is not asked', async () => {
    seen.length = 0
    const fail = await probe({ lookup: async () => { throw Object.assign(new Error('stub'), { code: 'ENOTFOUND' }) } })
    expect(fail).toEqual({ v4: { error: 'could not resolve feed.test' }, v6: { error: 'could not resolve feed.test' } })
    // without the test's loopback allowance the same rules as web_fetch: loopback is not a public address
    const priv = await probe({ testAllow: undefined, url: 'https://feed.test/ip', lookup: async () => [{ address: '10.0.0.9', family: 4 }, { address: 'fd00::9', family: 6 }] })
    expect(priv.v4).toEqual({ error: 'feed.test has no usable IPv4 address' })
    expect(priv.v6).toEqual({ error: 'feed.test has no usable IPv6 address' })
    expect(seen).toEqual([])
    // plain http only for the test's feed
    expect((await probe({ testAllow: undefined })).v4).toEqual({ error: 'the feed must be https' })
  })
})

describe('what "known" means', () => {
  const ok4: ProbeResult['v4'] = { ip: PUBLIC4, family: 4 }
  const ok6: ProbeResult['v6'] = { ip: PUBLIC6, family: 6 }
  test('the IPv4 address, or the IPv6 one when this machine has no IPv4; every answer is refused by web_fetch', () => {
    const a = {}
    expect(egressOf(a)).toEqual({ known: false, ips: [] })
    learnExitAddresses(a, { v4: { error: 'x' }, v6: ok6 })
    // IPv6 alone is not enough while IPv4 may be NAT'd behind an unknown address
    expect(egressOf(a)).toEqual({ known: false, ips: ['2606:4700:3030:0000:0000:0000:6815:1001'] })
    learnExitAddresses(a, { v4: { noRoute: 'no IPv4 address on this machine' }, v6: ok6 })
    expect(egressOf(a).known).toBe(true)
    const b = {}
    learnExitAddresses(b, { v4: ok4, v6: { noRoute: 'x' } })
    expect(egressOf(b)).toEqual({ known: true, ips: [PUBLIC4] })
    // a swapped answer is refused like the rest but makes nothing known
    const c = {}
    learnExitAddresses(c, { v4: ok6, v6: { error: 'x' } })
    expect(egressOf(c)).toEqual({ known: false, ips: ['2606:4700:3030:0000:0000:0000:6815:1001'] })
    // the relay's report, as before
    noteEgressIp(c, '198.51.100.7')
    expect(egressOf(c).known).toBe(true)
  })

  test('MYCEL_EXIT_ADDRESS_CHECK=off turns the check off', () => {
    expect(exitAddressCheckOff({})).toBe(false)
    for (const v of ['off', 'OFF', '0', 'false', 'no']) expect(exitAddressCheckOff({ MYCEL_EXIT_ADDRESS_CHECK: v })).toBe(true)
    expect(exitAddressCheckOff({ MYCEL_EXIT_ADDRESS_CHECK: 'on' })).toBe(false)
  })
})

describe('the learner (startEgressLearning)', () => {
  const ctxWith = () => {
    const lines: Record<string, unknown>[] = []
    const closers: (() => void)[] = []
    return { lines, closers, ctx: { log: createLogger({ level: 'debug', sink: (l) => { try { lines.push(JSON.parse(l)) } catch {} } }), onClose: (f: () => void) => { closers.push(f) } } }
  }

  test('unknown first (one info line), asked again soon, then learned (one info line); then only every refresh', async () => {
    const { ctx, lines, closers } = ctxWith()
    const rounds: ProbeResult[] = [{ v4: { error: 'the feed answered HTTP 404' }, v6: { error: 'the feed answered HTTP 404' } }, { v4: { ip: PUBLIC4, family: 4 }, v6: { noRoute: 'x' } }]
    let calls = 0
    const stop = startEgressLearning(ctx, { probe: async () => rounds[Math.min(calls++, rounds.length - 1)]!, retryMs: [30], refreshMs: 60_000 })
    expect(await waitFor(() => egressOf(ctx).known, { timeoutMs: 3000 })).toBe(true)
    expect(calls).toBe(2)
    expect(lines.map((l) => [l.level, l.msg])).toEqual([
      ['info', 'exit address not known yet: every web address the AI opens needs a person until the server learns it'],
      ['info', 'exit address learned: web addresses the AI opens follow the normal rules']])
    expect(lines[0]).toMatchObject({ ipv4: 'the feed answered HTTP 404' })
    // the address itself is never logged
    expect(JSON.stringify(lines)).not.toContain(PUBLIC4)
    await Bun.sleep(150)
    expect(calls).toBe(2)
    expect(closers).toHaveLength(1)
    stop()
  })

  test('a server without internet: unknown, retried with back-off, one info line only', async () => {
    const { ctx, lines } = ctxWith()
    let calls = 0
    const stop = startEgressLearning(ctx, { probe: async () => { calls++; return { v4: { error: 'could not resolve updates.trina.app' }, v6: { error: 'could not resolve updates.trina.app' } } }, retryMs: [10, 20, 40] })
    expect(await waitFor(() => calls >= 4, { timeoutMs: 3000 })).toBe(true)
    stop()
    expect(egressOf(ctx).known).toBe(false)
    expect(lines.filter((l) => l.level === 'info')).toHaveLength(1)
    expect(lines.every((l) => l.level === 'info' || l.level === 'debug')).toBe(true)
  })

  test('web_fetch and the schedule card wait for the first round a moment (egressSettled), never longer than asked', async () => {
    const { ctx } = ctxWith()
    const stop = startEgressLearning(ctx, { probe: async () => { await Bun.sleep(80); return { v4: { ip: PUBLIC4, family: 4 }, v6: { noRoute: 'x' } } } })
    const t0 = Date.now()
    await egressSettled(ctx, 3000)
    expect(egressOf(ctx).known).toBe(true)
    expect(Date.now() - t0).toBeLessThan(2000)
    stop()
    const { ctx: slow } = ctxWith()
    const stop2 = startEgressLearning(slow, { probe: () => new Promise(() => {}) })
    const t1 = Date.now()
    await egressSettled(slow, 60)
    expect(Date.now() - t1).toBeLessThan(1000)
    expect(egressOf(slow).known).toBe(false)
    stop2()
    // no learner at all (dev, tests, the check off): nothing to wait for
    const t2 = Date.now()
    await egressSettled({}, 5000)
    expect(Date.now() - t2).toBeLessThan(100)
  })
})

// ---------------- on a team server: the gate, web_fetch, the schedule cards ----------------
const lookups: string[] = []
const original = dnsP.lookup
let h: Harness
beforeAll(async () => {
  ;(dnsP as unknown as { lookup: unknown }).lookup = async (n: string) => { lookups.push(n); throw Object.assign(new Error('stub: not resolved'), { code: 'ENOTFOUND' }) }
  h = await startHarness({ name: 'egress-learn', askUserTimeoutMs: 3000 })
})
afterAll(async () => {
  ;(dnsP as unknown as { lookup: unknown }).lookup = original
  await h?.close()
})

type Asked = { question: string; extra?: ConfirmExtra; options?: { label: string; value: string }[] }
function person(answer: string | null, asked: Asked[] = [], o: { unattended?: boolean; locale?: Locale } = {}): TurnPerson {
  return {
    locale: o.locale ?? 'en',
    async confirm(question, _a, _d, extra) { asked.push({ question, extra }); return answer === 'allow' || answer === 'create' },
    async choose(question, options, extra) { asked.push({ question, extra, options }); return answer },
    turnUrls: () => [],
    ...(o.unattended ? { unattended: true } : {}),
  }
}
async function chatWith(content: string) {
  const chat = await h.api('alice').call(API.createChat, { body: {} })
  const u = uuidv7(), a = uuidv7()
  h.ctx.db.query("INSERT INTO messages (id, chat_id, role, author_id, content, status) VALUES (?, ?, 'user', 'alice', ?, 'done')").run(u, chat.id, content)
  h.ctx.db.query("INSERT INTO messages (id, chat_id, parent_id, role, content, status, steps) VALUES (?, ?, ?, 'assistant', 'ok', 'done', '[]')").run(a, chat.id, u)
  return chat.id as string
}
function turnIn(chat: string): string {
  const id = uuidv7()
  h.ctx.db.query("INSERT INTO turns (id, chat_id, user_id, engine, status) VALUES (?, ?, 'alice', 'claude-code', 'running')").run(id, chat)
  return id
}
const call = (tool: string, args: Record<string, unknown>, turnId: string | null, p: TurnPerson | null) =>
  toolRegistry(h.ctx.files).call(tool, args, { user: h.ctx.files.principal('alice'), turnId, files: new TurnFiles(), ...(p ? { person: p } : {}) })
const day = () => new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10)
const TYPED = 'https://docs.example.org/guide'

describe('while this server does not know its exit address (fail-safe, as before)', () => {
  test('web_fetch asks even for an address the person typed, with wording for any server (no "office"); no lookup before the card', async () => {
    expect(egressOf(h.ctx).known).toBe(false)
    const chat = await chatWith(`please read ${TYPED}`)
    const asked: Asked[] = []
    lookups.length = 0
    const r = await call('web_fetch', { url: TYPED }, turnIn(chat), person(null, asked))
    expect(r.isError).toBe(true)
    expect(asked).toHaveLength(1)
    expect(asked[0]!.question).toContain('does not know its own public address yet')
    expect(asked[0]!.question).not.toMatch(/office/i)
    expect(lookups).toEqual([])
    // every language says it without the office
    for (const L of ['ko', 'id', 'ja', 'es'] as const) {
      const a: Asked[] = []
      await gateUrl(h.ctx.db, chat, TYPED, person(null, a, { locale: L }), { egressKnown: false }).catch(() => {})
      expect(a[0]!.question).not.toMatch(/사무실|kantor|オフィス|oficina/)
    }
  })

  test('a scheduled run: no card, the address stays closed, and the AI is told the real reason', async () => {
    const chat = await chatWith(`please read ${TYPED}`)
    const asked: Asked[] = []
    const r = await call('web_fetch', { url: TYPED }, turnIn(chat), person('allow', asked, { unattended: true }))
    expect(r.isError).toBe(true)
    expect(asked).toEqual([])
    expect(r.text).toContain('does not know its own public internet address yet')
    expect(r.text).toContain('nobody can confirm it here')
    expect(r.text).toContain('writing the address into a scheduled task does not change it')
    expect(lookups).toEqual([])
    // with the address known, a scheduled run's address that was never seen: "nobody can confirm", not "declined"
    const u = await gateUrl(h.ctx.db, chat, 'https://other.example.org/x', person('allow', asked, { unattended: true }), { egressKnown: true }).catch((e: Error) => e.message)
    expect(u).toContain('did not appear in the conversation and nobody can confirm it here')
    // a long query asks even for an address of the task: said as it is, not "did not appear"
    const longUrl = `${TYPED}?q=${'a'.repeat(250)}`
    const lq = await gateUrl(h.ctx.db, await chatWith(`please read ${longUrl}`), longUrl, person('allow', asked, { unattended: true }), { egressKnown: true }).catch((e: Error) => e.message)
    expect(lq).toContain('has a long query part')
    expect(lq).not.toContain('did not appear')
    expect(asked).toEqual([])
  })

  test('the schedule card says runs cannot open its addresses yet (create and "다시 확인"), in every language', async () => {
    const prompt = `Every morning read ${TYPED} and summarise it into users/alice/digest.md.`
    const asked: Asked[] = []
    const r = await call('schedule_create', { title: 'digest', prompt, repeat: 'once', time: '09:00', date: day() }, turnIn(await chatWith('make a task')), person('create', asked))
    expect(r.isError).toBeFalsy()
    expect(asked[0]!.question).toContain('runs cannot open the address below yet')
    expect(asked[0]!.question).not.toContain('On each run it opens')
    expect(asked[0]!.extra!.details![1]).toMatchObject({ label: 'Addresses in the instruction (runs cannot open them yet)', text: TYPED })
    expect(r.text).toContain('its runs cannot open the web addresses in the prompt until it does')
    // the addresses the card showed are still the task's: they open without a card once the server knows its address
    const row = h.ctx.db.query("SELECT allowed_urls FROM schedules WHERE user_id = 'alice' ORDER BY created_at DESC LIMIT 1").get() as { allowed_urls: string }
    expect(JSON.parse(row.allowed_urls)).toEqual([TYPED])
    // "다시 확인": a task nobody confirmed shows the same honest card
    const id = uuidv7()
    h.ctx.db.query(`INSERT INTO schedules (id, user_id, title, prompt, repeat, time, enabled, next_run_at) VALUES (?, 'alice', 'Old digest', ?, 'daily', '09:00', 0, ?)`).run(id, prompt, new Date(Date.now() + 86400_000).toISOString())
    const review = (await h.api('alice').call(API.getScheduleReview, { params: { id } })).request
    expect(review.question).toContain('made without its confirmation card')
    expect(review.question).toContain('runs cannot open the address below yet')
    // five languages, each different from the promise; one address in the singular (English, Spanish), two counted
    const input = { title: 't', prompt, repeat: 'daily' as const, time: '09:00' }
    const two = { ...input, prompt: `${prompt} Also read https://news.example.net/today.` }
    for (const L of ['ko', 'en', 'id', 'ja', 'es'] as const) {
      const shut = scheduleCard(input, [], L, 'create', { urlsOpen: false })
      const open = scheduleCard(input, [], L, 'create')
      expect(shut.question).toContain(SCHEDULE_TEXT.urlsBlockedOne[L])
      expect(shut.question).not.toContain(SCHEDULE_TEXT.urlsOne[L])
      expect(open.question).toContain(SCHEDULE_TEXT.urlsOne[L])
      expect(shut.extra.details![1]!.label).toBe(SCHEDULE_TEXT.labelUrlsBlocked[L])
      expect(shut.urls).toEqual(open.urls)
      expect(scheduleCard(two, [], L, 'create', { urlsOpen: false }).question).toContain(SCHEDULE_TEXT.urlsBlocked[L].replace('{n}', '2'))
      expect(scheduleCard(two, [], L, 'create').question).toContain(SCHEDULE_TEXT.urls[L].replace('{n}', '2'))
      for (const k of ['urlsOne', 'urlsBlockedOne'] as const) expect(SCHEDULE_TEXT[k][L]).not.toContain('{n}')
    }
    expect(SCHEDULE_TEXT.urlsOne.en).not.toMatch(/\b1 addresses|addresses below/)
    expect(SCHEDULE_TEXT.urlsBlockedOne.es).not.toMatch(/las 1|direcciones de abajo/)
    expect(SCHEDULE_TEXT.urlsBlocked.ko).toContain('실행 때 열 수 없어요')
  })
})

describe('once this server knows its exit address', () => {
  test('right after a start, web_fetch waits for the first round instead of asking: a typed address opens without a card', async () => {
    const chat = await chatWith(`please read ${TYPED}`)
    const asked: Asked[] = []
    startEgressLearning(h.ctx, { probe: async () => { await Bun.sleep(100); return { v4: { ip: PUBLIC4, family: 4 }, v6: { error: 'x' } } }, refreshMs: 600_000, retryMs: [600_000] })
    lookups.length = 0
    const r = await call('web_fetch', { url: TYPED }, turnIn(chat), person(null, asked))
    expect(asked).toEqual([])
    // past the gate, the name is looked up (the stub does not resolve it)
    expect(r.text).toContain('could not resolve docs.example.org')
    expect(lookups).toEqual(['docs.example.org'])
    expect(egressOf(h.ctx).ips).toContain(PUBLIC4)
  })

  test('the learned address itself is refused, like the office address the relay reports', async () => {
    const chat = await chatWith(`see http://${PUBLIC4}/admin`)
    const r = await call('web_fetch', { url: `http://${PUBLIC4}/admin` }, turnIn(chat), person('allow'))
    expect(r.isError).toBe(true)
    expect(r.text).toContain("this server's own public address")
    expect(r.text).not.toMatch(/office/i)
  })

  test('the schedule card promises unattended opens again, and the link budget applies (no card for a typed address)', async () => {
    const prompt = `Read ${TYPED} and summarise it.`
    const asked: Asked[] = []
    const r = await call('schedule_create', { title: 'digest 2', prompt, repeat: 'once', time: '09:00', date: day() }, turnIn(await chatWith('make a task')), person('create', asked))
    expect(r.isError).toBeFalsy()
    expect(asked[0]!.question).toContain('On each run it opens the address below without asking')
    expect(asked[0]!.extra!.details![1]!.label).toBe('Addresses opened without asking on each run')
    expect(r.text).not.toContain('cannot open')
    const chat = await chatWith(`please read ${TYPED}`)
    expect(await gateUrl(h.ctx.db, chat, TYPED, null, { egressKnown: egressOf(h.ctx).known })).toBe('seen')
  })
})
