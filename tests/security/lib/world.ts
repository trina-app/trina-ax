// The team every matrix case runs against, built only through the public API of an isolated instance.
//
//   owner      dana   role owner
//   admin      carol  role admin
//   memberIn   alice  member of group "marketing"; personal write on projects/falcon
//   other      erin   member of group "marketing" too (the colleague a group folder is shared with)
//   memberOut  bob    member of group "finance" only (not in marketing): read on projects/falcon
//   pwchange   frank  member who still has to change the temporary password
//   anon       nobody signed in
//
// Folders (design tab 2): shared/ everyone write · skills/ everyone read, admin write · groups/marketing marketing
// write · groups/marketing/salaries marketing none · groups/finance finance write · projects/falcon alice write +
// finance read · projects/falcon/public everyone read · users/<id>/ only that person (owner and admin included).
//
// Every private thing carries a canary string; a "deny" case also fails when its response contains one.
import { API } from '@mycel/shared/api'
import { componentC } from '../../../server/src/team-files/component'
import { SETUP_TOKEN, type Client, type Instance, type Socket } from './instance'

export const PW: Record<string, string> = {
  dana: 'Zebra-copper-4417-kite', carol: 'Quail-silver-8812-lamp', alice: 'Heron-amber-2290-gate',
  bob: 'Marlin-ochre-6633-wren', erin: 'Otter-cobalt-5521-fern', frank: 'Lynx-violet-7744-moss',
}

/** Canaries: where each lives and who may see it. */
export const C = {
  aliceFile: 'SEC-ALICE-FILE-7f3',          // users/alice/todo.md (v2)
  aliceFileOld: 'SEC-ALICE-OLDVER-19c',     // users/alice/todo.md (v1, a version)
  aliceFileName: 'SEC-ALICE-NAME-55a',      // a file NAME inside users/alice/
  aliceTrashName: 'SEC-ALICE-TRASHED-4d1',  // a trashed file name in users/alice/
  aliceChatTitle: 'SEC-ALICE-CHATTITLE-9e2',
  aliceMsg: 'SEC-ALICE-MSG-31b',
  aliceAnswer: 'SEC-ALICE-ANSWER-6c0',
  aliceArtifact: 'SEC-ALICE-ARTIFACT-0d8',
  aliceMemory: 'SEC-ALICE-MEMORY-2a7',
  aliceQuestion: 'SEC-ALICE-QUESTION-8b4',
  aliceAttName: 'SEC-ALICE-ATTACH-ab3',
  aliceProjInstr: 'SEC-ALICE-PROJINSTR-71e',
  aliceUploadName: 'SEC-ALICE-UPLOAD-c62',
  aliceTranscript: 'SEC-ALICE-TRANSCRIPT-e90',
  bobFile: 'SEC-BOB-PRIVATE-0f4',
  finFile: 'SEC-FIN-BUDGET-3c9',
  finFileOld: 'SEC-FIN-OLDVER-d17',
  finTrashName: 'SEC-FIN-TRASHED-a88',
  finName: 'SEC-FIN-NAME-b20',              // a file NAME in groups/finance
  salary: 'SEC-SALARY-5e6',                 // groups/marketing/salaries (marketing: none)
  mktBrief: 'SEC-MKT-BRIEF-42d',            // groups/marketing (marketing write)
  mktInstr: 'SEC-MKT-INSTR-0b1',
  falconPlan: 'SEC-FALCON-PLAN-1aa',        // projects/falcon (alice write, finance read)
  falconInstr: 'SEC-FALCON-INSTR-7c3',
  aliceSuggestion: 'SEC-ALICE-SKILLSUGGEST-3f8', // a skill alice suggested: alice + the managers of skills/ (owner, admin)
} as const

export type Who = 'owner' | 'admin' | 'memberIn' | 'other' | 'memberOut' | 'pwchange' | 'anon'
export const WHO: Who[] = ['owner', 'admin', 'memberIn', 'other', 'memberOut', 'pwchange', 'anon']
export const USER_OF: Record<Who, string | null> = { owner: 'dana', admin: 'carol', memberIn: 'alice', other: 'erin', memberOut: 'bob', pwchange: 'frank', anon: null }

