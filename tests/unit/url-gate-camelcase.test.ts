// The address card for public API addresses with camelCase parameter names and a long query
// (docs/decisions/20261120-url-gate-camelcase-params.md). The owner saw two cards for two public Hacker News search
// addresses: opaqueParts marked "attributesToRetrieve" and "attributesToHighlight" as random-looking, so neither a site
// allowance (①b) nor "Allow all websites" (①d) covered them (their queries are 173 and 132 characters, under ③'s 200).
// Now camelCase words are not marks, and in a turn the person watches ①b and ①d also cover a plain address with a query
// over 200 characters (HN_LONGER: the same search with one more parameter).
// What still asks: real tokens (base64, base32, hex, keys, random letters), echoes, user names, long names before the
// site, typed addresses with a long query, and every long query in a run nobody watches.
// Every DNS lookup is a stub (node:dns/promises lookup replaced for this file): nothing resolves or opens a real name.
import dnsP from 'node:dns/promises'
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API } from '@mycel/shared/api'
import { ALL_SITES_ANSWER, uuidv7 } from '@mycel/shared'
import { startHarness, type Harness } from '../lib/b-harness'
import { noteEgressIp } from '../../server/src/tools/egress'
import { gateUrl, MAX_UNCONFIRMED_QUERY, opaqueParts, rememberUrls, type ConfirmExtra, type TurnPerson } from '../../server/src/tools/url-gate'
import { recordSent, webEcho } from '../../server/src/tools/connection-urls'
import { updateTeamSettings } from '../../server/src/admin/settings'
import { setWebAllowAll } from '../../server/src/tools/web-allow-all'

setDefaultTimeout(60_000)

/** the two addresses the owner saw (2026-11-20) */
const HN_LONG = 'https://hn.algolia.com/api/v1/search?tags=show_hn&numericFilters=created_at_i%3E1794555000&hitsPerPage=15&attributesToRetrieve=title,url,points,num_comments,created_at,objectID,author&attributesToHighlight=none'
const HN_SHORT = 'https://hn.algolia.com/api/v1/search?tags=show_hn&hitsPerPage=15&attributesToRetrieve=title,url,points,num_comments,created_at,objectID,author&attributesToHighlight=none'
/** the same search with one more parameter: a query over MAX_UNCONFIRMED_QUERY */
const HN_LONGER = `${HN_LONG}&restrictSearchableAttributes=title,url`

/** real API parameter and identifier names of 20 letters or more (shorter ones are never looked at) */
const NAMES = [
  'attributesToRetrieve', 'attributesToHighlight', 'restrictSearchableAttributes', 'includeGrantedScopes', 'supportsAllDrives',
  'includeItemsFromAllDrives', 'responseContentDisposition', 'maxResultsPerPage', 'returnFaceAttributes', 'createdAtGreaterThan',
  'ExclusiveStartKey', 'parseHTMLResponseBody', 'isAValueThatIsLongEnough', 'AWSAccessKeyIdentifier', 'prefersColorSchemeDark',
  'includeSpamTrashMessages', 'orderByLastModifiedTime', 'getAllProjectsForCurrentUser', 'XMLHttpRequestUpload',
  'getElementsByClassName', 'enableHighAccuracyLocation', 'ResponseContentLanguage', 'showDeletedConversations',
]
/** random-looking parts that must stay marked: base64 (also without digits), base32, hex, a JWT, keys, random letters */
const TOKENS = [
  'QmFzZTY0IGVuY29kZWQgdGV4dA', 'ZGF0YS1oZXJlLXNlY3JldA', 'SGVsbG9Xb3JsZFRoaXNJc0FTZWNyZXQ', 'dGhpc2lzYXNlY3JldHZhbHVl',
  'QWxhZGRpbjpvcGVuIHNlc2FtZQ', 'TWFuIGlzIGRpc3Rpbmd1aXNoZWQ', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
  'JBSWY3DPEHPK3PXPJBSWY3DP', 'c2fsyxj5ltk4nzy1ndmy', '5f2b8e9a1c3d4e6f7a8b9c0d', 'AKIAIOSFODNN7EXAMPLE',
  'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY', 'aZ3kQ9xY7mN2pL5wR8tV', 'xKqWzPbNvLmTrYcHdJsF', 'abcDEFghiJKLmnoPQRst',
  'aB3dE5fG7hJ9kL1mN3pQ5rT', 'QZXKWPRTMBVNHJGFDSLCHello', 'helloQZXKWPRTMBVNHJGFDSLCWorld',
]

