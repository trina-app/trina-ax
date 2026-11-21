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

describe('Japanese honorifics', () => {
  // a small Japanese mailbox (the ja seed's names): Chris's reply and two other mails
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-gmail-ja-'))
  dirs.push(dir)
  const g = new FakeGmail({ me: { name: 'ミナ・リー', email: 'mina.lee@steepling.example' }, messages: [
    { id: 'chris-reply', from: 'クリス・ウォーカー <chris.walker@fieldnote.example>', to: 'ミナ・リー <mina.lee@steepling.example>', subject: 'Re: 月曜日のローンチのバナー', date: '-1h', body: 'ミナさん\n\nありがとうございます。\n\nクリス', labels: ['INBOX', 'UNREAD'] },
    { id: 'hayashi', from: '林 健 <ken.hayashi@steepling.example>', to: 'ミナ・リー <mina.lee@steepling.example>', subject: 'PCの準備', date: '-1d', body: 'デスクにあります。', labels: ['INBOX'] },
    { id: 'sara', from: 'サラ・イェンセン <sara.jensen@steepling.example>', to: 'ミナ・リー <mina.lee@steepling.example>', subject: 'ようこそ', date: '-2d', body: 'よろしく', labels: ['INBOX'] },
  ] }, new FakeState(dir))
  for (const q of ['from:クリスさん', 'クリスさん', 'from:クリス様', 'from:クリス氏', 'from:クリスくん', 'from:クリスちゃん', 'from:"クリス・ウォーカーさん"', 'クリスさんから', 'from:クリスさん is:unread'])
    test(`"${q}" finds Chris`, () => expect(ids(g, q)).toEqual(['chris-reply']))
  test('a one-kanji name loses its honorific too (林様), and an unknown name still finds nothing', () => {
    expect(ids(g, 'from:林様')).toEqual(['hayashi'])
    expect(ids(g, 'from:ジョンさん')).toEqual([])
    expect(ids(g, 'from:クリスティーナさん')).toEqual([])
  })
})

describe('Gmail words the demo does not keep', () => {
  const g = mailbox('en')
  const all = g.messages().map((m) => m.id)
  test('negated, they leave the mail as it is instead of removing all of it', () => {
    for (const q of ['-category:promotions', '-older_than:30d', '-has:drive', '-is:snoozed', '-in:snoozed', '-newer_than:1d', '-{category:social category:promotions}'])
      expect(ids(g, q)).toEqual(all)
    for (const q of ['from:chris -category:promotions', 'from:chris -older_than:30d', 'from:chris -has:drive -is:snoozed', '-category:promotions from:chris'])
      expect(ids(g, q)).toContain('chris-reply')
    expect(ids(g, 'from:chris -category:promotions -is:unread')).not.toContain('chris-reply')
  })
  test('plain, they do not narrow; in an OR they drop out instead of matching everything', () => {
    expect(ids(g, 'category:primary')).toEqual(all)
    expect(ids(g, 'has:drive from:chris')).toEqual(ids(g, 'from:chris'))
    expect(ids(g, 'from:chris OR older_than:30d')).toEqual(ids(g, 'from:chris'))
    expect(ids(g, '{from:chris has:drive}')).toEqual(ids(g, 'from:chris'))
  })
  test('AND, OR, NOT and an empty {} still work', () => {
    expect(ids(g, 'from:chris is:unread')).toEqual(['chris-reply'])
    expect(ids(g, 'from:chris OR from:mina').length).toBeGreaterThan(ids(g, 'from:chris').length)
    expect(ids(g, '-from:chris')).not.toContain('chris-reply')
    expect(ids(g, '-from:chris').length + ids(g, 'from:chris').length).toBe(all.length)
    expect(ids(g, '{}')).toEqual([])
  })
})

describe('in:drafts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-gmail-drafts-'))
  dirs.push(dir)
  const state = new FakeState(dir)
  const g = new FakeGmail(steepling('en').gmail as ConstructorParameters<typeof FakeGmail>[0], state)
  state.update((d) => { d.drafts.push({ id: 'r1', threadId: 'r1', from: 'Mina Lee <mina.lee@steepling.example>', to: 'Chris Walker <chris.walker@fieldnote.example>', subject: 'Draft to Chris', date: new Date().toUTCString(), body: 'draft', labels: ['DRAFT'] }) })
  test('at the start, after a space or a bracket, it searches the drafts', () => {
    for (const q of ['in:drafts', 'in:draft', 'in:drafts to:chris', 'to:chris in:drafts', '(in:drafts)', 'IN:DRAFTS']) expect(ids(g, q)).toEqual(['r1'])
  })
  test('after a minus, it searches the other mail and keeps all of it', () => {
    expect(ids(g, '-in:drafts')).toEqual(g.messages().map((m) => m.id))
    expect(ids(g, '-in:drafts from:chris')).toContain('chris-reply')
    expect(ids(g, 'from:chris -in:drafts')).not.toContain('r1')
  })
})
