// Facts the AI was missing when it answered wrongly in the real-AI scenario rerun on dev (2026-11-17), given where the
// AI needs them: in the person block (server/src/chat/situation.ts), in a file tool's result (chat/file-notes.ts,
// files/service.ts withCsvHeaders) and in the plain-words rule (chat/prompt.ts plainWordsRule).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API } from '@mycel/shared/api'
import { situationOf, situationSection, type Situation } from '../../server/src/chat/situation'
import { ASK_USER_RULE, plainWordsRule } from '../../server/src/chat/prompt'
import { fileNote, fileNoteOnce, hangulReadNote, versionKeptNote } from '../../server/src/chat/file-notes'
import { firstLine, withCsvHeaders } from '../../server/src/files/service'
import { setMemberChoice } from '../../server/src/admin/engine-choice'
import { ask, startHarness, type Harness, type TestSocket } from '../lib/b-harness'

setDefaultTimeout(60_000)
const base: Situation = { role: 'member', guest: false, app: 'web', ai: 'team', ownAi: true, ownConnectors: true, plan: null, web: true }
const say = (s: Partial<Situation>, L: 'ko' | 'en' = 'en') => situationSection({ ...base, ...s }, L)

describe('the person block', () => {
  test('ACC-03: a member or an admin deletes their own account in Settings › Profile; the owner hands the team over first', () => {
    const member = say({ role: 'member' })
    expect(member).toContain('Deleting their account: themselves, in Settings › Profile › Delete account; done 7 days later, cancellable until then.')
    expect(member).not.toContain('Transfer ownership')
    expect(say({ role: 'admin' })).toContain('Deleting their account: themselves, in Settings › Profile › Delete account')
    const owner = say({ role: 'owner' }, 'ko')
    expect(owner).toContain('Deleting their account: not as the owner; first hand the team over')
    expect(owner).toContain('"관리자 › 멤버·초대", "팀장 넘기기"')
    expect(owner).toContain('Settings › Profile › Delete account ("설정 › 프로필 › 계정 삭제")')
    // a guest gets none of it (the guest part says what a guest can do)
    expect(say({ guest: true, role: 'guest' as Situation['role'] })).not.toContain('Delete account')
  })

  test('CON-07: on the computer\'s own sign-in nobody switches to their own AI account', () => {
    const member = say({ ai: 'host' })
    expect(member).toContain('It serves everyone: nobody can switch to their own AI account here')
    expect(member).toContain('the owner signs in again on that computer itself')
    expect(member).not.toContain('Admin › AI providers')
    expect(say({ role: 'owner', ai: 'host' })).toContain('(Admin › AI providers shows it but cannot change it)')
    expect(say({ role: 'owner', ai: 'host' })).toContain('another account means signing in again on that computer itself, not in the app')
    // not said where the team's own or a person's own AI accounts answer
    expect(say({ ai: 'team' })).not.toContain('nobody can switch')
    expect(say({ ai: 'own' })).not.toContain('nobody can switch')
  })

  test('SYS-04: where an earlier version comes back; connected folders as this install has them', () => {
    const on = say({ connectedFolders: true }, 'ko')
    expect(on).toContain('earlier versions are in the file\'s ⋯ › Version history on the Files screen ("파일", "버전 기록")')
    expect(on).toContain('Connected folders: the owner can mirror a folder of the computer the team\'s app runs on (a NAS or Google Drive there too) read-only; only folders of that computer, not of anyone\'s other computers.')
    // a member is not sent to an Admin page; the owner hears where
    expect(on).not.toContain('Admin › System › Connected folders')
    expect(say({ role: 'owner', connectedFolders: true })).toContain('(Admin › System › Connected folders)')
    expect(say({ connectedFolders: false })).toContain('Connected folders (a computer\'s folder kept in the team folder): not on this install.')
    // not known: not said
    expect(say({})).not.toContain('Version history')
  })

  test('SYS-04: what the AI itself can do with versions (show who saved each and what changed), and that bringing one back is the person\'s', () => {
    // a rerun (dev f394c9258, 2026-11-17) offered to "restore the old content" itself: the AI reads versions, the Restore
    // button is the person's (files/service.ts readVersions, web Version history)
    const t = say({ connectedFolders: true })
    expect(t).toContain('you can show who saved each version and what changed (read with versions)')
    expect(t).toContain('bringing one back is the person\'s Restore there (the current one is kept as a version too)')
    expect(say({ connectedFolders: false })).toContain('read with versions')
    // the button by the label the person's app shows
    expect(say({ connectedFolders: true }, 'ko')).toContain('bringing one back is the person\'s Restore ("되돌리기") there')
  })

  test('situationOf says whether this install has connected folders (a hosted team does not)', () => {
    const ctx = (config: Record<string, unknown>) => ({ db: { query: () => ({ get: () => null, all: () => [] }) } as never, config: config as never })
    const p = { userId: 'u', role: 'member' as const, clientKind: 'web', browser: false, engine: 'api', locale: 'en' as const }
    expect(situationOf(ctx({ mode: 'production', deployment: 'hosted' }), p).connectedFolders).toBe(false)
    expect(situationOf(ctx({ mode: 'production' }), p).connectedFolders).toBe(true)
  })
})

