// Ask less (docs/decisions/20261122-ask-less-explicit-save.md; QA TC-ask2-2, -6, -8, -12, -13, -15):
// - the explicit-ask rule for saving, moving and copying to a place the person named (chat/explicit-place.ts): the
//   words, the place facts, the exclusions, and move_files / copy_files going without their card;
// - delete_files of an empty folder this chat made goes without a card (chat/own-files.ts emptyFolderMadeHere);
// - every Always allow note says what it covers (chat/always-allow.ts alwaysNote), in every language;
// - a person's own move out of a group folder to Company-wide answers 409 audience_widened with askWiden.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, CARD_ALWAYS_KINDS, LOCALE_ORDER, uuidv7, type Locale } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'
import { asksToPlaceIn, explicitPlaceAsk, placeFacts } from '../../server/src/chat/explicit-place'
import { alwaysNote } from '../../server/src/chat/always-allow'
import { TEXT, tr } from '../../server/src/chat/i18n'
import { deleteFilesTool, type DeleteExec } from '../../server/src/chat/delete-files'
import { bulkResult } from '../../server/src/tools/file-moves'
import { bulkWhoForAi } from '../../server/src/devenv/bulk'
import { makeHandler } from '../../server/src/mcp/protocol'
import { TurnFiles } from '../../server/src/files/service'
import type { TurnPerson } from '../../server/src/tools/url-gate'
import { componentC } from '../../server/src/team-files/component'

setDefaultTimeout(60_000)
let h: Harness
beforeAll(async () => { h = await startHarness({ name: 'ask-less-explicit-save', askUserTimeoutMs: 2000 }) })
afterAll(async () => { await h?.close() })

const abs = (rel: string) => path.join(h.team, ...rel.split('/'))
const put = (rel: string, data = 'x') => { fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), data) }
const chatOf = (user: string, o: { projectId?: string } = {}) => {
  const id = uuidv7()
  h.ctx.db.query('INSERT INTO chats (id, user_id, title, project_id) VALUES (?,?,?,?)').run(id, user, 'chat', o.projectId ?? null)
  return id
}
const turnIn = (chatId: string, user: string) => {
  const id = uuidv7()
  h.ctx.db.query("INSERT INTO turns (id, chat_id, user_id, engine, status) VALUES (?,?,?, 'claude-code', 'running')").run(id, chatId, user)
  return id
}
const messageIn = (chatId: string, content: string, o: { autoSent?: boolean } = {}) => {
  const id = uuidv7()
  h.ctx.db.query("INSERT INTO messages (id, chat_id, role, content, auto_sent) VALUES (?,?, 'user', ?, ?)").run(id, chatId, content, o.autoSent ? 1 : 0)
  return id
}

describe('asksToPlaceIn: the words', () => {
  const shared = { names: ['전사 공유', 'Company-wide'], everyone: true }
  const mkt = { names: ['마케팅'] }
  const proj = { names: ['신제품-출시'], project: true }
  test('skipped: a save / move / copy request that names the place (Korean and English)', () => {
    expect(asksToPlaceIn('팀원들도 볼 수 있게 저장해줘', shared)).toBe(true) // TC-ask2-8
    expect(asksToPlaceIn('전사 공유에 옮겨줘', shared)).toBe(true)
    expect(asksToPlaceIn('이 보고서 모두가 볼 수 있게 복사해 주세요', shared)).toBe(true)
    expect(asksToPlaceIn('save it where everyone can see it, in the team folder', shared)).toBe(true)
    expect(asksToPlaceIn('copy these to Company-wide', shared)).toBe(true)
    expect(asksToPlaceIn('요약해서 팀 폴더 마케팅에 저장해줘', mkt)).toBe(true) // TC-ask2-13
    expect(asksToPlaceIn('move the files into 마케팅', mkt)).toBe(true)
    expect(asksToPlaceIn('포스터 하나 프로젝트에 만들어줘', proj)).toBe(true) // TC-ask2-2
    expect(asksToPlaceIn('save the summary in the project folder', proj)).toBe(true)
    expect(asksToPlaceIn('신제품-출시에 넣어줘', proj)).toBe(true)
  })
  test('the card stays: no request verb, no place, a "don\'t", a quote, the wrong place, a bare "all"', () => {
    expect(asksToPlaceIn('팀원들도 볼 수 있게 요약해줘', shared)).toBe(false) // no save verb
    expect(asksToPlaceIn('저장해줘', shared)).toBe(false) // no place
    expect(asksToPlaceIn('파일 모두 옮겨줘', shared)).toBe(false) // "all the files", not everyone
    expect(asksToPlaceIn('전사 공유에는 저장하지 마', shared)).toBe(false)
    expect(asksToPlaceIn("don't move it to Company-wide", shared)).toBe(false)
    expect(asksToPlaceIn('> 전사 공유에 옮겨줘\n이거 요약해줘', shared)).toBe(false) // someone else's words
    expect(asksToPlaceIn('마케팅 자료 요약해서 저장해줘', mkt)).toBe(false) // 마케팅 is not the place there
    expect(asksToPlaceIn('팀원들도 볼 수 있게 저장해줘', mkt)).toBe(false) // an everyone-word names only Company-wide
    expect(asksToPlaceIn('프로젝트에 만들어줘', { names: ['기타'] })).toBe(false) // not the chat's project folder
    expect(asksToPlaceIn('save it to the project', { names: [] })).toBe(false)
  })
})

