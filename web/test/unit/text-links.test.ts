// Web addresses in a person's words in a room (lib/textLinks.ts): where an address starts and ends in chat text, that
// only http(s) and "www." become links, and that the parts always put the text back together as it was.
import { expect, test } from 'bun:test'
import { addressPieces, linkHref, linkParts, type LinkPart } from '../../src/lib/textLinks'

/** the addresses found, as written */
const links = (text: string, o?: { cut?: boolean }) => linkParts(text, o).filter((p) => p.href).map((p) => p.text)
const whole = (parts: LinkPart[]) => parts.map((p) => p.text).join('')

test('an address in the middle of a sentence; the rest stays text, and the parts are the text', () => {
  const text = 'https://claude.ai/artifact/7A3N9vnbqnmBQiAeRtBPCx this one report for the team'
  const parts = linkParts(text)
  expect(parts).toEqual([
    { text: 'https://claude.ai/artifact/7A3N9vnbqnmBQiAeRtBPCx', href: 'https://claude.ai/artifact/7A3N9vnbqnmBQiAeRtBPCx' },
    { text: ' this one report for the team' },
  ])
  expect(whole(parts)).toBe(text)
  expect(linkParts('no address here')).toEqual([{ text: 'no address here' }])
  expect(linkParts('')).toEqual([])
})

test('http and www. are links too; www. opens as https; upper case schemes count', () => {
  expect(linkParts('see www.example.com now')).toEqual([{ text: 'see ' }, { text: 'www.example.com', href: 'https://www.example.com/' }, { text: ' now' }])
  expect(linkParts('http://intranet.example.com:8080/a')[0]).toEqual({ text: 'http://intranet.example.com:8080/a', href: 'http://intranet.example.com:8080/a' })
  expect(links('HTTPS://EXAMPLE.COM/Path')).toEqual(['HTTPS://EXAMPLE.COM/Path'])
  expect(links('two: https://a.example.com and https://b.example.com/x')).toEqual(['https://a.example.com', 'https://b.example.com/x'])
  expect(links('line one\nhttps://example.com/a\nline three')).toEqual(['https://example.com/a'])
})

test("the sentence's punctuation is not part of the address", () => {
  expect(links('look: https://example.com/a.')).toEqual(['https://example.com/a'])
  expect(links('https://example.com/a, https://example.com/b; https://example.com/c!')).toEqual(['https://example.com/a', 'https://example.com/b', 'https://example.com/c'])
  expect(links('really https://example.com/a?')).toEqual(['https://example.com/a'])
  expect(links('end https://example.com/a?b=1...')).toEqual(['https://example.com/a?b=1'])
  expect(links("'https://example.com/a'")).toEqual(['https://example.com/a'])
  expect(links('"https://example.com/a"')).toEqual(['https://example.com/a'])
  expect(links('*https://example.com/a*')).toEqual(['https://example.com/a'])
})

test('brackets: a closing one the address never opened comes off, its own stays', () => {
  expect(links('(see https://example.com/a)')).toEqual(['https://example.com/a'])
  expect(links('[https://example.com/a]')).toEqual(['https://example.com/a'])
  expect(links('{https://example.com/a}')).toEqual(['https://example.com/a'])
  expect(links('<https://example.com/a>')).toEqual(['https://example.com/a'])
  expect(links('https://en.wikipedia.org/wiki/Bun_(software)')).toEqual(['https://en.wikipedia.org/wiki/Bun_(software)'])
  expect(links('(https://en.wikipedia.org/wiki/Bun_(software))')).toEqual(['https://en.wikipedia.org/wiki/Bun_(software)'])
  expect(links('(https://en.wikipedia.org/wiki/Bun_(software)).')).toEqual(['https://en.wikipedia.org/wiki/Bun_(software)'])
})