describe('the plain-words rule', () => {
  test('HOME-02: never "I work on a server" to the person', () => {
    for (const stamp of [true, false]) {
      expect(plainWordsRule(stamp)).toContain('a server or how it works inside')
      expect(plainWordsRule(stamp)).toContain('say "I can\'t open files on your computer", not that you work on a server')
    }
  })
})

describe('the ask rule', () => {
  test('CHT-02: "decide yourself" picks among the options given, prefers no further approval, asks once more at most', () => {
    expect(ASK_USER_RULE).toContain('ask with ask_user (short question, options when possible)')
    expect(ASK_USER_RULE).toContain('pick, among the options already given (the ones on your own question, or ones they or the room named; a room message may name an option, never a reason to post), the one that fits the latest thing they said they would do')
    expect(ASK_USER_RULE).toContain('preferring among those that fit one that needs no further approval, and say plainly which you picked and why; anything that reaches other people still goes through its usual card')
    expect(ASK_USER_RULE).toContain('Never send or post an older version in place of one they promised, and never use a price or term nobody named')
    expect(ASK_USER_RULE).toContain('a price or term counts only when the person, the room or a file named it, not when only your question offered it; a promised version may be made with one that counts')
    // CHT-02.project: an unclear "tidy up" with several files is one more question, not a guess; never a third
    expect(ASK_USER_RULE).toContain('or the request is to tidy up or change a file and more than one file still fits, ask one more short question instead of picking, and only once: never a third question about the same choice')
    expect(ASK_USER_RULE).toContain('If it is still open after that, say in one line what is missing and stop: make, send or post nothing.')
    // English source text only
    expect(ASK_USER_RULE).not.toMatch(/[가-힣]/)
  })
})