describe('placeFacts and explicitPlaceAsk: the place and the exclusions', () => {
  test('Company-wide by its shown names and "everyone"; a project folder is the chat\'s own only in its chat', () => {
    const pid = uuidv7()
    h.ctx.db.query('INSERT INTO projects (id, name, folder_path, created_by, created_at) VALUES (?,?,?,?,?)').run(pid, 'Launch', 'projects/launch', 'alice', new Date().toISOString())
    expect(placeFacts(h.ctx.db, chatOf('alice'), 'shared')).toMatchObject({ everyone: true, project: false })
    expect(placeFacts(h.ctx.db, chatOf('alice'), 'shared').names).toContain('전사 공유')
    expect(placeFacts(h.ctx.db, chatOf('alice', { projectId: pid }), 'projects/launch')).toEqual({ names: ['launch', 'Launch'], project: true, everyone: false })
    expect(placeFacts(h.ctx.db, chatOf('alice'), 'projects/launch').project).toBe(false)
    expect(placeFacts(h.ctx.db, chatOf('alice'), 'users/alice').names).toEqual([])
  })

  const execOf = (said: string, o: { shared?: boolean; otherAuthors?: boolean; roomsSeen?: boolean; othersWords?: boolean; clientKind?: string; autoSent?: boolean; restricted?: boolean } = {}) => {
    const chatId = chatOf('alice')
    return {
      spec: { userId: 'alice', chatId, turnId: turnIn(chatId, 'alice'), userMessageId: messageIn(chatId, said, { autoSent: o.autoSent }), clientKind: o.clientKind ?? 'web', locale: 'ko' },
      rt: h.rt(), shared: o.shared ? { kind: 'project' } : null, otherAuthors: !!o.otherAuthors, roomsSeen: !!o.roomsSeen, othersWords: !!o.othersWords,
      restricted: !!o.restricted, templateRun: false,
    } as unknown as Parameters<typeof explicitPlaceAsk>[0]
  }
  test('the person\'s own chat with nobody else\'s words: skipped; every exclusion keeps the card', () => {
    const said = '팀원들도 볼 수 있게 저장해줘'
    expect(explicitPlaceAsk(execOf(said), 'shared')).toBe(true)
    expect(explicitPlaceAsk(execOf(said, { shared: true }), 'shared')).toBe(false)
    expect(explicitPlaceAsk(execOf(said, { otherAuthors: true }), 'shared')).toBe(false)
    expect(explicitPlaceAsk(execOf(said, { roomsSeen: true }), 'shared')).toBe(false)
    expect(explicitPlaceAsk(execOf(said, { othersWords: true }), 'shared')).toBe(false)
    expect(explicitPlaceAsk(execOf(said, { clientKind: 'schedule' }), 'shared')).toBe(false)
    expect(explicitPlaceAsk(execOf(said, { clientKind: 'slack' }), 'shared')).toBe(false)
    expect(explicitPlaceAsk(execOf(said, { restricted: true }), 'shared')).toBe(false)
    expect(explicitPlaceAsk(execOf(said, { autoSent: true }), 'shared')).toBe(false)
    // a skill folder or a hidden one never
    expect(explicitPlaceAsk(execOf('skills에 저장해줘'), 'skills')).toBe(false)
    expect(explicitPlaceAsk(execOf("'.system'에 저장해줘"), '.system')).toBe(false)
  })
})

