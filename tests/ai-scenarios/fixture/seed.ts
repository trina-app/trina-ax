// The AI scenario fixture: a made-up Korean office-supply company, "가나다오피스" (Ganada Office), with an owner, an admin,
// members in three groups, a guest, a shared team project, a group chat, team skills and realistic files. Every person,
// company and number is fictional (the company names follow the 가나다 placeholder of tests/fixtures/hwp).
//
// It is seeded through the public REST API on an EMPTY server (tests/ai-scenarios/cli.ts `up`), with the demo seeder for
// people, groups, folder rules, the project and the team files (scripts/demo/seed.ts), then the parts the demo seeder has no
// field for: personal files, a group chat with messages, a guest in the project, the people's languages.
import fs from 'node:fs'
import path from 'node:path'
import { API, ApiClient, ApiError } from '../../../shared/src/api'
import { DEMO_PASSWORD, seedDemo, type DemoCompany } from '../../../scripts/demo/seed'

export const FIXTURE_FILES = path.join(import.meta.dir, 'files')
/** personal files: personal/<username>/<name>, uploaded by that person into their own folder users/<username>/ */
export const PERSONAL_FILES = path.join(import.meta.dir, 'personal')
/** every fixture account signs in with this (a local, throwaway test server; never a real team) */
export const PASSWORD = DEMO_PASSWORD
export const GUEST = { username: 'partner', name: '라마바카페 구매담당', password: DEMO_PASSWORD }
/** the team's time zone (Admin › Team settings) */
export const TEAM_ZONE = 'Asia/Seoul'
export const PROJECT = { name: '라마바카페 납품', folderPath: 'projects/라마바카페-납품' }
export const ROOM_NAME = '라마바카페 건'
export const LEADS_ROOM_NAME = 'leads'
/** files people sent in chat rooms (not team files): fixture/chatfiles/, made by make-files.py */
export const CHAT_FILES = path.join(import.meta.dir, 'chatfiles')

export const COMPANY: DemoCompany = {
  teamName: '가나다오피스',
  people: [
    { username: 'jiwoo', name: '김지우', role: 'owner', group: null },
    { username: 'minho', name: '박민호', role: 'admin', group: null },
    { username: 'sora', name: '이소라', role: 'member', group: '영업' },
    { username: 'daniel', name: 'Daniel Kim', role: 'member', group: '영업' },
    { username: 'hana', name: '최하나', role: 'member', group: '마케팅' },
    { username: 'junho', name: '정준호', role: 'member', group: '재무' },
    { username: 'kanghyun', name: '이강현', role: 'member', group: null },
    { username: 'minji', name: '김민지', role: 'member', group: null },
    { username: 'doyun', name: '박도윤', role: 'member', group: null },
    { username: 'daeun', name: '정다은', role: 'member', group: null },
  ],
  groups: [
    { name: '영업', description: '거래처, 견적, 계약' },
    { name: '마케팅', description: '신제품 소개, 사진, 홍보' },
    { name: '재무', description: '정산, 비용, 급여' },
  ],
  rules: [
    { path: 'groups/재무/급여', rules: [], limited: true, why: 'payroll: limited, only the owner and admins' },
    { path: PROJECT.folderPath, rules: [{ group: '영업', access: 'write' }, { user: 'hana', access: 'write' }], why: 'project members: 영업 + 최하나' },
  ],
  filesDir: FIXTURE_FILES,
  uploaderOf(rel) {
    if (rel.startsWith('groups/영업/') || rel.startsWith(PROJECT.folderPath + '/')) return 'sora'
    if (rel.startsWith('groups/마케팅/')) return 'hana'
    if (rel.startsWith('groups/재무/') && !rel.startsWith('groups/재무/급여/')) return 'junho'
    if (rel.startsWith('shared/회의록/')) return 'minho'
    return 'jiwoo'
  },
  project: {
    ...PROJECT,
    instructions: '라마바카페(가상의 거래처)와의 연간 납품 계약 프로젝트입니다. 견적서, 방문 보고서, 계약 관련 파일을 이 폴더에 둡니다.',
  },
  profile: {
    website: '', name: '가나다오피스', oneLine: '서울의 사무용품 유통 회사(가상)', products: '복사용지, 문구, 사무 소모품 납품',
    audience: '카페, 학원, 병원 같은 소규모 거래처', tone: ['정중하게', '짧게'], avoid: '', sources: [],
  },
  settings: { timeZone: TEAM_ZONE },
}

export interface FixtureState {
  base: string
  people: Record<string, { id: string; role: string }>
  guest: { id: string; username: string } | null
  projectId: string
  roomId: string
  seededAt: string
}