export interface World {
  inst: Instance
  as: Record<Who, Client>
  /** desktop-client sessions (browser relay) */
  desktop: Record<'alice' | 'bob', Client>
  groups: { marketing: string; finance: string; mktFolder: string; finFolder: string }
  folders: Record<string, string>
  ids: {
    chatA: string; chatB: string; userMsg: string; assistantMsg: string; turnB: string; requestB: string
    artifact: string; memory: string; attachment: string; projAlice: string; projFalcon: string; projMkt: string; projShared: string
    uploadAlice: string; jobAlice: string; jobSystem: string; aliceVersion: string; finVersion: string
    trashAlice: string; trashFin: string; aliceSession: string; invite: string; inviteToken: string; resetToken: string
    budget: string; bobChat: string; suggestion: string
  }
  sockets: Record<'alice' | 'bob' | 'carol' | 'dana' | 'erin', Socket>
}

/** A throwaway signed-in client for a persona, so auth-flow cases (login / accept-invite / logout / reauth) can run
 *  without swapping or destroying the shared persona client's session. anon -> a logged-out client. */
export async function freshClient(w: World, who: Who): Promise<Client> {
  const user = USER_OF[who]
  const c = w.inst.client(`fresh-${who}`)
  if (user) { try { await c.login(user, PW[user]) } catch { /* pwchange / disabled: stays logged out */ } }
  return c
}

const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()
const sha = (s: string) => new Bun.CryptoHasher('sha256').update(s).digest('hex')
// 1x1 PNG
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

export function pngForm(fields: Record<string, string>, name: string): FormData {
  const f = new FormData()
  for (const [k, v] of Object.entries(fields)) f.set(k, v)
  f.set('file', new File([PNG], name, { type: 'image/png' }))
  return f
}

async function save(c: Client, p: string, content: string) {
  const cur = await c.req('GET', `/api/files/content?path=${encodeURIComponent(p)}`)
  const base = cur.status === 200 ? cur.json.sha256 : null
  return c.ok('PUT', '/api/files/content', { path: p, content, baseSha256: base })
}

