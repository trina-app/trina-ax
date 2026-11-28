// A team file for an app on the person's computer (docs/decisions/20261128-local-app-team-file-links.md): which handles
// a call names, how they are swapped for one-time links and back, and the links themselves (one download, the turn's
// end, the time limit, the check again before the bytes go). The whole call through a chat: c-local-apps-shared.test.ts.
import { describe, expect, test } from 'bun:test'
import { linkBase, linkResponse, LINK_TTL_MS, LocalFileLinks, LINKS_MAX_PENDING_BYTES, localTeamFiles, typeOf, unlinked, withLinks } from '../../server/src/integrations/connections/local-file-links'

const content = (k: string | null) => k === 'content'

describe('the handles a call to an app on the computer names', () => {
  test('in quotes inside code or a task: a link each (all three quote kinds)', () => {
    const code = `const a = await fetch("team-file:shared/q.pdf"); const b = await fetch('team-file:shared/견적서 v2.pdf'); const c = \`team-file:x/y.txt\``
    expect(localTeamFiles({ code }, content)).toEqual({ content: [], links: ['team-file:shared/q.pdf', 'team-file:shared/견적서 v2.pdf', 'team-file:x/y.txt'], loose: false })
    expect(localTeamFiles({ prompt: 'Download "team-file:shared/q.pdf" and attach it to the draft' }, content).links).toEqual(['team-file:shared/q.pdf'])
  })
  test('a whole value: base64 where the tool takes a file\'s content, else a link', () => {
    expect(localTeamFiles({ content: 'team-file:a.pdf', url: 'team-file:b.pdf', opts: { command: ['team-file:c.pdf'] } }, content))
      .toEqual({ content: ['team-file:a.pdf'], links: ['team-file:b.pdf', 'team-file:c.pdf'], loose: false })
  })
  test('in the middle of a text without quotes: loose (where it ends cannot be told)', () => {
    expect(localTeamFiles({ code: 'fetch(team-file:shared/q.pdf)' }, content).loose).toBe(true)
    expect(localTeamFiles({ code: 'fetch("team-file:shared/q.pdf"); x = team-file:b' }, content).loose).toBe(true)
    expect(localTeamFiles({ code: 'no handle here' }, content)).toEqual({ content: [], links: [], loose: false })
  })
  test('a backslash or a template expression in a quoted path: loose (the swapped code would not be the code on the card)', () => {
    // "team-file:a\"; evil(); \"" is one string in JavaScript; swapping "team-file:a\" alone would make evil() code
    expect(localTeamFiles({ code: 'x = "team-file:a\\"; evil(); \""' }, content).loose).toBe(true)
    expect(localTeamFiles({ code: 'x = `team-file:${evil()}`' }, content).loose).toBe(true)
    expect(localTeamFiles({ code: 'x = "team-file:shared/$5 price.pdf"' }, content).links).toEqual(['team-file:shared/$5 price.pdf'])
  })
  test('the same handle twice is one file (one link put in every place)', () => {
    expect(localTeamFiles({ code: '// "team-file:a.pdf"\nconst r = await fetch("team-file:a.pdf")', url: 'team-file:a.pdf' }, content).links).toEqual(['team-file:a.pdf'])
  })
})

describe('links in and out', () => {
  const urls = new Map([['team-file:shared/q.pdf', 'https://t.example/team-file-links/AAA'], ['team-file:b.pdf', 'https://t.example/team-file-links/BBB']])
  test('each handle becomes its address, in quotes and as a whole value; content handles stay for the base64 swap', () => {
    const args = { code: 'await fetch("team-file:shared/q.pdf")', url: 'team-file:b.pdf', content: 'team-file:b.pdf' }
    expect(withLinks(args, urls, content)).toEqual({ code: 'await fetch("https://t.example/team-file-links/AAA")', url: 'https://t.example/team-file-links/BBB', content: 'team-file:b.pdf' })
  })
  test('a token written another way (another host, inside an error) is masked too', () => {
    const t = 'A'.repeat(43)
    const m = new Map([['team-file:q.pdf', `https://t.example/team-file-links/${t}`]])
    expect(unlinked(`fetch failed: http://127.0.0.1:8080/team-file-links/${t}`, m)).toBe('fetch failed: http://127.0.0.1:8080/team-file-links/***')
  })
  test('the answer gets each handle back in place of its address', () => {
    const answer = { content: [{ type: 'text', text: 'saved 200 from https://t.example/team-file-links/AAA and https://t.example/team-file-links/AAA' }], structuredContent: { u: ['https://t.example/team-file-links/BBB'] } }
    expect(unlinked(answer, urls)).toEqual({ content: [{ type: 'text', text: 'saved 200 from team-file:shared/q.pdf and team-file:shared/q.pdf' }], structuredContent: { u: ['team-file:b.pdf'] } })
    expect(unlinked(answer, new Map())).toBe(answer)
  })
})

