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
export const PROJECT = { name: '라마바카페 납품', folderPath: 'projects/라마바카페-납품' }
export const ROOM_NAME = '라마바카페 건'

export const COMPANY: DemoCompany = {
  teamName: '가나다오피스',
  people: [
    { username: 'jiwoo', name: '김지우', role: 'owner', group: null },
    { username: 'minho', name: '박민호', role: 'admin', group: null },
    { username: 'sora', name: '이소라', role: 'member', group: '영업' },
    { username: 'daniel', name: 'Daniel Kim', role: 'member', group: '영업' },
    { username: 'hana', name: '최하나', role: 'member', group: '마케팅' },
    { username: 'junho', name: '정준호', role: 'member', group: '재무' },
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
  settings: { timeZone: 'Asia/Seoul' },
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

export async function seedFixture(o: { base: string; setupToken: string | null; log: (s: string) => void }): Promise<FixtureState> {
  // 1. people, groups, folder rules, the project, the team files
  await seedDemo({ baseUrl: o.base, setupToken: o.setupToken, company: COMPANY, ownerPassword: PASSWORD, locale: 'ko', log: o.log })
  const owner = await login(o.base, 'jiwoo', PASSWORD)
  const users = (await owner.call(API.listUsers)).items
  const id = (u: string) => {
    const x = users.find((p) => p.username === u)
    if (!x) throw new Error(`fixture: no user ${u}`)
    return x.id
  }
  // personal files, each uploaded by its person into their own folder (the server makes users/<name>/ itself)
  for (const u of fs.readdirSync(PERSONAL_FILES)) {
    const c = await login(o.base, u, PASSWORD)
    for (const name of fs.readdirSync(path.join(PERSONAL_FILES, u))) {
      try {
        await c.call(API.upload, { body: { fields: { folder: `users/${u}`, name: name.normalize('NFC'), onExists: 'fail' }, file: new Blob([fs.readFileSync(path.join(PERSONAL_FILES, u, name))]), filename: name.normalize('NFC') } })
      } catch (e) { if (!(e instanceof ApiError && e.status === 409)) throw e }
    }
  }
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