describe('opaqueParts: camelCase words are not random-looking', () => {
  test('the two addresses the owner saw have no marks', () => {
    for (const u of [HN_LONG, HN_SHORT, HN_LONGER]) expect(opaqueParts(decodeURIComponent(u).replace(/^https?:\/\//, ''))).toEqual([])
    expect([HN_LONG, HN_SHORT].map((u) => new URL(u).search.slice(1).length)).toEqual([173, 132])
    expect(new URL(HN_LONGER).search.slice(1).length).toBeGreaterThan(MAX_UNCONFIRMED_QUERY)
  })

  test('real camelCase and PascalCase names are not marked', () => {
    for (const n of NAMES) expect([n, opaqueParts(n)]).toEqual([n, []])
    expect(opaqueParts(`https://api.example/v1?${NAMES.map((n) => `${n}=1`).join('&')}`)).toEqual([])
  })

  test('tokens are still marked, also next to camelCase names', () => {
    for (const t of TOKENS) expect([t, opaqueParts(t)]).toEqual([t, [t]])
    expect(opaqueParts('https://x.example/?attributesToRetrieve=title&key=QmFzZTY0IGVuY29kZWQgdGV4dA')).toEqual(['QmFzZTY0IGVuY29kZWQgdGV4dA'])
  })

  test('random mixed-case letters: fewer than 1 in 100 read as words', () => {
    // a fixed generator (xorshift), so the count is the same on every run
    let x = 0x2545f491
    const next = () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 2 ** 32 }
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
    let tried = 0, passed = 0
    while (tried < 20_000) {
      let s = ''
      const n = 20 + Math.floor(next() * 21)
      for (let i = 0; i < n; i++) s += A[Math.floor(next() * 52)]
      if (!/[a-z]/.test(s) || !/[A-Z]/.test(s)) continue
      tried++
      if (!opaqueParts(s).length) passed++
    }
    expect(passed / tried).toBeLessThan(0.01)
  })
})

const lookups: string[] = []
const original = dnsP.lookup
;(dnsP as unknown as { lookup: unknown }).lookup = async (host: string) => {
  lookups.push(host.toLowerCase())
  throw Object.assign(new Error('stub: not resolved'), { code: 'ENOTFOUND' })
}

let h: Harness
beforeAll(async () => {
  h = await startHarness({ name: 'url-gate-camelcase', askUserTimeoutMs: 4000, stallTimeoutMs: 60_000 })
  noteEgressIp(h.ctx, '198.51.100.7')
})
afterAll(async () => {
  ;(dnsP as unknown as { lookup: unknown }).lookup = original
  await h?.close()
})
const db = () => h.ctx.db
beforeEach(() => {
  updateTeamSettings(db(), { browserAllowAll: true, webAllowAll: true })
  setWebAllowAll(db(), 'alice', false, { via: 'settings' })
  // a site allowed in one test is for good: every test starts without it
  db().query('DELETE FROM user_allowed_sites').run()
})

type Asked = { question: string; options?: { label: string; value: string }[]; extra?: ConfirmExtra }
function person(answer: string | null, asked: Asked[] = [], o: { unattended?: boolean } = {}): TurnPerson {
  return {
    locale: 'ko',
    async confirm(question, _a, _d, extra) { asked.push({ question, extra }); return answer === 'allow' },
    async choose(question, options, extra) { asked.push({ question, options, extra }); return answer },
    turnUrls: () => [],
    allSitesHere: () => true,
    // a turn the person asks from their app: their sites for good count and may be kept (chat/tools.ts turnPerson)
    sitesForGood: () => !o.unattended,
    ...(o.unattended ? { unattended: true } : {}),
  }
}
async function chatOf(content = 'Show HN 최근 글 찾아 줘') {
  const chat = await h.api('alice').call(API.createChat, { body: {} })
  db().query("INSERT INTO messages (id, chat_id, role, author_id, content, status) VALUES (?, ?, 'user', 'alice', ?, 'done')").run(uuidv7(), chat.id, content)
  return chat.id as string
}
const gate = (chat: string, url: string, p: TurnPerson | null, o: { egressKnown?: boolean } = {}) =>
  gateUrl(db(), chat, url, p, { turnId: 't-camel', userId: 'alice', ...o })
const values = (a: Asked | undefined) => a?.options?.map((x) => x.value)

describe('the gate with the owner\'s two addresses', () => {
  test('Allow all websites on: both open without a card', async () => {
    expect(setWebAllowAll(db(), 'alice', true, { via: 'settings' })).toBe(true)
    const chat = await chatOf()
    const asked: Asked[] = []
    expect(await gate(chat, HN_SHORT, person(null, asked))).toBe('all')
    expect(await gate(chat, HN_LONG, person(null, asked))).toBe('all')
    expect(await gate(chat, HN_LONGER, person(null, asked))).toBe('all')
    // also while the server's exit address is unknown (only ①d opens then)
    expect(await gate(chat, HN_LONGER, person(null, asked), { egressKnown: false })).toBe('all')
    expect(asked).toHaveLength(0)
  })

  test('off: the first card offers the site and Allow all websites, with nothing highlighted; the site then covers all', async () => {
    const chat = await chatOf()
    const asked: Asked[] = []
    expect(await gate(chat, HN_LONG, person('site', asked))).toBe('confirmed')
    expect(values(asked[0])).toEqual(['allow', 'site', ALL_SITES_ANSWER, 'deny'])
    expect(asked[0]!.extra).toBeUndefined()
    expect(asked[0]!.question).not.toContain('알아보기 어려운 긴 글자가 있어요')
    expect(await gate(chat, HN_SHORT, person(null, asked))).toBe('site')
    expect(await gate(chat, HN_LONGER, person(null, asked))).toBe('site')
    expect(asked).toHaveLength(1)
  })

  test('a long query on its first card: the card says so and offers the site and Allow all websites', async () => {
    const chat = await chatOf()
    const asked: Asked[] = []
    expect(await gate(chat, HN_LONGER, person('site', asked))).toBe('confirmed')
    expect(asked[0]!.question).toContain('긴 내용이 붙어 있어요')
    expect(values(asked[0])).toEqual(['allow', 'site', ALL_SITES_ANSWER, 'deny'])
    // a long query is never remembered as allowed: the next one opens by the site allowance, not as a seen address
    expect(await gate(chat, HN_LONGER, person(null, asked))).toBe('site')
    expect(asked).toHaveLength(1)
  })

  test('what still asks with a long query: a token in it, a user name, a run nobody watches, a typed address', async () => {
    expect(setWebAllowAll(db(), 'alice', true, { via: 'settings' })).toBe(true)
    const chat = await chatOf()
    // a random-looking part: the card, highlighted, no allowance offered
    const leak = `${HN_LONGER}&k=QmFzZTY0IGVuY29kZWQgdGV4dA`
    const asked: Asked[] = []
    await expect(gate(chat, leak, person(null, asked))).rejects.toThrow(/did not allow/)
    expect(asked[0]!.extra!.details![0]!.marks).toEqual(['QmFzZTY0IGVuY29kZWQgdGV4dA'])
    expect(asked[0]!.options).toBeUndefined()
    // a user name: never covered
    await expect(gate(chat, HN_LONGER.replace('https://', 'https://me:pw@'), person(null, asked))).rejects.toThrow(/did not allow/)
    expect(asked).toHaveLength(2)
    // a scheduled run: never opened, the switch does not reach it
    await expect(gate(chat, HN_LONGER, person(null, asked, { unattended: true }))).rejects.toThrow(/long query part/)
    await expect(gate(chat, HN_LONGER, null)).rejects.toThrow(/long query part/)
    // the short one opens there only as before (it is neither typed nor learned here)
    await expect(gate(chat, HN_SHORT, person(null, asked, { unattended: true }))).rejects.toThrow(/did not appear/)
    // typed by the person with a long query: still one card (③ for ① addresses is unchanged), when the switch is off
    setWebAllowAll(db(), 'alice', false, { via: 'settings' })
    const typed = await chatOf(`이거 열어 줘 ${HN_LONGER}`)
    const t: Asked[] = []
    expect(await gate(typed, HN_LONGER, person('allow', t))).toBe('confirmed')
    expect(t).toHaveLength(1)
    expect(t[0]!.question).toContain('긴 내용이 붙어 있어요')
    expect(lookups).toEqual([])
  })

  test('Allow all websites on: an echoed long plain query still asks, without the site or Allow-all answers', async () => {
    expect(setWebAllowAll(db(), 'alice', true, { via: 'settings' })).toBe(true)
    const chat = await chatOf()
    // the AI sent this address to a tool, then a search result repeated it: an echo, however plain it reads
    recordSent(db(), chat, { url: HN_LONGER })
    rememberUrls(db(), chat, [HN_LONGER], 'search', webEcho(db(), chat))
    const asked: Asked[] = []
    await expect(gate(chat, HN_LONGER, person('site', asked))).rejects.toThrow(/did not allow/)
    expect(asked).toHaveLength(1)
    expect(asked[0]!.question).toContain('앞서 보낸 내용')
    expect(values(asked[0]) ?? []).not.toContain('site')
    expect(values(asked[0]) ?? []).not.toContain(ALL_SITES_ANSWER)
  })

  test('Allow all websites on: a long name before the site with a long plain query still asks, without those answers', async () => {
    expect(setWebAllowAll(db(), 'alice', true, { via: 'settings' })).toBe(true)
    const chat = await chatOf()
    const url = `https://abcdefghijklmnopqrstu.x.example/?q=${'a'.repeat(201)}`
    const asked: Asked[] = []
    await expect(gate(chat, url, person('site', asked))).rejects.toThrow(/did not allow/)
    expect(asked).toHaveLength(1)
    expect(asked[0]!.extra!.details![0]!.marks).toContain('abcdefghijklmnopqrstu')
    expect(values(asked[0]) ?? []).not.toContain('site')
    expect(values(asked[0]) ?? []).not.toContain(ALL_SITES_ANSWER)
  })
})