describe('the links', () => {
  const file = (o: Partial<Parameters<LocalFileLinks['issue']>[0][number]> = {}) => ({ userId: 'alice', rel: 'shared/q.pdf', name: 'q.pdf', bytes: Buffer.from('%PDF-1.4'), sha256: 'ab'.repeat(32), recheck: () => true, ...o })
  test('one download each; then the same nothing as an unknown one', () => {
    const l = new LocalFileLinks()
    const [t] = l.issue([file()], 'turn-1')!
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(l.take(t!)?.bytes.toString()).toBe('%PDF-1.4')
    expect(l.take(t!)).toBeNull()
    expect(l.take('x'.repeat(43))).toBeNull()
    expect(l.pendingBytes).toBe(0)
  })
  test('gone after the time limit, and when the turn ends', () => {
    let now = 1000
    const l = new LocalFileLinks(() => now)
    const [t] = l.issue([file()], 'turn-1')!
    now += LINK_TTL_MS
    expect(l.take(t!)).toBeNull()
    // the turn's end (LocalRelay.cancelTurn, on every end of a turn, a normal one included): only that turn's links go
    const [u] = l.issue([file()], 'turn-2')!
    const [v] = l.issue([file()], 'turn-3')!
    l.endTurn('turn-2')
    expect(l.take(u!)).toBeNull()
    expect(l.take(v!)).not.toBeNull()
    expect(l.pendingBytes).toBe(0)
  })
  test('checked again before the bytes go: a failed check (access gone, file changed, held) gives nothing', () => {
    const l = new LocalFileLinks()
    const [a, b] = l.issue([file({ recheck: () => false }), file({ recheck: () => { throw new Error('denied') } })], 'turn-1')!
    expect(l.take(a!)).toBeNull()
    expect(l.take(b!)).toBeNull()
  })
  test('a HEAD (or any other method) uses nothing up', () => {
    const l = new LocalFileLinks()
    const [t] = l.issue([file()], 'turn-1')!
    for (const method of ['HEAD', 'POST', 'DELETE']) expect(linkResponse({} as never, l, new Request(`https://t.example/team-file-links/${t}`, { method }), t!).status).toBe(405)
    expect(l.take(t!)).not.toBeNull()
  })
  test('the server-wide cap: a call over it gets no links at all', () => {
    const l = new LocalFileLinks()
    expect(l.issue([file({ bytes: Buffer.alloc(LINKS_MAX_PENDING_BYTES + 1) })], 'turn-1')).toBeNull()
    expect(l.pendingBytes).toBe(0)
  })
  test('the address: the window\'s team page origin, else the first public origin; never one with a user name', () => {
    const cfg = (publicOrigins: string[]) => ({ config: { publicOrigins } }) as unknown as Parameters<typeof linkBase>[0]
    expect(linkBase(cfg(['https://pub.example']), 'https://team.example:8443')).toBe('https://team.example:8443')
    expect(linkBase(cfg(['https://pub.example/x']), null)).toBe('https://pub.example')
    expect(linkBase(cfg(['https://u:p@pub.example', 'ftp://x']), null)).toBeNull()
  })
  test('the type a file field shows', () => {
    expect(typeOf('견적서.PDF')).toBe('application/pdf')
    expect(typeOf('noext')).toBe('application/octet-stream')
  })
})
