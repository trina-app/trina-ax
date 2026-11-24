// A team path in words on every screen (src/lib/teamPlace.ts, QA TC-8922): the answer's "N files referenced" list said
// "users/qa-admin/공문/" where the rest of the app says "내 파일 › 공문". The list now names each folder as the step lines
// do, for the person looking: their own folder, another person's by name, the team's folders; the disk path only in the
// tooltip.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ownFolderWord, setOwnFolderWord } from '@mycel/shared'
import type { Locale, Me, MessageSources, Person } from '@mycel/shared/api'
import { useLocaleStore } from '../../src/i18n'
import SourcesList from '../../src/components/chat/SourcesList'
import { teamPlace } from '../../src/lib/teamPlace'
import { usePeople } from '../../src/store/people'
import { useSession } from '../../src/store/session'

const setLocale = (l: Locale) => Object.assign(useLocaleStore.getInitialState(), { locale: l })
const beforeLocale = useLocaleStore.getInitialState().locale
const beforeWord = ownFolderWord()
const me = { user: { id: 'qa-admin', username: 'qa-admin', name: 'QA Admin', email: null, role: 'admin', locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} }, groups: [],
  team: { name: 'QA-Acme', defaultLocale: 'ko' }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' }, server: { version: '0', dev: false } } as unknown as Me
const mina = { id: 'mina', name: '김민지' } as unknown as Person

// (a server render reads each store's first state)
const sessionBefore = { ...useSession.getInitialState() }
const peopleBefore = { ...usePeople.getInitialState() }
beforeAll(() => {
  setOwnFolderWord('files')
  Object.assign(useSession.getInitialState(), { status: { kind: 'signed-in', me } })
  Object.assign(usePeople.getInitialState(), { people: [mina], loaded: true, byId: { mina } })
})
afterAll(() => {
  setOwnFolderWord(beforeWord)
  Object.assign(useSession.getInitialState(), sessionBefore)
  Object.assign(usePeople.getInitialState(), peopleBefore)
})
afterEach(() => setLocale(beforeLocale))

const viewer = { me: 'qa-admin', nameOf: (id: string) => (id === 'mina' ? '김민지' : null) }

describe('teamPlace', () => {
  test('every kind of team folder, in words', () => {
    expect(teamPlace('users/qa-admin/공문/', 'ko', viewer)).toBe('내 파일 › 공문')
    expect(teamPlace('users/qa-admin/공문', 'en', viewer)).toBe('My files › 공문')
    expect(teamPlace('users/mina/보고서', 'ko', viewer)).toBe('김민지 님 폴더 › 보고서')
    expect(teamPlace('users/u-9/메모', 'en', viewer)).toBe('Personal › 메모')
    expect(teamPlace('shared/양식', 'ko', viewer)).toBe('전사 공유 › 양식')
    expect(teamPlace('groups/영업/견적', 'en', viewer)).toBe('영업 folder › 견적')
    expect(teamPlace('projects/falcon/notes', 'en', viewer)).toBe('Projects › falcon › notes')
    expect(teamPlace('', 'en', viewer)).toBe('Team folder')
  })
  test('a folder at the top the place words do not name: as the Files screen says it, never empty', () => {
    expect(teamPlace('finance/2026', 'en', viewer)).toBe('finance › 2026')
  })
})

const LIST: MessageSources = {
  files: [
    { path: 'users/qa-admin/공문/협조 요청.hwp', name: '협조 요청.hwp', locs: [], via: ['read'] },
    { path: 'users/mina/보고서/주간.docx', name: '주간.docx', locs: [], via: ['read'] },
    { path: 'shared/양식/견적서.xlsx', name: '견적서.xlsx', locs: [], via: ['read'] },
    { path: 'groups/영업/고객/목록.csv', name: '목록.csv', locs: [], via: ['read'] },
    { path: 'projects/falcon/notes/a.md', name: 'a.md', locs: [], via: ['read'] },
  ],
  unavailable: 0,
}
const render = () => renderToStaticMarkup(<SourcesList chatId="c" messageId="m" count={LIST.files.length} defaultOpen initial={LIST} />)
/** the text of each row, without the tooltips (which keep the disk path) */
const rowTexts = (html: string) => html.split('data-testid="answer-source"').slice(1).map((r) => r.slice(r.indexOf('>') + 1).replace(/title="[^"]*"/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())

describe('"N files referenced" under an answer (QA TC-8922)', () => {
  test('ko: each folder by its place name, never users/…, shared/, groups/ or projects/', () => {
    setLocale('ko')
    const rows = rowTexts(render())
    expect(rows[0]).toContain('내 파일 › 공문')
    expect(rows[1]).toContain('김민지 님 폴더 › 보고서')
    expect(rows[2]).toContain('전사 공유 › 양식')
    expect(rows[3]).toContain('영업 폴더 › 고객')
    expect(rows[4]).toContain('프로젝트 › falcon › notes')
    for (const r of rows) expect(r).not.toMatch(/\b(users|shared|groups|projects)\//)
  })
  test('en: "My files › 공문"', () => {
    setLocale('en')
    expect(rowTexts(render())[0]).toContain('My files › 공문')
  })
  test('the disk path stays in the tooltip', () => {
    setLocale('ko')
    expect(render()).toContain('title="users/qa-admin/공문/협조 요청.hwp"')
  })
})