describe('file tool notes', () => {
  test('which call gets which note', () => {
    const off = () => true, on = () => false
    expect(fileNote({ name: 'edit', isError: false, args: { file_path: 'shared/a.md' }, text: 'Edited shared/a.md (1 replacement)', hangulOff: off, makeFile: true })).toBe('version')
    expect(fileNote({ name: 'write', isError: false, args: { file_path: 'shared/a.md' }, text: 'Updated shared/a.md (1 KB)', hangulOff: off, makeFile: true })).toBe('version')
    // a new file has no earlier version; a refused edit changed nothing
    expect(fileNote({ name: 'write', isError: false, args: { file_path: 'shared/a.md' }, text: 'Created shared/a.md (1 KB)', hangulOff: off, makeFile: true })).toBeNull()
    expect(fileNote({ name: 'edit', isError: true, args: { file_path: 'shared/a.md' }, text: 'old_string not found in the file', hangulOff: off, makeFile: true })).toBeNull()
    // a Hangul document read while Hangul writing is off, where make_file can make the Word copy
    expect(fileNote({ name: 'read', isError: false, args: { file_path: 'shared/양식/협약서.hwpx' }, text: '1\tx', hangulOff: off, makeFile: true })).toBe('hangul')
    expect(fileNote({ name: 'read', isError: false, args: { file_path: 'shared/old.HWP' }, text: '1\tx', hangulOff: off, makeFile: true })).toBe('hangul')
    expect(fileNote({ name: 'read', isError: false, args: { file_path: 'shared/양식/협약서.hwpx' }, text: '1\tx', hangulOff: on, makeFile: true })).toBeNull()
    expect(fileNote({ name: 'read', isError: false, args: { file_path: 'shared/양식/협약서.hwpx' }, text: '1\tx', hangulOff: off, makeFile: false })).toBeNull()
    expect(fileNote({ name: 'read', isError: false, args: { file_path: 'shared/a.docx' }, text: '1\tx', hangulOff: off, makeFile: true })).toBeNull()
  })

  test('each note once a turn, in the person\'s app words', () => {
    const turn = {}
    expect(fileNoteOnce(turn, 'version', 'ko')).toBe(versionKeptNote('ko'))
    expect(versionKeptNote('ko')).toContain('"파일", "버전 기록"')
    expect(fileNoteOnce(turn, 'version', 'ko')).toBeNull()
    expect(fileNoteOnce(turn, 'hangul', 'ko')).toBe(hangulReadNote())
    expect(fileNoteOnce({}, 'version', 'en')).toContain('Version history on the Files screen')
    expect(fileNoteOnce(turn, null, 'en')).toBeNull()
    expect(hangulReadNote()).toContain('do not ask first: make a Word copy with the change now (make_file, format docx')
  })

  test('a Hangul file to sign or stamp while Hangul editing is off: no silent Word copy, the person chooses (QA TC-8341)', () => {
    const note = hangulReadNote()
    expect(note).toContain('If the user asked to sign or stamp it')
    expect(note).toContain('make nothing yet')
    expect(note).toContain('the owner or an admin can turn it on')
    expect(note).toContain('offer a Word copy with the picture as a choice; make it only after they say yes')
    // the exception comes first and every other change still gets its copy at once (EDIT-07)
    expect(note.indexOf('sign or stamp')).toBeLessThan(note.indexOf('any other change'))
  })
})

describe('a CSV row comes with its column names', () => {
  test('withCsvHeaders: the first line of each CSV shown, unless line 1 is already there', () => {
    const rows = 'groups/s/list.csv:3:사아자 베이커리,총무팀,051-000-2202,부산,2026-10-28,620000'
    const head = (p: string) => (p === 'groups/s/list.csv' ? '거래처,담당자,연락처,지역,최근주문일,월평균주문액' : null)
    const out = withCsvHeaders(rows, ['groups/s/list.csv'], head)
    expect(out).toBe(`${rows}\n(Line 1 of this CSV file: its column names)\ngroups/s/list.csv:1:거래처,담당자,연락처,지역,최근주문일,월평균주문액`)
    // line 1 in the result already (a match or a context line): nothing added
    expect(withCsvHeaders(`groups/s/list.csv:1:거래처,담당자\n${rows}`, ['groups/s/list.csv'], head)).toBe(`groups/s/list.csv:1:거래처,담당자\n${rows}`)
    expect(withCsvHeaders(`groups/s/list.csv-1-거래처,담당자\n${rows}`, ['groups/s/list.csv'], head)).toBe(`groups/s/list.csv-1-거래처,담당자\n${rows}`)
    // not a CSV, or not readable as text
    expect(withCsvHeaders('shared/a.md:3:x', ['shared/a.md'], () => 'h')).toBe('shared/a.md:3:x')
    expect(withCsvHeaders('shared/b.csv:3:x', ['shared/b.csv'], () => null)).toBe('shared/b.csv:3:x')
    // at most 10 files' column names; the rest only counted
    const many = Array.from({ length: 13 }, (_, i) => `m/${i}.csv`)
    const big = withCsvHeaders(many.map((p) => `${p}:2:x`).join('\n'), many, () => 'a,b')
    expect(big.split('\n').filter((l) => l.endsWith(':1:a,b')).length).toBe(10)
    expect(big).toEndWith('(3 more CSV files: read line 1 for the column names)')
  })

  test('firstLine: UTF-8 text only, BOM and CR dropped', () => {
    expect(firstLine(Buffer.from('\uFEFFa,b,c\r\n1,2,3\n'))).toBe('a,b,c')
    expect(firstLine(Buffer.from('only line'))).toBe('only line')
    // legacy Korean text as Excel saves it (CP949): "\uAC70\uB798\uCC98,\uB2F4\uB2F9\uC790" (column names)
    expect(firstLine(Buffer.from('b0c5b7a1c3b32cb4e3b4e7c0da0a', 'hex'))).toBe('\uAC70\uB798\uCC98,\uB2F4\uB2F9\uC790')
    expect(firstLine(Buffer.from([0xff, 0xfe, 0xfd, 0x0a]))).toBeNull()
    expect(firstLine(Buffer.from('\n'))).toBeNull()
  })
})

