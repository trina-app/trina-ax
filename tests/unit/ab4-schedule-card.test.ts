// The schedule card's addresses (AB4, the owner-flow A/B run, docs/decisions/20261123-ab4-asks-left.md): while this
// server does not know its own exit address, the card said "아래 주소 1개는 지금 이 서버에서는 실행 때 열 수 없어요…공인
// 주소를 몰라서", and the run then opened it under the person's own "Allow all websites" (url-gate.ts ①d). The card says
// what the run will do: opened while that switch is on, or, when it is off, that runs cannot open it now and how to change
// that, in plain words. A long query, a random-looking part or a confidential chat: never promised. A guest among the
// people changes nothing (one Always, docs/decisions/20261123-one-always-allow.md).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { makeCApp, type CApp } from '../lib/c-app'
import { scheduleCard } from '../../server/src/tools/schedules'
import { opensUnderAllSites } from '../../server/src/tools/url-gate'
import { setWebAllowAll } from '../../server/src/tools/web-allow-all'

let A: CApp
beforeAll(async () => { A = await makeCApp('ab4-schedule-card') })
afterAll(async () => { await A.close() })

const input = (prompt: string) => ({ title: 'Morning check', prompt, repeat: 'daily' as const, time: '09:00' })

describe('the schedule card while the exit address is unknown', () => {
  test('with "Allow all websites" on: the plain address is opened while it is on; off: plain words and the way to change it', () => {
    const db = A.ctx.db
    const chat = A.chat('alice')
    const url = 'https://example.com/new'
    expect(opensUnderAllSites(db, chat, 'alice', url)).toBe(false)
    const off = scheduleCard(input(`Read ${url} and tell me`), [], 'en', 'create', { urlsOpen: false, allSites: (u) => opensUnderAllSites(db, chat, 'alice', u) })
    expect(off.question).toContain('Runs cannot open the address below now')
    expect(off.question).toContain('Turn on "Allow all websites" in Settings › Allowed for Trina')
    expect(off.question).not.toContain('public address')
    setWebAllowAll(db, 'alice', true, { via: 'settings' })
    try {
      expect(opensUnderAllSites(db, chat, 'alice', url)).toBe(true)
      const on = scheduleCard(input(`Read ${url} and tell me`), [], 'en', 'create', { urlsOpen: false, allSites: (u) => opensUnderAllSites(db, chat, 'alice', u) })
      expect(on.question).toContain('While "Allow all websites" is on, each run opens the address below without asking.')
      expect(on.question).not.toContain('cannot open')
      const ko = scheduleCard(input(`${url} 읽어서 알려줘`), [], 'ko', 'create', { urlsOpen: false, allSites: (u) => opensUnderAllSites(db, chat, 'alice', u) })
      expect(ko.question).toContain('“모든 사이트 허용”이 켜져 있는 동안, 실행할 때마다 아래 주소 1개는 묻지 않고 열어요.')
      expect(ko.question).not.toContain('공인 주소')
      // never promised: a random-looking part, a user name, someone else's switch
      expect(opensUnderAllSites(db, chat, 'alice', 'https://example.com/x/Zk3qP9vT2mW8yR4nB7cL1dF6')).toBe(false)
      expect(opensUnderAllSites(db, chat, 'alice', 'https://u:p@example.com/new')).toBe(false)
      expect(opensUnderAllSites(db, chat, 'bob', url)).toBe(false)
      // a long query: listed apart as never opened, as before
      const long = `https://example.com/q?${'a='.padEnd(400, 'b')}`
      expect(opensUnderAllSites(db, chat, 'alice', long)).toBe(false)
      // two addresses, one not plain: not promised for the list
      const mixed = scheduleCard(input(`${url} and https://example.com/x/Zk3qP9vT2mW8yR4nB7cL1dF6`), [], 'en', 'create', { urlsOpen: false, allSites: (u) => opensUnderAllSites(db, chat, 'alice', u) })
      expect(mixed.question).toContain('Runs cannot open the 2 addresses below now')
      // the exit address known: as before
      expect(scheduleCard(input(`Read ${url}`), [], 'en', 'create', { urlsOpen: true }).question).toContain('On each run it opens the address below without asking.')
    } finally { setWebAllowAll(db, 'alice', false, { via: 'settings' } as never) }
  })
})