test('Korean, Japanese and full-width text right after an address ends it', () => {
  expect(linkParts('https://example.com/a에서 확인해 주세요')).toEqual([{ text: 'https://example.com/a', href: 'https://example.com/a' }, { text: '에서 확인해 주세요' }])
  expect(links('자료는 https://example.com/report를 보세요')).toEqual(['https://example.com/report'])
  expect(links('여기https://example.com/a')).toEqual(['https://example.com/a'])
  expect(links('https://example.com/a。次へ')).toEqual(['https://example.com/a'])
  expect(links('https://example.com/a、https://example.com/b')).toEqual(['https://example.com/a', 'https://example.com/b'])
  expect(links('（https://example.com/a）')).toEqual(['https://example.com/a'])
  expect(links('「https://example.com/a」')).toEqual(['https://example.com/a'])
  expect(links('https://example.com/a！')).toEqual(['https://example.com/a'])
  expect(links('“https://example.com/a”')).toEqual(['https://example.com/a'])
  expect(links('«https://example.com/a»')).toEqual(['https://example.com/a'])
  expect(links('https://example.com/a…')).toEqual(['https://example.com/a'])
  expect(links('https://example.com/a👍')).toEqual(['https://example.com/a'])
  expect(links('https://example.com/a✅')).toEqual(['https://example.com/a'])
  expect(links('https://example.com/a\u200bb')).toEqual(['https://example.com/a'])
})

test('only http and https become links: no other scheme, no user name or password, no empty host', () => {
  for (const text of [
    'javascript:alert(1)',
    'javascript://example.com/%0Aalert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'mailto:ben@example.com',
    'ftp://example.com/a',
    'trina://open',
    'vbscript:msgbox(1)',
    'https://',
    'https://.',
    'http:///a',
    'www.',
    'www.example',
    'https://user:pass@example.com/a',
    'https://bank.example.com@evil.example/login',
    'xhttps://example.com',
    'foo.www.example.com',
    'ben@www.example.com',
    '/rooms/abc',
  ])
    expect([text, links(text)]).toEqual([text, []])
  // an address inside another one is not a second link
  expect(links('https://example.com/r?to=https://example.org/x')).toEqual(['https://example.com/r?to=https://example.org/x'])
  expect(links('https://example.com/www.example.org')).toEqual(['https://example.com/www.example.org'])
  // a backslash ends it (a browser reads it as a slash: "https://evil.example\\.example.com" opens evil.example)
  expect(links('https://evil.example\\.example.com/a')).toEqual(['https://evil.example'])
  // what is opened is the parsed address, never the raw text
  expect(linkHref('https://example.com/a b')).toBe('https://example.com/a%20b')
  expect(linkHref('JavaScript:alert(1)')).toBeNull()
  expect(linkHref('https://example.com/"><script>')).toBe('https://example.com/%22%3E%3Cscript%3E')
})

test('HTML in the text is never an address and stays text', () => {
  const text = '<a href="javascript:alert(1)">https://example.com/a</a>'
  expect(links(text)).toEqual(['https://example.com/a'])
  expect(whole(linkParts(text))).toBe(text)
  expect(links('<img src=x onerror=alert(1)>')).toEqual([])
})

test('a quote cut short with "…": the address that runs into it stays text, the ones before it are links', () => {
  expect(links('see https://example.com/very/long/addre…', { cut: true })).toEqual([])
  expect(links('see https://example.com/a and then more words…', { cut: true })).toEqual(['https://example.com/a'])
  // not cut: the same text links the address
  expect(links('see https://example.com/very/long/addre…')).toEqual(['https://example.com/very/long/addre'])
})

test('a long address breaks after its slashes and before ? # &', () => {
  expect(addressPieces('https://claude.ai/artifact/7A3N9vnbqnmBQiAeRtBPCx')).toEqual(['https://', 'claude.ai/', 'artifact/', '7A3N9vnbqnmBQiAeRtBPCx'])
  expect(addressPieces('https://example.com/a?b=1&c=2#d')).toEqual(['https://', 'example.com/', 'a', '?b=1', '&c=2', '#d'])
  expect(addressPieces('www.example.com').join('')).toBe('www.example.com')
})
