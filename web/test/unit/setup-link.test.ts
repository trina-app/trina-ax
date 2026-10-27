// The first-run setup link (control-plane SV-7): the token comes from the fragment (#token=…, never in a server log or
// a Referer) or the old ?token=, the team name and language prefill the form, and every one of them leaves the address
// bar (the page puts back a clean address).
import { describe, expect, test } from 'bun:test'
import { sourceCodeLink } from '@mycel/shared'
import { readSetupLink } from '../../src/lib/setupLink'

const loc = (href: string) => { const u = new URL(href, 'https://acme.treesoop.com'); return { pathname: u.pathname, search: u.search, hash: u.hash } }

describe('setup link', () => {
  test('fragment: token, team and language read; the clean address has none of them', () => {
    const l = readSetupLink(loc('/setup#token=AbC_123-xyzAbC_123-xyz12&team=%EC%B9%98%EA%B3%BC%20%EC%9D%98%EC%9B%90&lang=ko'))
    expect(l).toEqual({ token: 'AbC_123-xyzAbC_123-xyz12', team: '치과 의원', lang: 'ko', cleanUrl: '/setup' })
  })
  test('the installer\'s ?token= still works, and is removed too; other query parts stay', () => {
    expect(readSetupLink(loc('/setup?token=t0k3n&x=1'))).toEqual({ token: 't0k3n', team: null, lang: null, cleanUrl: '/setup?x=1' })
  })
  test('the fragment wins over the query; unknown languages are ignored', () => {
    const l = readSetupLink(loc('/setup?token=old#token=new&lang=fr'))
    expect([l.token, l.lang, l.cleanUrl]).toEqual(['new', null, '/setup'])
  })
  test('nothing to read: nothing to clean', () => {
    expect(readSetupLink(loc('/setup'))).toEqual({ token: null, team: null, lang: null, cleanUrl: null })
    expect(readSetupLink(loc('/setup#other=1')).cleanUrl).toBeNull()
  })
  test('empty or overlong values', () => {
    const l = readSetupLink(loc(`/setup#token=&team=${'a'.repeat(300)}`))
    expect(l.token).toBeNull()
    expect(l.team?.length).toBe(100)
    expect(l.cleanUrl).toBe('/setup')
  })
})

describe('source code link (AGPL-3.0, SV-8)', () => {
  test('a mail request while the repository is not public; the version tag once it is', () => {
    const req = sourceCodeLink('0.3.1')
    expect(req.kind).toBe('request')
    expect(req.href).toStartWith('mailto:')
    expect(decodeURIComponent(req.href)).toContain('version 0.3.1')
    const pub = sourceCodeLink('0.3.1', { repository: 'https://github.com/o/r', published: true, requestEmail: 'x@y' })
    expect(pub).toEqual({ href: 'https://github.com/o/r/tree/v0.3.1', kind: 'tag' })
    expect(sourceCodeLink(null, { repository: 'https://github.com/o/r', published: true, requestEmail: 'x@y' }).href).toBe('https://github.com/o/r')
    expect(sourceCodeLink('1.0.0"><script>', { repository: 'https://github.com/o/r', published: true, requestEmail: 'x@y' }).href).toBe('https://github.com/o/r')
  })
})