describe('move_files / copy_files after an explicit ask', () => {
  type Person = TurnPerson & { questions: string[] }
  const personOf = (explicit: boolean): Person => {
    const questions: string[] = []
    return {
      locale: 'ko', questions, explicitPlace: () => explicit,
      async confirm(q) { questions.push(q); return true },
      async confirmWhy(q) { questions.push(q); return 'yes' },
      *turnUrls() {},
    }
  }
  let rpc = 0
  const call = async (name: string, args: unknown, person: TurnPerson, turnId: string | null = null) => {
    const tc = { user: h.ctx.files.principal('alice'), turnId, files: new TurnFiles(), person }
    const r = await makeHandler(h.ctx.files, h.ctx.db, tc)({ jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } })
    return { text: r.result.content[0].text as string, isError: !!r.result.isError }
  }
  test('more people will see it and the person asked for exactly that: no card, moved, the AI told the count', async () => {
    put('users/alice/ex1/report.md')
    const p = personOf(true)
    const r = await call('move_files', { paths: ['users/alice/ex1/report.md'], to_folder: 'shared' }, p)
    expect(r.isError, r.text).toBe(false)
    expect(p.questions).toHaveLength(0)
    expect(fs.existsSync(abs('shared/report.md'))).toBe(true)
    expect(r.text).toMatch(/more than before/)
    const audit = h.ctx.db.query("SELECT summary FROM tool_events WHERE tool = 'move_files' ORDER BY id DESC LIMIT 1").get() as { summary: string } | null
    if (audit) expect(audit.summary).toContain("asked for in the user's message")
  })
  test('a copy the same way; without the ask the card shows', async () => {
    put('users/alice/ex2/plan.md')
    const yes = personOf(true)
    expect((await call('copy_files', { paths: ['users/alice/ex2/plan.md'], to_folder: 'shared' }, yes)).isError).toBe(false)
    expect(yes.questions).toHaveLength(0)
    put('users/alice/ex2/plan2.md')
    const no = personOf(false)
    expect((await call('copy_files', { paths: ['users/alice/ex2/plan2.md'], to_folder: 'shared' }, no)).isError).toBe(false)
    expect(no.questions).toHaveLength(1)
  })
  test('someone loses access (a move out of Company-wide into my folder): the card stays', async () => {
    put('shared/ex3/notes.md')
    const p = personOf(true)
    await call('move_files', { paths: ['shared/ex3/notes.md'], to_folder: 'users/alice' }, p)
    expect(p.questions).toHaveLength(1)
  })
})

describe('delete_files of an empty folder this chat made (TC-ask2-12)', () => {
  const execOf = (chatId: string) => {
    const main = new TurnFiles()
    const asked: unknown[] = []
    const exec = {
      spec: { userId: 'alice', chatId, turnId: turnIn(chatId, 'alice'), locale: 'en', clientKind: 'web' },
      room: null, shared: null, restricted: false, templateRun: false, roomsSeen: false, otherAuthors: false, fromSlack: false,
      files: main, rt: h.rt(), livePrincipal: () => h.ctx.files.principal('alice'), openRequests: () => [],
      waitForPerson: (req: unknown) => { asked.push(req); return Promise.resolve('skip') },
    } as unknown as DeleteExec
    return { exec, main, asked }
  }
  const yes: TurnPerson = { locale: 'en', async confirm() { return true }, async confirmWhy() { return 'yes' }, *turnUrls() {} }
  const move = async (turnId: string, paths: string[], to: string) => {
    const tc = { user: h.ctx.files.principal('alice'), turnId, files: new TurnFiles(), person: yes }
    const r = await makeHandler(h.ctx.files, h.ctx.db, tc)({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name: 'move_files', arguments: { paths, to_folder: to } } })
    expect(r.result.isError, r.result.content[0].text).toBeFalsy()
  }

  test('the AI made the folder in an earlier answer of this chat and moved its file out again: no card in a later answer, the folder goes to the trash', async () => {
    const chatId = chatOf('alice')
    const t = turnIn(chatId, 'alice')
    put('users/alice/em1/a.md')
    await move(t, ['users/alice/em1/a.md'], 'shared/ai-empty')
    await move(t, ['shared/ai-empty/a.md'], 'users/alice/em1')
    expect(fs.readdirSync(abs('shared/ai-empty'))).toEqual([])
    const { exec, main, asked } = execOf(chatId)
    const r = await deleteFilesTool(exec).call({ paths: ['shared/ai-empty'] }, main)
    expect(asked).toHaveLength(0)
    expect(r.isError, JSON.stringify(r.content)).toBeUndefined()
    expect(fs.existsSync(abs('shared/ai-empty'))).toBe(false)
  })

  test('the card stays: an empty folder made on the Files screen, one made in another chat, one with a file in it', async () => {
    componentC(h.ctx).files.mkdir('alice', 'shared/person-empty')
    const a = execOf(chatOf('alice'))
    await deleteFilesTool(a.exec).call({ paths: ['shared/person-empty'] }, a.main)
    expect(a.asked).toHaveLength(1)
    expect(fs.existsSync(abs('shared/person-empty'))).toBe(true)

    const other = chatOf('alice')
    const t = turnIn(other, 'alice')
    put('users/alice/em2/a.md')
    await move(t, ['users/alice/em2/a.md'], 'shared/other-chat')
    await move(t, ['shared/other-chat/a.md'], 'users/alice/em2')
    const b = execOf(chatOf('alice'))
    await deleteFilesTool(b.exec).call({ paths: ['shared/other-chat'] }, b.main)
    expect(b.asked).toHaveLength(1)

    const own = chatOf('alice')
    const t2 = turnIn(own, 'alice')
    put('users/alice/em3/a.md')
    await move(t2, ['users/alice/em3/a.md'], 'shared/not-empty')
    put('shared/not-empty/someone.md')
    const c = execOf(own)
    await deleteFilesTool(c.exec).call({ paths: ['shared/not-empty'] }, c.main)
    expect(c.asked).toHaveLength(1)
  })
})