export async function buildWorld(inst: Instance): Promise<World> {
  const as = Object.fromEntries(WHO.map((w) => [w, inst.client(w)])) as Record<Who, Client>
  const owner = as.owner
  // first owner (setup token), then everyone else through the admin API
  await owner.ok('POST', '/api/setup', { setupToken: SETUP_TOKEN, teamName: 'Sec Team', locale: 'en', owner: { username: 'dana', name: 'Dana Owner', password: PW.dana } })
  const people: [Who, string, string, 'admin' | 'member'][] = [
    ['admin', 'carol', 'Carol Admin', 'admin'], ['memberIn', 'alice', 'Alice Kim', 'member'], ['other', 'erin', 'Erin Yoo', 'member'],
    ['memberOut', 'bob', 'Bob Lee', 'member'], ['pwchange', 'frank', 'Frank Ma', 'member'],
  ]
  for (const [who, username, name, role] of people) {
    const r = await owner.ok('POST', '/api/admin/users', { username, name, role, id: username, locale: 'en' })
    await as[who].login(username, r.temporaryPassword)
    if (who === 'pwchange') PW[username] = r.temporaryPassword
    else await as[who].ok('POST', '/api/auth/password', { currentPassword: r.temporaryPassword, newPassword: PW[username] })
  }
  const mk = await owner.ok('POST', '/api/admin/groups', { name: 'marketing', memberIds: ['alice', 'erin'] })
  const fin = await owner.ok('POST', '/api/admin/groups', { name: 'finance', memberIds: ['bob'] })
  const rule = (subjectType: string, subjectId: string | null, access: string) => ({ subjectType, subjectId, access })
  await owner.ok('POST', '/api/admin/folders', { path: 'projects/falcon', create: true, rules: [rule('user', 'alice', 'write'), rule('group', fin.id, 'read')] })
  await owner.ok('POST', '/api/admin/folders', { path: 'projects/atlas', create: true, rules: [rule('user', 'alice', 'write'), rule('group', fin.id, 'read')] })
  await owner.ok('POST', '/api/admin/folders', { path: 'projects/falcon/public', create: true, rules: [rule('everyone', null, 'read')] })
  const folderList = (await owner.ok('GET', '/api/admin/folders')).items as { id: string; path: string }[]
  const mktFolder = folderList.find((f) => f.path.startsWith('groups/') && f.path.includes('marketing'))!.path
  const finFolder = folderList.find((f) => f.path.startsWith('groups/') && f.path.includes('finance'))!.path
  await owner.ok('POST', '/api/admin/folders', { path: `${mktFolder}/salaries`, create: true, rules: [rule('group', mk.id, 'none')] })
  const folders = Object.fromEntries(((await owner.ok('GET', '/api/admin/folders')).items as { id: string; path: string }[]).map((f) => [f.path, f.id]))

  // ---------------- files ----------------
  const { alice, bob, carol, dana } = { alice: as.memberIn, bob: as.memberOut, carol: as.admin, dana: as.owner }
  await save(alice, 'users/alice/todo.md', `# todo\n${C.aliceFileOld}\n`)
  await save(alice, 'users/alice/todo.md', `# todo\n${C.aliceFile}\n`)
  await save(alice, `users/alice/${C.aliceFileName}.md`, 'name canary\n')
  await save(bob, 'users/bob/notes.md', `${C.bobFile}\n`)
  await save(bob, `${finFolder}/budget.md`, `${C.finFileOld}\n`)
  await save(bob, `${finFolder}/budget.md`, `${C.finFile}\n`)
  await save(bob, `${finFolder}/${C.finName}.md`, 'finance name canary\n')
  await save(carol, `${mktFolder}/salaries/2026.md`, `${C.salary}\n`)
  await save(alice, `${mktFolder}/brief.md`, `${C.mktBrief}\n`)
  await save(alice, 'projects/falcon/plan.md', `${C.falconPlan}\n`)
  await save(dana, 'projects/falcon/public/announce.md', 'falcon public announcement\n')
  await save(dana, 'shared/readme.md', 'shared readme\n')
  await save(alice, 'projects/atlas/atlas.md', 'atlas notes\n')
  await save(carol, 'skills/team-rules.md', 'team rules\n')
  // trash
  await save(bob, `${finFolder}/${C.finTrashName}.md`, 'x\n')
  const trashFin = (await bob.ok('DELETE', `/api/files?path=${encodeURIComponent(`${finFolder}/${C.finTrashName}.md`)}`)).trashId
  await save(alice, `users/alice/${C.aliceTrashName}.md`, 'x\n')
  const trashAlice = (await alice.ok('DELETE', `/api/files?path=${encodeURIComponent(`users/alice/${C.aliceTrashName}.md`)}`)).trashId
  // versions
  const aliceVersion = (await alice.ok('GET', '/api/files/history?path=users%2Falice%2Ftodo.md')).items[0]?.id
  const finVersion = (await bob.ok('GET', `/api/files/history?path=${encodeURIComponent(`${finFolder}/budget.md`)}`)).items[0]?.id

  // ---------------- realtime ----------------
  const sockets = {
    alice: await alice.ws(), bob: await bob.ws(), carol: await carol.ws(), dana: await dana.ws(), erin: await as.other.ws(),
  }
  await sockets.alice.next('hello')

  // ---------------- chats (fake engine) ----------------
  const projAlice = (await alice.ok('POST', '/api/projects', { name: 'Private plan', folderPath: 'users/alice', instructions: C.aliceProjInstr })).id
  const projFalcon = (await alice.ok('POST', '/api/projects', { name: 'Falcon', folderPath: 'projects/falcon', instructions: C.falconInstr })).id
  const projMkt = (await alice.ok('POST', '/api/projects', { name: 'Marketing', folderPath: mktFolder, instructions: C.mktInstr })).id
  const projShared = (await bob.ok('POST', '/api/projects', { name: 'Shared', folderPath: 'shared', instructions: 'shared instructions' })).id
  const chatA = (await alice.ok('POST', '/api/chats', { title: C.aliceChatTitle, projectId: projAlice })).id
  const att = await alice.ok('POST', '/api/uploads', undefined, { form: pngForm({ chatId: chatA, name: `${C.aliceAttName}.png` }, `${C.aliceAttName}.png`) })
  const sent = await alice.ok('POST', `/api/chats/${chatA}/messages`, {
    clientMessageId: cm(), attachmentIds: [att.id], content: `${C.aliceMsg}\n` + fake(
      { tool: 'artifact', args: { action: 'create', key: 'k1', type: 'html', title: 'secret artifact', content: `<p>${C.aliceArtifact}</p>` } },
      { tool: 'remember', args: { text: C.aliceMemory } },
      { say: C.aliceAnswer },
    ),
  })
  // the message carries an attachment (outside content), so the server asks before `remember` keeps anything
  const confirm = await sockets.alice.next('turn.request', (f) => f.data.turnId === sent.turnId, 30_000)
  await alice.ok('POST', `/api/turns/${sent.turnId}/answer`, { kind: 'ask_user', requestId: confirm.data.request.requestId, answer: 'yes' })
  await sockets.alice.next('message.done', (f) => f.data.messageId === sent.assistantMessage.id, 30_000)
  const artifact = (await alice.ok('GET', `/api/chats/${chatA}/artifacts`)).items[0].versions[0].id
  const memory = (await alice.ok('GET', '/api/memories')).items.find((m: any) => m.text.includes(C.aliceMemory))?.id
  // chat B: an open ask_user card
  const chatB = (await alice.ok('POST', '/api/chats', { title: 'second' })).id
  const sentB = await alice.ok('POST', `/api/chats/${chatB}/messages`, { clientMessageId: cm(), attachmentIds: [], content: fake({ tool: 'ask_user', args: { question: `${C.aliceQuestion}?` } }) })
  const card = await sockets.alice.next('turn.request', (f) => f.data.turnId === sentB.turnId, 30_000)
  const bobChat = (await bob.ok('POST', '/api/chats', { title: 'bob chat' })).id

  // ---------------- uploads, jobs, sessions, invites ----------------
  const uploadAlice = (await alice.ok('POST', '/api/upload-sessions', { target: { kind: 'path', path: `users/alice/${C.aliceUploadName}.bin`, onExists: 'rename' }, size: 10, sha256: sha('0123456789') })).id
  const jobs = componentC(inst.ctx).jobs
  const jobAlice = jobs.start({ kind: 'transcribe', userId: 'alice', run: async () => ({ text: C.aliceTranscript, language: 'en', durationSec: 1 }) })
  const jobSystem = jobs.start({ kind: 'backup', userId: null, run: async () => ({ backupId: 'b1', size: 1, createdAt: new Date().toISOString() }) })
  await Bun.sleep(200)
  // a throwaway alice session for the revoke-session matrix case, so running it never kills the shared alice client
  const throwaway = inst.client('alice-throwaway'); await throwaway.login('alice', PW.alice)
  const aliceSession = (await throwaway.ok('GET', '/api/me/sessions')).items.find((s: any) => s.current).id
  const inv = await owner.ok('POST', '/api/admin/invites', { role: 'member', groupIds: [] })
  const reset = await owner.ok('POST', '/api/admin/users/frank/reset-link')
  const budget = (await owner.ok('POST', '/api/admin/budgets', { subjectType: 'user', subjectId: 'alice', period: 'month', limitUsd: 100, action: 'warn' })).id
  // a skill alice suggested from her own file ("스킬로 제안"): only alice and the managers of skills/ may see it
  const suggestion = (await alice.ok('POST', '/api/skills/suggestions', { source: { kind: 'file', path: 'users/alice/todo.md' }, targetFolder: 'skills', name: 'alice skill', content: `${C.aliceSuggestion}\n` })).id

  const desktop = { alice: inst.client('alice-desktop', { client: 'desktop', window: 'win-alice-desk' }), bob: inst.client('bob-desktop', { client: 'desktop', window: 'win-bob-desk' }) }
  await desktop.alice.login('alice', PW.alice, 'desktop')
  await desktop.bob.login('bob', PW.bob, 'desktop')

  return {
    inst, as, desktop, folders, sockets,
    groups: { marketing: mk.id, finance: fin.id, mktFolder, finFolder },
    ids: {
      chatA, chatB, userMsg: sent.userMessage.id, assistantMsg: sent.assistantMessage.id, turnB: sentB.turnId, requestB: card.data.request.requestId,
      artifact, memory, attachment: att.id, projAlice, projFalcon, projMkt, projShared, uploadAlice, jobAlice, jobSystem,
      aliceVersion, finVersion, trashAlice, trashFin, aliceSession, invite: inv.invite.id, inviteToken: inv.token,
      resetToken: reset.token, budget, bobChat, suggestion,
    },
  }
}

export const ALICE_PRIVATE = [C.aliceFile, C.aliceFileOld, C.aliceFileName, C.aliceTrashName, C.aliceChatTitle, C.aliceMsg, C.aliceAnswer, C.aliceArtifact,
  C.aliceMemory, C.aliceQuestion, C.aliceAttName, C.aliceProjInstr, C.aliceUploadName, C.aliceTranscript]
export const FINANCE_ONLY = [C.finFile, C.finFileOld, C.finTrashName, C.finName]
export const API_KEYS = Object.keys(API)
