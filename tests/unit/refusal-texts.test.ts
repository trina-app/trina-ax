// The one shape of the AI's refusal texts (server/src/policy/refusal.ts; docs/DECISIONS.md "Refusals say why, who and
// what next"): what did not happen, one reason, one next step with the screen as the person's app names it, the names
// involved. Then the instructions that say what each kind of chat cannot do and where to do it instead.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Locale } from '@mycel/shared/api'
import {
  adminNames, cardEndShort, cardNext, cardReason, nameList, notFoundNext, readOnlyNote, reasonText, refusal, SCREEN, writeGranters, writeLimitText,
} from '../../server/src/policy/refusal'
import { buildTurnContext, buildTurnPrompt, confidentialRule, deleteRule, roomSection, sharedSection, type PromptInput } from '../../server/src/chat/prompt'
import { scheduledRunBlock } from '../../server/src/chat/schedules'
import { roomRefsBlock } from '../../server/src/chat/turn'
import { startHarness, type Harness } from '../lib/b-harness'

describe('refusal()', () => {
  test('the four parts in order: done, why, the extra line, the next step, the names', () => {
    const t = refusal({ done: 'Nothing was moved', why: { kind: 'declined' }, also: 'Do not try another folder', next: 'ask the user what they want', names: ['shared/a', 'shared/a', 'shared/b'] })
    expect(t).toBe('Nothing was moved. Why: the user did not allow it: they said no on the confirmation card. Do not try another folder. Next step: ask the user what they want. Involved: shared/a, shared/b.')
  })

  test('each reason, said plainly', () => {
    expect(reasonText({ kind: 'permission', what: 'read-only', grant: ['Dana', 'Carol'], how: 'in Admin' })).toBe('the user does not have permission for this (read-only); Dana and Carol can give it (in Admin)')
    expect(reasonText({ kind: 'unattended' })).toContain('nobody could be asked: this is a scheduled run with nobody watching')
    expect(reasonText({ kind: 'unattended' })).toContain('The user did not refuse anything; never say they did')
    expect(reasonText({ kind: 'unattended', run: 'a company profile draft' })).toContain('this is a company profile draft with nobody watching')
    expect(reasonText({ kind: 'declined', who: 'Alice Kim' })).toBe('Alice Kim did not allow it: they said no on the confirmation card')
    expect(reasonText({ kind: 'timeout' })).toContain('did not answer the confirmation card in time')
    expect(reasonText({ kind: 'timeout' })).toContain('This is not a no')
    expect(reasonText({ kind: 'ended' })).toBe('the answer stopped before the confirmation card was answered')
    expect(reasonText({ kind: 'others', where: 'the project "Atlas"', count: 1 })).toBe('other people would have to agree: the project "Atlas" (1 person)')
    expect(reasonText({ kind: 'others', where: 'the room "Sales"', count: 4 })).toBe('other people would have to agree: the room "Sales" (4 people)')
    expect(reasonText({ kind: 'limit', limit: '10 videos per person in any 24 hours', resets: 'at 09:00 UTC', setBy: 'the operator' })).toBe('a limit of this server: 10 videos per person in any 24 hours; it resets at 09:00 UTC; the operator can change it')
    expect(reasonText({ kind: 'mode', mode: 'a team chat room', why: 'everyone in it sees the answer' })).toBe('not available in a team chat room: everyone in it sees the answer')
    expect(reasonText({ kind: 'failed' })).toContain('stopped to be safe. Nobody refused it')
  })

  test('a card that ended without a yes: never "did not allow" unless the person said no', () => {
    for (const end of ['timeout', 'unattended', 'ended'] as const) expect(reasonText(cardReason(end))).not.toContain('did not allow')
    expect(reasonText(cardReason('declined'))).toContain('did not allow')
    expect(cardEndShort('declined')).toBe('not allowed by the user')
    expect(cardEndShort('timeout')).toBe('no answer in time')
    expect(cardEndShort('unattended')).toBe('nobody to ask (scheduled run)')
    expect(cardNext('unattended')).toContain('in a chat, where they can answer the card')
    expect(cardNext('timeout')).toBe('the user can ask again and answer the card')
  })

  test('names: "A, B and C", at most three then "and N more"', () => {
    expect(nameList([])).toBe('')
    expect(nameList(['A'])).toBe('A')
    expect(nameList(['A', 'B'])).toBe('A and B')
    expect(nameList(['A', 'B', 'C'])).toBe('A, B and C')
    expect(nameList(['A', 'B', 'C', 'D', 'E'])).toBe('A, B, C and 2 more')
  })

  test('screens by the names the app shows, in every app language', () => {
    expect(Locale.options).toEqual(['ko', 'en', 'id', 'ja', 'es'])
    const trash = { ko: '파일 › 휴지통', en: 'Files › Trash', id: 'File › Sampah', ja: 'ファイル › ゴミ箱', es: 'Archivos › Papelera' }
    for (const L of Locale.options) {
      expect(SCREEN.trash(L)).toContain(`"${trash[L]}"`)
      for (const s of Object.values(SCREEN)) expect(s(L).length).toBeGreaterThan(5)
    }
    expect(SCREEN.adminFolders('ko')).toBe('Admin › Folder permissions ("관리자 › 폴더 권한")')
    expect(SCREEN.settingsMcp('ja')).toBe('Settings › MCP ("設定 › MCP")')
    expect(SCREEN.sideChat('ko')).toMatch(/^the room's side panel \("✦ .+에게 따로 묻기"\)$/)
  })

  test('the write limits give their numbers and "continue" in the next message (B7)', () => {
    const b = writeLimitText('bytes', 50 * 1024 * 1024, 'shared/big.csv')
    expect(b).toContain("Not saved: 'shared/big.csv'.")
    expect(b).toContain('at most 50 MB written in one answer; it resets with the user\'s next message')
    expect(b).toContain('ask the user to say "continue" in the next message')
    expect(writeLimitText('files', 200, 'a.md')).toContain('at most 200 files written in one answer')
  })

  test('"not found or no access" gets a next step that names nothing about the path (in the instructions, not the tool text)', () => {
    expect(notFoundNext()).not.toMatch(/'|exists|permission is/)
  })
})

describe('who can give access', () => {
  let db: Database
  beforeAll(() => {
    db = new Database(':memory:')
    db.run("CREATE TABLE users (id TEXT, name TEXT, role TEXT, status TEXT DEFAULT 'active', deleted_at TEXT)")
    db.run('CREATE TABLE projects (id TEXT, name TEXT, folder_path TEXT, created_by TEXT, trashed_with TEXT)')
    db.run("INSERT INTO users (id, name, role) VALUES ('o', 'Owner Oh', 'owner'), ('a', 'Admin Ahn', 'admin'), ('m', 'Member Moon', 'member'), ('p', 'Pat Creator', 'member')")
    db.run("INSERT INTO users (id, name, role, status) VALUES ('x', 'Gone Admin', 'admin', 'disabled')")
    db.run("INSERT INTO projects VALUES ('pr', 'Atlas', 'projects/atlas', 'p', NULL)")
  })
  afterAll(() => db.close())

  test('active owners and admins, the owner first', () => {
    expect(adminNames(db)).toEqual(['Owner Oh', 'Admin Ahn'])
  })

  const all = () => true
  const none = () => false
  test('a project folder the person sees: its creator and the admins; any other folder: the admins, with the screen', () => {
    expect(writeGranters(db, 'projects/atlas/plan.md', 'ko', all)).toEqual({ names: ['Pat Creator', 'Owner Oh', 'Admin Ahn'], how: 'the project\'s creator adds people to the project, an admin in Admin › Folder permissions ("관리자 › 폴더 권한")' })
    expect(writeGranters(db, 'groups/finance/q.xlsx', 'en', all).how).toContain('Admin › Groups ("Admin › Groups")')
    expect(writeGranters(db, 'shared/회계/2026 예산.xlsx', 'ko', all)).toEqual({ names: ['Owner Oh', 'Admin Ahn'], how: 'an admin in Admin › Folder permissions ("관리자 › 폴더 권한")' })
  })

  // independent review: "read-only folder: you cannot create files in 'projects/<x>'" is also what a hidden project
  // answers (policy/authorize.ts hiddenWrite); naming its creator told a hidden project from a missing one
  test('a project the person cannot see, or a name in another case: the same answer as no project at all', () => {
    const missing = writeGranters(db, 'projects/nothing/x.md', 'ko', none)
    expect(writeGranters(db, 'projects/atlas/x.md', 'ko', none)).toEqual(missing)
    expect(writeGranters(db, 'projects/ATLAS/x.md', 'ko', all)).toEqual(writeGranters(db, 'projects/nothing/x.md', 'ko', all))
    const seen: string[][] = []
    writeGranters(db, 'projects/atlas/a/b.md', 'ko', (segs) => { seen.push(segs); return false })
    expect(seen).toEqual([['projects', 'atlas']])
  })

  test('readOnlyNote: only after a read-only refusal, once', () => {
    const t = "Access denied: read-only: you cannot change 'shared/회계/2026 예산.xlsx'"
    const note = readOnlyNote(db, t, 'ko', { userId: 'm', sees: all, button: true })!
    expect(note).toBe('Write access to \'shared/회계/2026 예산.xlsx\': Owner Oh and Admin Ahn can give it (an admin in Admin › Folder permissions ("관리자 › 폴더 권한")). Next step: tell the user so; they also get a button under your answer to save it in their own folder (users/m), and you may save it there if they ask.')
    expect(readOnlyNote(db, "read-only folder: you cannot create files in 'projects/atlas'", 'en', { userId: 'm', sees: all, button: true })).toContain('Pat Creator, Owner Oh and Admin Ahn can give it')
    expect(readOnlyNote(db, "read-only folder: you cannot create files in 'projects/atlas'", 'en', { userId: 'm', sees: none, button: true })).toContain(': Owner Oh and Admin Ahn can give it')
    // a room or a shared chat has no "save in my folder" button under the answer
    expect(readOnlyNote(db, t, 'ko', { userId: 'm', sees: all, button: false })).toContain('Next step: tell the user so; you may save it in their own folder (users/m) if they ask.')
    expect(readOnlyNote(db, `${t}. ${note}`, 'ko', { userId: 'm', sees: all, button: true })).toBeNull()
    expect(readOnlyNote(db, "Access denied: not found or no access: 'groups/finance'", 'ko', { userId: 'm', sees: all, button: true })).toBeNull()
  })
})

describe('the instructions say what each kind of chat cannot do, and where to do it (bug 10)', () => {
  let h: Harness
  beforeAll(async () => { h = await startHarness({ name: 'refusal-texts' }) })
  afterAll(async () => { await h.close() })
  const input = (extra: Partial<PromptInput> = {}): PromptInput => ({
    user: h.ctx.files.principal('alice'), groupNames: [], locale: 'ko', timeZone: 'Asia/Seoul', memories: [], project: null,
    browser: false, tools: ['move_files', 'copy_files'], history: null, ...extra,
  })

  test('a room: what is missing there, and the side panel or an own chat instead', () => {
    const t = roomSection({ name: 'Sales', kind: 'team', members: 4, asker: 'Alice Kim' }, 'ko')
    expect(t).toContain('Not available in a room: memories about Alice Kim, connected services (and connecting one), Google Drive, scheduled tasks, video generation, the browser')
    expect(t).toContain('the room\'s side panel ("✦')
    expect(t).toContain('do not just say you cannot')
  })

  test('a shared chat: what is missing there, and an own chat instead', () => {
    const t = sharedSection({ project: 'Atlas', audience: 3, asker: 'Alice Kim' }, 'ko')
    expect(t).toContain('Not available in a shared chat: memories about Alice Kim, connected services (and connecting one), Google Drive, the browser, scheduled tasks, video generation and reading team chat rooms')
    expect(t).toContain('a chat of their own (a new AI chat), where only Alice Kim sees the answer')
  })

  test('a confidential chat: told, with which tools are off and why, in the instructions and a resumed session', () => {
    expect(confidentialRule('chat')).toContain('a safe workflow ran in this chat')
    expect(confidentialRule('chat')).toContain('they can do it in a new chat')
    expect(confidentialRule('server')).toContain('this server runs in safe operations mode')
    expect(confidentialRule('server')).toContain('web search and web pages, connected services, Google Drive, moving, copying or renaming files')
    expect(buildTurnPrompt(h.ctx.files, input({ confidential: 'chat', tools: [] }))).toContain(confidentialRule('chat'))
    expect(buildTurnContext(h.ctx.files, input({ confidential: 'server', tools: [] }))).toContain(confidentialRule('server'))
    expect(buildTurnPrompt(h.ctx.files, input())).not.toContain('This is a confidential chat')
  })

  test('deleting: the AI cannot, and says where the person can (bug 4)', () => {
    expect(deleteRule('ko')).toContain('You cannot delete files or folders: there is no delete tool.')
    expect(deleteRule('ko')).toContain('the Files screen\'s trash ("파일 › 휴지통")')
    expect(buildTurnPrompt(h.ctx.files, input())).toContain(deleteRule('ko'))
    expect(buildTurnContext(h.ctx.files, input({ locale: 'en' }))).toContain(deleteRule('en'))
    expect(buildTurnPrompt(h.ctx.files, input())).not.toContain('nothing is deleted unless the user asks')
  })

  test('a scheduled run: what cannot happen there is skipped, not refused by the user', () => {
    const t = scheduledRunBlock('Weekly', 'every Monday at 09:00')
    expect(t).not.toContain('will be declined')
    expect(t).toContain('No confirmation card is shown in a run, so a step that needs the user\'s yes on one is skipped')
    expect(t).toContain('That is not the user refusing anything')
  })

  test('"#room" in a chat without room tools: why, and where to read it (C10)', () => {
    const token = '#[Sales](room:0193a9d1-0000-7000-8000-000000000001)'
    const shared = roomRefsBlock(`봐줘 ${token}`, 'this is a shared project chat: everyone who sees it would see what the room says', 'ko')
    expect(shared).toContain('Rooms cannot be read in this chat. Why: not available in this chat: this is a shared project chat')
    expect(shared).toContain('Next step: the user can ask in a chat of their own (a new AI chat), or open the room in Conversations ("대화")')
    expect(roomRefsBlock(`봐줘 ${token}`, true)).toContain('read it with room_read')
  })
})