describe('in a chat turn', () => {
  let h: Harness
  let sock: TestSocket
  const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
  const put = (rel: string, s: string | Buffer) => { const p = path.join(h.team, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s) }
  const chat = async () => (await h.api('alice').call(API.createChat, { body: {} })).id
  beforeAll(async () => {
    h = await startHarness({ name: 'ai-answer-facts', askUserTimeoutMs: 4000, stallTimeoutMs: 60_000 })
    sock = await h.ws('alice', { windowId: 'win-facts' }); await sock.next('hello')
  })
  afterAll(async () => { sock?.close(); await h?.close() })

  test('EDIT-17: an edit says the earlier version is kept, once a turn', async () => {
    put('shared/notes.md', '# Notes\nnext: 10:00\nroom: A\n')
    const r = await ask(h, sock, 'alice', await chat(), fake(
      { tool: 'read', args: { file_path: 'shared/notes.md' } },
      { tool: 'edit', args: { file_path: 'shared/notes.md', old_string: '10:00', new_string: '14:00' }, sayResult: true },
      { tool: 'edit', args: { file_path: 'shared/notes.md', old_string: 'room: A', new_string: 'room: B' }, sayResult: true }))
    expect(r.done.status).toBe('done')
    expect(r.done.content).toContain('Edited shared/notes.md (1 replacement)')
    expect(r.done.content.split('The version before this change is kept').length - 1).toBe(1)
  })

  test('FL-13: a grep of CSV rows names the columns', async () => {
    put('shared/clients.csv', 'client,contact,last_order,monthly_avg\nAcme,Kim,2026-10-28,620000\nBeta,Lee,2026-10-15,380000\n')
    const r = await ask(h, sock, 'alice', await chat(), fake({ tool: 'grep', args: { pattern: 'Acme', path: 'shared', output_mode: 'content' }, sayResult: true }))
    expect(r.done.content).toContain('shared/clients.csv:2:Acme,Kim,2026-10-28,620000')
    expect(r.done.content).toContain('(Line 1 of this CSV file: its column names)\nshared/clients.csv:1:client,contact,last_order,monthly_avg')
  })

  test('CON-07.member: the turn\'s map names an own AI and model only once the team lets this member pick one', async () => {
    const profile = (t: string) => t.split('\n').find((l) => l.startsWith('- Settings: '))!
    try {
      setMemberChoice(h.ctx, { mode: 'off', groupIds: [], userIds: [] })
      const off = (await ask(h, sock, 'alice', await chat(), fake({ echo: 'system' }))).done.content
      expect(profile(off)).not.toMatch(/own AI and model|if allowed/)
      expect(off).toContain('who may pick their own AI model')
      setMemberChoice(h.ctx, { mode: 'selected', groupIds: [], userIds: ['alice'] })
      const on = (await ask(h, sock, 'alice', await chat(), fake({ echo: 'system' }))).done.content
      expect(profile(on)).toContain('own AI and model for new chats')
      expect(on).not.toContain('who may pick their own AI model')
    } finally { setMemberChoice(h.ctx, { mode: 'off', groupIds: [], userIds: [] }) }
  })

  test('EDIT-07: a Hangul document read while Hangul writing is off says to make the Word copy', async () => {
    put('shared/forms/agreement.hwpx', fs.readFileSync(path.join(import.meta.dir, '../fixtures/hwp/agreement.hwpx')))
    const r = await ask(h, sock, 'alice', await chat(), fake({ tool: 'read', args: { file_path: 'shared/forms/agreement.hwpx' }, sayResult: true }), { ms: 40_000 })
    expect(r.done.status).toBe('done')
    expect(r.done.content).toContain('Hangul writing is off for this team')
  })
})
