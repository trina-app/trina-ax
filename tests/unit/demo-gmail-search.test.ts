// The demo's fake Gmail search (server/src/demo/fakes/gmail.ts) on the free-roam snapshot's mailboxes
// (scripts/demo/steepling/make.ts), with the queries an AI sends for "Did Chris reply?" / "크리스 답장 왔어?". QA TC-6712:
// in Korean, `from:크리스님` (the chip says "크리스님이"), `from:"Chris Walker"` and `from:크리스 OR from:Chris` found
// nothing, so Trina said Chris had not written. Fake data only.
import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FakeGmail, parseQuery } from '../../server/src/demo/fakes/gmail'
import { FakeState } from '../../server/src/demo/fakes/state'
import { steepling } from '../../scripts/demo/steepling/make'

const dirs: string[] = []
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }) })
function mailbox(locale: 'en' | 'ko'): FakeGmail {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-gmail-'))
  dirs.push(dir)
  return new FakeGmail(steepling(locale).gmail as ConstructorParameters<typeof FakeGmail>[0], new FakeState(dir))
}
const ids = (g: FakeGmail, q: string) => g.search(q).map((m) => m.id)

/** what an AI sends to find Chris's reply, in either language */
const CHRIS = ['from:Chris', 'from:chris', 'chris', 'from:chris.walker@fieldnote.example', 'chris.walker@fieldnote.example', 'from:"Chris Walker"',
  'from:Chris is:unread', 'in:inbox from:Chris newer_than:1d', 'from:(Chris)', 'from:chris OR from:크리스', 'from:(크리스 OR Chris)', '{from:chris from:크리스}',
  'from:크리스 | from:chris', 'from:fieldnote', 'to:me from:chris', 'chris OR 크리스', '"chris" OR "크리스"', '(from:chris OR from:크리스) newer_than:7d']
const CHRIS_KO = ['from:크리스', 'from:크리스님', '크리스', '크리스님', 'from:"크리스 워커"', 'from:크리스 워커', 'from:크리스님이', '크리스님한테서', 'from:크리스 is:unread']

for (const locale of ['en', 'ko'] as const) {
  describe(`Chris's reply in the ${locale} mailbox`, () => {
    const g = mailbox(locale)
    test('the seed has his reply, unread, from his address', () => {
      const reply = g.messages().find((m) => m.id === 'chris-reply')!
      expect(reply.from).toContain('<chris.walker@fieldnote.example>')
      expect(reply.labels).toContain('UNREAD')
    })
    for (const q of [...CHRIS, ...(locale === 'ko' ? CHRIS_KO : [])]) test(`"${q}" finds it`, () => expect(ids(g, q)).toContain('chris-reply'))

    test('AND still narrows, and words in no mail find nothing', () => {
      expect(ids(g, 'from:chris is:unread')).toEqual(['chris-reply'])
      expect(ids(g, 'from:chris from:tom')).toEqual([])
      expect(ids(g, 'from:zebra')).toEqual([])
      expect(ids(g, 'from:크리스틴')).toEqual([])
      expect(ids(g, 'zebra OR giraffe')).toEqual([])
    })
    test('- leaves mail out; from:me is my own mail', () => {
      expect(ids(g, 'from:chris -is:unread')).not.toContain('chris-reply')
      expect(ids(g, 'from:me')).toContain('to-chris')
      expect(ids(g, 'from:me')).not.toContain('chris-reply')
      expect(ids(g, 'in:sent to:chris')).toContain('to-chris')
    })
  })
}

test('a Korean ending is only dropped when the word itself is not found, and never down to one letter', () => {
  const g = mailbox('ko')
  // "이미나" is Mina's own name: it must not turn into "이미" or "미나"-only matches of other mail
  expect(ids(g, 'to:이미나').length).toBeGreaterThan(0)
  expect(ids(g, 'from:워커씨')).toContain('chris-reply')
  expect(ids(g, 'from:커이')).toEqual([])
})

test('the query parser reads OR, brackets, braces and -', () => {
  expect(parseQuery('from:a OR from:b c')).toEqual({ t: 'and', of: [
    { t: 'or', of: [{ t: 'term', term: { key: 'from', value: 'a' } }, { t: 'term', term: { key: 'from', value: 'b' } }] },
    { t: 'term', term: { key: '', value: 'c' } }] })
  expect(parseQuery('from:(a b)')).toEqual({ t: 'and', of: [{ t: 'and', of: [{ t: 'term', term: { key: 'from', value: 'a' } }, { t: 'term', term: { key: 'from', value: 'b' } }] }] })
  expect(parseQuery('{a b}')).toEqual({ t: 'and', of: [{ t: 'or', of: [{ t: 'term', term: { key: '', value: 'a' } }, { t: 'term', term: { key: '', value: 'b' } }] }] })
  expect(parseQuery('-is:unread "x y"')).toEqual({ t: 'and', of: [{ t: 'not', of: { t: 'term', term: { key: 'is', value: 'unread' } } }, { t: 'term', term: { key: '', value: 'x y' } }] })
  expect(parseQuery('from:"Chris Walker"')).toEqual({ t: 'and', of: [{ t: 'term', term: { key: 'from', value: 'Chris Walker' } }] })
  // lenient: a stray or unclosed bracket does not throw
  expect(() => parseQuery('a) (b {c')).not.toThrow()
})