describe('Always allow notes say what they cover (TC-ask2-15)', () => {
  const generic = (L: Locale) => tr('cardAlwaysNote', L)
  test('every card kind has its own line in every language, ending with where to undo it', () => {
    for (const kind of CARD_ALWAYS_KINDS) {
      for (const L of LOCALE_ORDER) {
        const note = alwaysNote(kind, L)
        expect([kind, L, note === generic(L)]).toEqual([kind, L, false])
        expect(note).not.toContain('{what}')
      }
      expect(alwaysNote(kind, 'ko')).toContain('설정 › 트리나에게 허용한 것에서 되돌릴 수 있어요.')
    }
    expect(alwaysNote('delete_files', 'ko')).toContain('파일을 휴지통으로 옮길 때')
    expect(alwaysNote('delete_files', 'en')).toContain('before it moves files to the trash')
    expect(alwaysNote('room_change', 'ko')).toContain('대화를 읽은 뒤')
  })
  test('the move card\'s note covers copies too', () => {
    expect(alwaysNote('move_files', 'ko')).toContain('옮기거나 복사')
    expect(alwaysNote('move_files', 'en')).toContain('moves or copies')
    expect(TEXT.cardAlwaysNoteMoveFiles.ja).toContain('コピー')
  })
})

describe('a person\'s own move to Company-wide (S-018)', () => {
  test('out of a group folder with askWiden: 409 audience_widened with the count; confirmed: moved', async () => {
    put('groups/marketing/s018.md')
    const body = { from: 'groups/marketing/s018.md', to: 'shared/s018.md', onExists: 'fail', askWiden: true }
    const r = await h.req('alice', '/api/files/move', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect(r.status).toBe(409)
    const raw = await r.json() as { error?: { params?: { reason?: string; viewersAdded?: number } }; params?: { reason?: string; viewersAdded?: number } }
    const e = raw.error ?? raw
    expect(e.params?.reason).toBe('audience_widened')
    expect(e.params?.viewersAdded).toBeGreaterThan(0)
    const ok = await h.api('alice').call(API.move, { body: { ...body, onExists: 'fail' as const, confirm: true, skillsOk: false } })
    expect(ok.entry.path).toBe('shared/s018.md')
  })
})

describe('the many-items cards give the AI their own count (S-122)', () => {
  test('rename_files of many in a shared folder: the result says the card\'s number', async () => {
    for (let i = 0; i < 15; i++) put(`shared/bulk-s122/f${i}.txt`)
    const chatId = chatOf('alice')
    const turnId = turnIn(chatId, 'alice')
    const questions: string[] = []
    const person: TurnPerson = { locale: 'en', async confirm(q) { questions.push(q); return true }, async confirmWhy(q) { questions.push(q); return 'yes' }, *turnUrls() {} }
    const tc = { user: h.ctx.files.principal('alice'), turnId, files: new TurnFiles(), person }
    const r = await makeHandler(h.ctx.files, h.ctx.db, tc)({ jsonrpc: '2.0', id: 9001, method: 'tools/call', params: { name: 'rename_files', arguments: { folder: 'shared/bulk-s122', find: 'f', replace: 'g' } } })
    expect(questions).toHaveLength(1)
    const n = Number(/(\d+) (?:other )?(?:people|person)/.exec(questions[0]!)?.[1])
    expect(n).toBeGreaterThan(0)
    expect(r.result.content[0].text).toContain(bulkResult(n))
  })
  test('the texts', () => {
    expect(bulkResult(undefined)).toBe('')
    expect(bulkResult(17)).toContain('17 people other than them')
    expect(bulkWhoForAi({ kind: 'some', n: 17 })).toContain('17 people can see the project folder')
    expect(bulkWhoForAi(null)).toBe('')
  })
})