const login = async (base: string, username: string, password: string) => {
  const r = await new ApiClient({ baseUrl: base }).call(API.login, { body: { username, password, client: 'web', tokenMode: 'bearer' } })
  return new ApiClient({ baseUrl: base, token: r.token! })
}

export async function seedFixture(o: { base: string; setupToken: string | null; log: (s: string) => void; dataDir?: string }): Promise<FixtureState> {
  // 1. people, groups, folder rules, the project, the team files
  await seedDemo({ baseUrl: o.base, setupToken: o.setupToken, company: COMPANY, ownerPassword: PASSWORD, locale: 'ko', log: o.log })
  const owner = await login(o.base, 'jiwoo', PASSWORD)
  const users = (await owner.call(API.listUsers)).items
  const id = (u: string) => {
    const x = users.find((p) => p.username === u)
    if (!x) throw new Error(`fixture: no user ${u}`)
    return x.id
  }
  // personal files, each uploaded by its person into their own folder (the server makes users/<name>/ itself); a folder in
  // personal/<name>/ goes in with its files
  const putPersonal = async (c: ApiClient, folder: string, dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = ent.name.normalize('NFC')
      if (ent.isDirectory()) {
        try { await c.call(API.mkdir, { body: { path: `${folder}/${name}` } }) } catch (e) { if (!(e instanceof ApiError && e.status === 409)) throw e }
        await putPersonal(c, `${folder}/${name}`, path.join(dir, ent.name))
        continue
      }
      try {
        await c.call(API.upload, { body: { fields: { folder, name, onExists: 'fail' }, file: new Blob([fs.readFileSync(path.join(dir, ent.name))]), filename: name } })
      } catch (e) { if (!(e instanceof ApiError && e.status === 409)) throw e }
    }
  }
  for (const u of fs.readdirSync(PERSONAL_FILES)) await putPersonal(await login(o.base, u, PASSWORD), `users/${u}`, path.join(PERSONAL_FILES, u))
  // TC-4550: hana's quotes folder already holds today's first quote (today in the team's zone, as the AI reads it), so a
  // new quote made with her quick-quote skill takes -02. Made at every `up`: a fixture file could not carry today's date.
  {
    const hana = await login(o.base, 'hana', PASSWORD)
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: TEAM_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).replaceAll('-', '')
    try { await hana.call(API.mkdir, { body: { path: 'users/hana/견적' } }) } catch (e) { if (!(e instanceof ApiError && e.status === 409)) throw e }
    const name = `Q-${today}-01-다라치과.md`
    const text = `# 견적서\n\n- 견적번호: Q-${today}-01\n- 거래처: 다라 치과의원\n\n| 품목 | 수량 | 단가 | 금액 |\n|---|---|---|---|\n| A4 복사용지 (박스) | 5 | 27,000 | 135,000 |\n\n공급가액 135,000원 · 부가세 13,500원 · 합계 148,500원\n`
    try { await hana.call(API.upload, { body: { fields: { folder: 'users/hana/견적', name, onExists: 'fail' }, file: new Blob([text]), filename: name } }) } catch (e) { if (!(e instanceof ApiError && e.status === 409)) throw e }
  }
  // what sora shared by name (for the "shared with me" cases): her visit memo with hana, her proposal folder with daniel.
  // Both are view only; a share that the server refuses (a team without file sharing) is only said, the cases then fail as setup.
  const sora0 = await login(o.base, 'sora', PASSWORD)
  const share = async (p: string, who: string) => {
    try { await sora0.call(API.putFileShares, { body: { path: p, add: [{ subjectType: 'user', subjectId: id(who) }], remove: [] } }) } catch (e) { o.log(`fixture: could not share ${p} with ${who}: ${e instanceof Error ? e.message : e}`) }
  }
  await share('users/sora/거래처-방문-메모.md', 'hana')
  await share('users/sora/제안서-초안', 'daniel')
  // Daniel works in English
  const daniel = await login(o.base, 'daniel', PASSWORD)
  await daniel.call(API.updateMe, { body: { locale: 'en' } })

  // 2. the project
  const project = (await owner.call(API.listProjects)).items.find((p) => p.name === PROJECT.name)
  if (!project) throw new Error('fixture: the project was not made')

  // 3. a group chat about the client, with a few messages (sora, daniel, minho; hana is not in it)
  const sora = await login(o.base, 'sora', PASSWORD)
  let room = (await sora.call(API.listRooms)).items.find((r) => r.name === ROOM_NAME)
  if (!room) {
    room = await sora.call(API.createRoom, { body: { kind: 'group', userIds: [id('daniel'), id('minho')], name: ROOM_NAME } })
    const minho = await login(o.base, 'minho', PASSWORD)
    const say = async (c: ApiClient, text: string) => { await c.call(API.sendRoomMessage, { params: { id: room!.id }, body: { body: text, mentions: [], clientMessageId: crypto.randomUUID() } }); await Bun.sleep(50) }
    await say(sora, '라마바카페에서 복사용지 단가 26,500원 요청했어요. 연간 계약 조건이에요.')
    await say(minho, '27,000원까지는 괜찮아요. 그 아래는 대표님 승인 받아야 합니다.')
    await say(daniel, 'I can visit them on Thursday with the refill pen samples.')
    await say(sora, '수정 견적서는 목요일(11/13)까지 보낼게요. 직인 찍어서요.')
    await say(minho, '계약서 초안은 월요일까지 검토해 둘게요.')
    // a thread under the first message, and the quote sent into the room as a file
    const first = (await sora.call(API.listRoomMessages, { params: { id: room.id }, query: {} })).items.find((x) => x.body.includes('26,500'))
    if (first) {
      await daniel.call(API.sendRoomMessage, { params: { id: room.id }, body: { body: 'They also asked if we deliver on Saturdays. Can we?', threadRootId: first.id, mentions: [], clientMessageId: crypto.randomUUID() } })
      await sora.call(API.sendRoomMessage, { params: { id: room.id }, body: { body: '토요일은 퀵으로만 가능해요. 배송비 따로 받고요.', threadRootId: first.id, mentions: [], clientMessageId: crypto.randomUUID() } })
    }
    const quote = 'groups/영업/견적서/견적서-라마바카페-2026-11.pdf'
    const f = await sora.call(API.uploadRoomFile, { params: { id: room.id }, body: { fields: {}, file: new Blob([fs.readFileSync(path.join(FIXTURE_FILES, quote))], { type: 'application/pdf' }), filename: '견적서-라마바카페-초안.pdf' } })
    await sora.call(API.sendRoomMessage, { params: { id: room.id }, body: { body: '지난번 보낸 견적서 초안이에요.', fileIds: [f.id], mentions: [], clientMessageId: crypto.randomUUID() } })
  }

  // 3b. files sent in chat (the "find a file somebody sent me in a room" cases): all file-only messages whose text never
  //     names the file. (a) sora -> kanghyun DM: 계좌신고서.xlsx, dated a week ago; (b) the group chat `leads` (sora, daniel,
  //     kanghyun) with a thread under the root whose replies are only files (사업자등록증.pdf, 리드-목록.xlsx); (c) minji -> sora
  //     DM: 견적서-민지.xlsx.
  {
    const kanghyun = await login(o.base, 'kanghyun', PASSWORD)
    const minji = await login(o.base, 'minji', PASSWORD)
    const mimeOf = (n: string) => n.endsWith('.pdf') ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    const sendFile = async (c: ApiClient, roomId: string, name: string, text: string, threadRootId?: string) => {
      const f = await c.call(API.uploadRoomFile, { params: { id: roomId }, body: { fields: {}, file: new Blob([fs.readFileSync(path.join(CHAT_FILES, name))], { type: mimeOf(name) }), filename: name } })
      const m = await c.call(API.sendRoomMessage, { params: { id: roomId }, body: { body: text, fileIds: [f.id], ...(threadRootId ? { threadRootId } : {}), mentions: [], clientMessageId: crypto.randomUUID() } })
      await Bun.sleep(50)
      return { message: m, file: f }
    }
    const dmK = await sora.call(API.createRoom, { body: { kind: 'dm', userId: id('kanghyun') } })
    const sentReport = await sendFile(sora, dmK.id, '계좌신고서.xlsx', '보내드려요')
    let leads = (await sora.call(API.listRooms)).items.find((r) => r.name === LEADS_ROOM_NAME)
    const backdate: { roomId: string; messageId: string; fileId: string; daysAgo: number }[] = [{ roomId: dmK.id, messageId: sentReport.message.id, fileId: sentReport.file.id, daysAgo: 7 }]
    if (!leads) {
      leads = await sora.call(API.createRoom, { body: { kind: 'group', userIds: [id('daniel'), id('kanghyun')], name: LEADS_ROOM_NAME } })
      const root = await sora.call(API.sendRoomMessage, { params: { id: leads.id }, body: { body: '신규 리드 서류 여기 모아둘게요', mentions: [], clientMessageId: crypto.randomUUID() } })
      await sendFile(sora, leads.id, '사업자등록증.pdf', '올렸어요', root.id)
      await sendFile(sora, leads.id, '리드-목록.xlsx', '이것도요', root.id)
    }
    const dmM = await minji.call(API.createRoom, { body: { kind: 'dm', userId: id('sora') } })
    await sendFile(minji, dmM.id, '견적서-민지.xlsx', '확인 부탁드려요')
    // The public API cannot backdate: set created_at of the 계좌신고서 message and its room_files row to 7 days ago directly in
    // the server's SQLite (WAL mode, a short write with a busy timeout; the server is idle while seeding). Without a data
    // folder the message keeps today's date and the "last week" wording of the case is then only approximate.
    if (o.dataDir) {
      const { Database } = await import('bun:sqlite')
      const db = new Database(path.join(o.dataDir, 'app.db'))
      db.exec('PRAGMA busy_timeout = 10000')
      for (const b of backdate) {
        const at = new Date(Date.now() - b.daysAgo * 86400_000).toISOString()
        db.query('UPDATE room_messages SET created_at = ? WHERE id = ?').run(at, b.messageId)
        db.query('UPDATE room_files SET created_at = ? WHERE id = ?').run(at, b.fileId)
        o.log(`backdated ${b.messageId} to ${at}`)
      }
      db.close()
    } else o.log('fixture: no data folder, the 계좌신고서 message keeps today\'s date')
  }

  // 3c. the same three situations in BUSY rooms: the file-only message is buried under newer ordinary messages, so a default
  //     read of the room (the newest 50) does not reach it (RFILE-0x.busy). Other people and other file names than 3b, so a
  //     search in the easy rooms never meets the busy ones: (a) sora -> doyun DM, 환불계좌-신청서.xlsx a week ago, then 80 newer
  //     messages; (b) the group chat 영업-리드 (sora, daniel, doyun): a root with a thread (통장사본.pdf, 리드-목록.xlsx), then
  //     70 newer root messages; (c) daeun -> sora DM, 견적서-다은.xlsx, then 80 newer messages. The filler is written straight
  //     into SQLite like the backdating (seq from rooms.last_seq, as the server does), spread over the days after the file.
  if (o.dataDir) {
    const doyun = await login(o.base, 'doyun', PASSWORD)
    const daeun = await login(o.base, 'daeun', PASSWORD)
    const mimeOf2 = (n: string) => n.endsWith('.pdf') ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    const send2 = async (c: ApiClient, roomId: string, name: string, text: string, threadRootId?: string) => {
      const f = await c.call(API.uploadRoomFile, { params: { id: roomId }, body: { fields: {}, file: new Blob([fs.readFileSync(path.join(CHAT_FILES, name))], { type: mimeOf2(name) }), filename: name } })
      const m = await c.call(API.sendRoomMessage, { params: { id: roomId }, body: { body: text, fileIds: [f.id], ...(threadRootId ? { threadRootId } : {}), mentions: [], clientMessageId: crypto.randomUUID() } })
      await Bun.sleep(50)
      return { message: m, file: f }
    }
    const BUSY_LEADS = '영업-리드'
    const dmD = await sora.call(API.createRoom, { body: { kind: 'dm', userId: id('doyun') } })
    const refund = await send2(sora, dmD.id, '환불계좌-신청서.xlsx', '보내드려요')
    const busyLeads = await sora.call(API.createRoom, { body: { kind: 'group', userIds: [id('daniel'), id('doyun')], name: BUSY_LEADS } })
    const busyRoot = await sora.call(API.sendRoomMessage, { params: { id: busyLeads.id }, body: { body: '이번 달 신규 리드 서류 모아둘게요', mentions: [], clientMessageId: crypto.randomUUID() } })
    await send2(sora, busyLeads.id, '통장사본.pdf', '올렸어요', busyRoot.id)
    await send2(sora, busyLeads.id, '리드-목록.xlsx', '이것도요', busyRoot.id)
    const dmE = await daeun.call(API.createRoom, { body: { kind: 'dm', userId: id('sora') } })
    const quoteE = await send2(daeun, dmE.id, '견적서-다은.xlsx', '확인 부탁드려요')
    const LINES = ['점심 뭐 드실래요?', '오늘 회의 몇 시였죠?', '네, 확인했습니다.', '조금 늦을 것 같아요.', '내일 오전에 전화드릴게요.', '감사합니다!', '그 건은 다음 주에 얘기해요.',
      '비 오네요, 우산 챙기세요.', '프린터 용지가 떨어졌어요.', '일정 공유 드려요.', '좋아요, 그렇게 해요.', '잠깐 통화 가능하세요?', '커피 한잔 하실래요?', '월요일에 뵙겠습니다.',
      '샘플은 내일 도착한대요.', '네, 알겠습니다.', '퇴근 전에 한 번 더 볼게요.', '주차 자리 있어요?', '회의실 예약해 둘게요.', '오늘 정말 바쁘네요.']
    const db = new (await import('bun:sqlite')).Database(path.join(o.dataDir, 'app.db'))
    db.exec('PRAGMA busy_timeout = 10000')
    const put = (roomId: string, author: string, body: string, at: string) => {
      const seq = (db.query('UPDATE rooms SET last_seq = last_seq + 1 WHERE id = ? RETURNING last_seq').get(roomId) as { last_seq: number }).last_seq
      db.query(`INSERT INTO room_messages (id, room_id, seq, author_kind, author_id, visibility, body, mentions, created_at) VALUES (?, ?, ?, 'user', ?, 'room', ?, '[]', ?)`).run(crypto.randomUUID(), roomId, seq, author, body, at)
    }
    const day = 86400_000
    const t0 = Date.now()
    const filler = (roomId: string, authors: string[], n: number, fromDaysAgo: number) => {
      for (let i = 0; i < n; i++) {
        const at = new Date(t0 - fromDaysAgo * day + (i + 1) * ((fromDaysAgo - 0.1) * day / (n + 1))).toISOString()
        put(roomId, authors[i % authors.length]!, `${LINES[(i * 7 + 3) % LINES.length]} (${i + 1})`, at)
      }
      db.query('UPDATE rooms SET activity_at = ? WHERE id = ?').run(new Date(t0 - 0.1 * day).toISOString(), roomId)
    }
    // the file messages: dated 7 days (the form), 3 days (the thread), 6 days (the quote) ago; the filler comes after them
    const setAt = (mid: string, fid: string | null, daysAgo: number) => {
      const at = new Date(t0 - daysAgo * day).toISOString()
      db.query('UPDATE room_messages SET created_at = ? WHERE id = ?').run(at, mid)
      if (fid) db.query('UPDATE room_files SET created_at = ? WHERE id = ?').run(at, fid)
    }
    setAt(refund.message.id, refund.file.id, 7)
    setAt(busyRoot.id, null, 3.05)
    db.query('UPDATE room_messages SET created_at = ? WHERE thread_root_id = ?').run(new Date(t0 - 3 * day).toISOString(), busyRoot.id)
    db.query('UPDATE room_files SET created_at = ? WHERE room_id = ?').run(new Date(t0 - 3 * day).toISOString(), busyLeads.id)
    setAt(quoteE.message.id, quoteE.file.id, 6)
    filler(dmD.id, [id('sora'), id('doyun')], 80, 6.9)
    filler(busyLeads.id, [id('sora'), id('daniel'), id('doyun')], 70, 3)
    filler(dmE.id, [id('sora'), id('daeun')], 80, 5.9)
    db.close()
    o.log('busy rooms seeded (80 / 70 / 80 newer messages after the files)')
  }

  // 4. a guest: the client's buyer, invited into the project by the owner (no AI on a server that runs on this Mac's own
  //    sign-in: credentials/guest-ai.ts)
  let guest: FixtureState['guest'] = null
  const existing = users.find((u) => u.username === GUEST.username)
  if (existing) guest = { id: existing.id, username: GUEST.username }
  else {
    const inv = await owner.call(API.createGuestInvite, { body: { place: { kind: 'project', id: project.id }, ai: { mode: 'none' }, expiresInHours: 24, name: GUEST.name } })
    const r = await new ApiClient({ baseUrl: o.base }).call(API.acceptInvite, { params: { token: inv.token }, body: { username: GUEST.username, name: GUEST.name, password: GUEST.password, client: 'web', tokenMode: 'bearer' } })
    guest = { id: r.me.user.id, username: GUEST.username }
    o.log('guest partner joined the project')
  }

  const people: FixtureState['people'] = {}
  for (const u of (await owner.call(API.listUsers)).items) people[u.username] = { id: u.id, role: u.role }
  return { base: o.base, people, guest, projectId: project.id, roomId: room.id, seededAt: new Date().toISOString() }
}

/** the fixture's files by team path (what a case may name and what a restore puts back) */
export function fixtureFile(rel: string): string {
  const p = path.join(FIXTURE_FILES, rel)
  if (!fs.existsSync(p)) throw new Error(`no fixture file ${rel}`)
  return p
}
