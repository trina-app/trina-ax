// One request builder per HTTP route (every key of API, plus the two raw routes). Each builder aims the request at
// a resource the acting person must NOT reach unless the design says so — alice's private chat/file/project, the
// finance folder, a trashed file — so a correct server answers 401/403/404 (never the data) to the wrong person.
// The expected allow/deny per persona is computed from the endpoint's auth level and the resource's scope.
import { CSRF_HEADER } from '@mycel/shared/api'
import type { Client, Resp } from './instance'
import { authOf, enc, levelExp, type Case, type Exp } from './matrix'
import { C, USER_OF, WHO, type Who, type World } from './world'

type Build = (c: Client, w: World) => Promise<Resp>
/** scope decides the allow/deny beyond the auth level for a signed-in, password-ok caller */
type Scope =
  | 'self'            // each persona acts on its own data: always allowed for a signed-in caller
  | 'own-alice'       // targets alice's private resource: only alice (memberIn)
  | 'own-alice-chat'  // a chat of alice: only alice
  | 'users-alice'     // a path under users/alice/: only alice, NOT owner/admin
  | 'finance'         // finance folder resource: bob + owner + admin (read or write as noted)
  | 'finance-write'   // finance folder write: bob + owner + admin
  | 'falcon-read'     // projects/falcon: alice(write) + bob(finance read) + owner + admin
  | 'shared'          // shared/: every signed-in person
  | 'byLevel'         // nothing beyond the auth level (admin/owner endpoints, self-ish lists)

interface Spec { build: Build; scope: Scope; check?: (r: Resp, w: World, who: Who) => void; todo?: Partial<Record<Who, string>>;
  /** the request carries intentionally-wrong credentials, or re-logs-in and swaps the client's cookie: a 2xx is not
   *  expected for the legit caller, so it is covered by the deny matrix + world build, not the positive-allow pass. */
  skipPositive?: boolean }

const J = (body: unknown) => ({ headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1' } as Record<string, string>, raw: JSON.stringify(body) })
const cm = () => 'cm-' + crypto.randomUUID()

/** who (besides the auth level) may pass the permission check for each scope */
function scopeAllows(scope: Scope, who: Who): boolean {
  switch (scope) {
    case 'self': case 'shared': case 'byLevel': return true
    case 'own-alice': case 'own-alice-chat': case 'users-alice': return who === 'memberIn'
    case 'finance': case 'finance-write': return who === 'memberOut' || who === 'owner' || who === 'admin'
    case 'falcon-read': return who === 'memberIn' || who === 'memberOut' || who === 'owner' || who === 'admin'
  }
}
// users/alice/: owner and admin have NO access (design tab 2 rule 2/3)
const usersAliceAllows = (who: Who) => who === 'memberIn'

export function expectation(route: string, scope: Scope, who: Who): Exp {
  const lvl = levelExp(route, who)
  if (lvl !== 'allow') return lvl
  if (scope === 'users-alice') return usersAliceAllows(who) ? 'allow' : 'deny'
  return scopeAllows(scope, who) ? 'allow' : 'deny'
}

/** The request builders, keyed by API route name. 'self' builders act on the caller's own newly-made data. */
export const SPECS: Record<string, Spec> = {
  // ---- auth / me (self or public) ----
  setupStatus: { build: (c) => c.get('/api/setup'), scope: 'byLevel' },
  setup: { skipPositive: true, build: (c) => c.post('/api/setup', { setupToken: 'x', teamName: 't', owner: { username: 'z', name: 'z', password: 'Zebra-copper-1-kite' } }), scope: 'byLevel',
    check: (r) => { if (r.status === 201) throw new Error('setup created a second owner after the team exists') } },
  login: { skipPositive: true, build: (c) => c.post('/api/auth/login', { username: 'nobody', password: 'wrong-pass-xyz' }), scope: 'byLevel' },
  logout: { skipPositive: true, build: (c) => c.post('/api/auth/logout'), scope: 'byLevel' },
  changePassword: { skipPositive: true, build: (c) => c.post('/api/auth/password', { currentPassword: 'wrong', newPassword: 'Totally-new-pass-99-zz' }), scope: 'byLevel' },
  me: { build: (c) => c.get('/api/me'), scope: 'byLevel' },
  updateMe: { build: (c) => c.patch('/api/me', { name: 'Renamed Self' }), scope: 'byLevel' },
  mySessions: { build: (c) => c.get('/api/me/sessions'), scope: 'byLevel' },
  revokeMySession: { skipPositive: true, build: (c, w) => c.del(`/api/me/sessions/${w.ids.aliceSession}`), scope: 'byLevel',
    // alice's session id: no one else may revoke it (cross-user). bob etc must 404, not kill her session.
    check: (r, w, who) => { if (who !== 'memberIn' && r.status < 400) throw new Error(`${who} revoked alice's session`) } },
  inviteInfo: { build: (c, w) => c.get(`/api/invites/${w.ids.inviteToken}`), scope: 'byLevel' },
  acceptInvite: { skipPositive: true, build: (c, w) => c.post(`/api/invites/${w.ids.inviteToken}/accept`, { username: 'newbie' + Math.random().toString(36).slice(2, 7), name: 'New Bie', password: 'Fresh-pass-Owl-3321-xy' }), scope: 'byLevel' },
  passwordResetInfo: { build: (c, w) => c.get(`/api/password-resets/${w.ids.resetToken}`), scope: 'byLevel' },
  completePasswordReset: { skipPositive: true, build: (c, w) => c.post(`/api/password-resets/${w.ids.resetToken}`, { password: 'Changed-pass-Fox-9087-qq' }), scope: 'byLevel',
    todo: {}, },

  // ---- chats (own only) ----
  listChats: { build: (c) => c.get('/api/chats'), scope: 'self',
    check: (r, w, who) => { if (who !== 'memberIn' && r.text.includes(C.aliceChatTitle)) throw new Error(`${who}'s chat list shows alice's chat`) } },
  createChat: { build: (c) => c.post('/api/chats', { title: 'mine' }), scope: 'self' },
  getChat: { build: (c, w) => c.get(`/api/chats/${w.ids.chatA}`), scope: 'own-alice-chat' },
  updateChat: { build: (c, w) => c.patch(`/api/chats/${w.ids.chatA}`, { title: 'pwned-by-' + crypto.randomUUID().slice(0, 4) }), scope: 'own-alice-chat',
    check: (r, w, who) => { if (who !== 'memberIn' && r.status < 300) throw new Error(`${who} edited alice's chat`) } },
  deleteChat: { build: (c, w) => c.del(`/api/chats/${w.ids.chatA}`), scope: 'own-alice-chat',
    check: (r, w, who) => { if (who !== 'memberIn' && r.status < 300) throw new Error(`${who} deleted alice's chat`) } },
  restoreChat: { build: (c, w) => c.post(`/api/chats/${w.ids.chatA}/restore`), scope: 'own-alice-chat' },
  listMessages: { build: (c, w) => c.get(`/api/chats/${w.ids.chatA}/messages`), scope: 'own-alice-chat' },
  sendMessage: { build: (c, w) => c.post(`/api/chats/${w.ids.chatA}/messages`, { clientMessageId: cm(), attachmentIds: [], content: 'hi from intruder' }), scope: 'own-alice-chat',
    check: (r, w, who) => { if (who !== 'memberIn' && r.status < 300) throw new Error(`${who} posted into alice's chat`) } },
  stop: { build: (c, w) => c.post(`/api/chats/${w.ids.chatA}/stop`), scope: 'own-alice-chat' },
  regenerate: { build: (c, w) => c.post(`/api/chats/${w.ids.chatA}/messages/${w.ids.assistantMsg}/regenerate`, { clientMessageId: cm() }), scope: 'own-alice-chat' },
  editMessage: { build: (c, w) => c.post(`/api/chats/${w.ids.chatA}/messages/${w.ids.userMsg}/edit`, { clientMessageId: cm(), content: 'x' }), scope: 'own-alice-chat' },
  selectBranch: { build: (c, w) => c.post(`/api/chats/${w.ids.chatA}/branch`, { messageId: w.ids.userMsg }), scope: 'own-alice-chat' },
  listTurnRequests: { build: (c, w) => c.get(`/api/chats/${w.ids.chatB}/requests`), scope: 'own-alice-chat' },
  answerTurn: { build: (c, w) => c.post(`/api/turns/${w.ids.turnB}/answer`, { kind: 'ask_user', requestId: w.ids.requestB, answer: 'from intruder' }), scope: 'own-alice-chat',
    check: (r, w, who) => { if (who !== 'memberIn' && r.status < 300) throw new Error(`${who} answered alice's card`) } },
  listProjects: { build: (c) => c.get('/api/projects'), scope: 'self',
    check: (r, w, who) => { if (who !== 'memberIn' && r.text.includes(C.aliceProjInstr)) throw new Error(`${who} sees alice's private-folder project`) } },
  createProject: { build: (c) => c.post('/api/projects', { name: 'p', folderPath: 'shared', instructions: '' }), scope: 'shared' },
  getProject: { build: (c, w) => c.get(`/api/projects/${w.ids.projAlice}`), scope: 'users-alice' },
  updateProject: { build: (c, w) => c.patch(`/api/projects/${w.ids.projAlice}`, { instructions: 'pwned' }), scope: 'users-alice',
    check: (r, w, who) => { if (who !== 'memberIn' && r.status < 300) throw new Error(`${who} edited alice's project`) } },
  deleteProject: { build: (c, w) => c.del(`/api/projects/${w.ids.projAlice}`), scope: 'users-alice',
    check: (r, w, who) => { if (who !== 'memberIn' && r.status < 300) throw new Error(`${who} deleted alice's project`) } },

  // ---- memories (own only) ----
  listMemories: { build: (c) => c.get('/api/memories'), scope: 'self',
    check: (r, w, who) => { if (who !== 'memberIn' && r.text.includes(C.aliceMemory)) throw new Error(`${who} sees alice's memory`) } },
  deleteMemory: { build: (c, w) => c.del(`/api/memories/${w.ids.memory}`), scope: 'own-alice',
    check: (r, w, who) => { if (who !== 'memberIn' && r.status < 300) throw new Error(`${who} deleted alice's memory`) } },
  clearMemories: { build: (c) => c.del('/api/memories'), scope: 'self' },

  // ---- files (path-scoped) ----
  tree: { build: (c) => c.get('/api/files/tree?path=users%2Falice'), scope: 'users-alice',
    check: (r, w, who) => { if (who !== 'memberIn' && r.text.includes(C.aliceFileName)) throw new Error(`${who} sees a file name in users/alice`) } },
  content: { build: (c) => c.get('/api/files/content?path=users%2Falice%2Ftodo.md'), scope: 'users-alice' },
  saveContent: { build: (c) => c.put('/api/files/content', { path: 'users/alice/todo.md', content: 'overwritten', baseSha256: null }), scope: 'users-alice',
    check: (r, w, who) => { if (who !== 'memberIn' && r.status < 300) throw new Error(`${who} wrote into users/alice`) } },
  download: { build: (c) => c.get('/api/files/download?path=users%2Falice%2Ftodo.md'), scope: 'users-alice' },
  upload: { build: (c) => c.req('POST', '/api/files/upload', undefined, { form: uform('users/alice', 'x.bin') }), scope: 'users-alice' },
  mkdir: { build: (c) => c.post('/api/files/mkdir', { path: 'users/alice/intruder-dir' }), scope: 'users-alice' },
  move: { build: (c) => c.post('/api/files/move', { from: 'users/alice/todo.md', to: 'users/alice/moved.md' }), scope: 'users-alice' },
  remove: { build: (c) => c.del('/api/files?path=users%2Falice%2Ftodo.md'), scope: 'users-alice',
    check: (r, w, who) => { if (who !== 'memberIn' && r.status < 300) throw new Error(`${who} trashed a file in users/alice`) } },
  history: { build: (c) => c.get('/api/files/history?path=users%2Falice%2Ftodo.md'), scope: 'users-alice',
    check: (r, w, who) => { if (who !== 'memberIn' && r.text.includes(C.aliceFileOld)) throw new Error(`${who} sees alice's old version`) } },
  versionDownload: { build: (c, w) => w.ids.aliceVersion ? c.get(`/api/files/history/${w.ids.aliceVersion}/download`) : Promise.resolve({ status: 404, text: '', json: null, headers: new Headers() }), scope: 'users-alice' },
  restoreVersion: { build: (c, w) => c.post('/api/files/restore', { path: 'users/alice/todo.md', versionId: w.ids.aliceVersion ?? '00000000-0000-7000-8000-000000000000' }), scope: 'users-alice' },
  trash: { build: (c) => c.get('/api/files/trash'), scope: 'self',
    check: (r, w, who) => { if (who !== 'memberIn' && r.text.includes(C.aliceTrashName)) throw new Error(`${who} sees alice's trashed file name`)
      if (!(who === 'memberOut' || who === 'owner' || who === 'admin') && r.text.includes(C.finTrashName)) throw new Error(`${who} sees finance trashed file name`) } },
  restoreTrash: { build: (c, w) => c.post(`/api/files/trash/${w.ids.trashAlice}/restore`), scope: 'users-alice' },
  purgeTrash: { build: (c, w) => c.del(`/api/files/trash/${w.ids.trashAlice}`), scope: 'users-alice',
    // purgeTrash is admin-level, but a trashed users/alice item is out of reach for owner/admin too
    check: (r, w, who) => { if (who !== 'memberIn' && r.status < 300) throw new Error(`${who} purged alice's trashed file`) } },

  // ---- attachments / uploads (own chat only) ----
  uploadAttachment: { build: (c, w) => c.req('POST', '/api/uploads', undefined, { form: aform(w.ids.chatA, 'x.png') }), scope: 'own-alice-chat',
    check: (r, w, who) => { if (who !== 'memberIn' && r.status < 300) throw new Error(`${who} attached into alice's chat`) } },
  attachmentThumbnail: { build: (c, w) => c.get(`/api/uploads/${w.ids.attachment}/thumbnail`), scope: 'own-alice' },
  createUploadSession: { build: (c) => c.post('/api/upload-sessions', { target: { kind: 'path', path: 'users/alice/sess.bin', onExists: 'rename' }, size: 4, sha256: 'ab'.repeat(32) }), scope: 'users-alice' },
  uploadChunk: { build: (c, w) => c.req('PUT', `/api/upload-sessions/${w.ids.uploadAlice}/chunks/0`, undefined, { raw: '0123456789', headers: { 'content-type': 'application/octet-stream', [CSRF_HEADER]: '1' } }), scope: 'own-alice' },
  getUploadSession: { build: (c, w) => c.get(`/api/upload-sessions/${w.ids.uploadAlice}`), scope: 'own-alice' },
  completeUploadSession: { build: (c, w) => c.post(`/api/upload-sessions/${w.ids.uploadAlice}/complete`), scope: 'own-alice' },
  cancelUploadSession: { build: (c, w) => c.del(`/api/upload-sessions/${w.ids.uploadAlice}`), scope: 'own-alice',
    check: (r, w, who) => { if (who !== 'memberIn' && r.status < 300) throw new Error(`${who} cancelled alice's upload`) } },

  // ---- artifacts / jobs (own chat / own job) ----
  listChatArtifacts: { build: (c, w) => c.get(`/api/chats/${w.ids.chatA}/artifacts`), scope: 'own-alice-chat' },
  getArtifact: { build: (c, w) => c.get(`/api/artifacts/${w.ids.artifact}`), scope: 'own-alice' },
  getJob: { build: (c, w) => c.get(`/api/jobs/${w.ids.jobAlice}`), scope: 'own-alice' },
  cancelJob: { build: (c, w) => c.post(`/api/jobs/${w.ids.jobAlice}/cancel`), scope: 'own-alice' },
  transcribe: { build: (c, w) => c.req('POST', '/api/transcribe', undefined, { form: tform(w.ids.chatA) }), scope: 'own-alice-chat' },

  // ---- browser relay (own session/window) ----
  pollCalls: { build: (c) => c.get('/api/browser/calls?windowId=win-xxxxxxxx&waitMs=1'), scope: 'self' },
  postResult: { build: (c) => c.post('/api/browser/results', { callId: 'nope', ok: false, error: 'x' }), scope: 'self',
    check: (r) => { /* unknown call -> 404; never another window's */ } },

  // ---- admin (by level) ----
  listUsers: { build: (c) => c.get('/api/admin/users'), scope: 'byLevel' },
  createUser: { build: (c) => c.post('/api/admin/users', { username: 'cu' + Math.random().toString(36).slice(2, 7), name: 'C U', role: 'member' }), scope: 'byLevel' },
  updateUser: { build: (c) => c.patch('/api/admin/users/bob', { name: 'Bob Renamed' }), scope: 'byLevel' },
  deleteUser: { build: (c) => c.del('/api/admin/users/erin'), scope: 'byLevel' },
  resetPassword: { build: (c) => c.post('/api/admin/users/bob/reset-password'), scope: 'byLevel' },
  createResetLink: { build: (c) => c.post('/api/admin/users/bob/reset-link'), scope: 'byLevel' },
  transferOwnership: { skipPositive: true, build: (c) => c.post('/api/admin/transfer-ownership', { userId: 'carol', password: 'wrong-pass' }), scope: 'byLevel' },
  listInvites: { build: (c) => c.get('/api/admin/invites'), scope: 'byLevel' },
  createInvite: { build: (c) => c.post('/api/admin/invites', { role: 'member', groupIds: [] }), scope: 'byLevel' },
  revokeInvite: { build: (c, w) => c.del(`/api/admin/invites/${w.ids.invite}`), scope: 'byLevel' },
  listGroups: { build: (c) => c.get('/api/admin/groups'), scope: 'byLevel' },
  createGroup: { build: (c) => c.post('/api/admin/groups', { name: 'g' + Math.random().toString(36).slice(2, 6), memberIds: [] }), scope: 'byLevel' },
  updateGroup: { build: (c, w) => c.patch(`/api/admin/groups/${w.groups.marketing}`, { description: 'x' }), scope: 'byLevel' },
  deleteGroup: { build: (c, w) => c.del(`/api/admin/groups/${w.groups.finance}`), scope: 'byLevel' },
  listFolders: { build: (c) => c.get('/api/admin/folders'), scope: 'byLevel' },
  createFolder: { build: (c) => c.post('/api/admin/folders', { path: 'shared/sub' + Math.random().toString(36).slice(2, 6), create: true, rules: [] }), scope: 'byLevel' },
  putFolderRules: { build: (c, w) => c.put(`/api/admin/folders/${w.folders['groups/finance']}/rules`, { rules: [{ subjectType: 'user', subjectId: 'alice', access: 'write' }] }), scope: 'byLevel',
    check: (r, w, who) => { if ((who === 'owner' || who === 'admin') && r.status >= 300) throw new Error('admin could not set folder rules') } },
  deleteFolder: { build: (c, w) => c.del(`/api/admin/folders/${w.folders['projects/falcon/public']}`), scope: 'byLevel' },
  previewRules: { build: (c) => c.post('/api/admin/folder-rules/preview', { changes: [{ path: 'shared', rules: [{ subjectType: 'everyone', subjectId: null, access: 'read' }] }] }), scope: 'byLevel',
    check: (r, w, who) => { if ((who === 'owner' || who === 'admin') && r.text.includes(C.bobFile)) throw new Error('preview leaks private content') } },
  engines: { build: (c) => c.get('/api/admin/engines'), scope: 'byLevel' },
  updateEngines: { build: (c) => c.patch('/api/admin/engines', { concurrency: 3 }), scope: 'byLevel' },
  checkEngine: { build: (c) => c.post('/api/admin/engines/claude-code/check'), scope: 'byLevel' },
  addEngineAccount: { build: (c) => c.post('/api/admin/engines/accounts', { engine: 'anthropic', secret: 'sk-test-1234567890' }), scope: 'byLevel' },
  deleteEngineAccount: { build: (c) => c.del('/api/admin/engines/accounts/none'), scope: 'byLevel' },
  listBudgets: { build: (c) => c.get('/api/admin/budgets'), scope: 'byLevel' },
  createBudget: { build: (c) => c.post('/api/admin/budgets', { subjectType: 'team', subjectId: null, period: 'day', limitUsd: 10, action: 'warn' }), scope: 'byLevel' },
  updateBudget: { build: (c, w) => c.patch(`/api/admin/budgets/${w.ids.budget}`, { limitUsd: 20 }), scope: 'byLevel' },
  deleteBudget: { build: (c, w) => c.del(`/api/admin/budgets/${w.ids.budget}`), scope: 'byLevel' },
  settings: { build: (c) => c.get('/api/admin/settings'), scope: 'byLevel' },
  updateSettings: { build: (c) => c.patch('/api/admin/settings', { auditRetentionDays: 90 }), scope: 'byLevel' },
  usage: { build: (c) => c.get('/api/admin/usage'), scope: 'byLevel' },
  audit: { build: (c) => c.get('/api/admin/audit?limit=200'), scope: 'byLevel',
    // the audit list must hide names/sizes inside OTHER people's users/<id>/ even from owner/admin (tab 2, DECISIONS
    // "남의 개인 폴더 안은 ... 감사 목록에서도 users/<id>/…로만 보인다"). Group-folder names (finance) are fine for them.
    check: (r, w, who) => { for (const x of [C.aliceFileName, C.aliceAttName, C.aliceUploadName, C.aliceTrashName]) if (r.text.includes(x)) throw new Error(`audit shows a name inside users/alice to ${who}: ${x}`) } },

  // ---- system (owner / public) ----
  health: { build: (c) => c.get('/api/health'), scope: 'byLevel' },
  diagnostics: { build: (c) => c.get('/api/admin/diagnostics'), scope: 'byLevel' },
  updateStatus: { build: (c) => c.get('/api/admin/update'), scope: 'byLevel' },
  startUpdate: { skipPositive: true, build: (c) => c.post('/api/admin/update', { password: 'wrong-pass' }), scope: 'byLevel' },
  listBackups: { build: (c) => c.get('/api/admin/backups'), scope: 'byLevel' },
  startBackup: { build: (c) => c.post('/api/admin/backup', { scope: 'db' }), scope: 'byLevel' },
  startRestore: { skipPositive: true, build: (c) => c.post('/api/admin/restore', { backupId: 'nope', password: 'wrong' }), scope: 'byLevel' },
  startExport: { build: (c) => c.post('/api/admin/export', { what: ['memories'], password: '' }), scope: 'byLevel' },
  connection: { build: (c) => c.get('/api/admin/connection'), scope: 'byLevel' },
  updateConnection: { skipPositive: true, build: (c) => c.put('/api/admin/connection', { mode: 'direct', password: 'wrong' }), scope: 'byLevel' },
}

// multipart helpers
function uform(folder: string, name: string): FormData { const f = new FormData(); f.set('folder', folder); f.set('name', name); f.set('file', new File([Buffer.from('x')], name)); return f }
function aform(chatId: string, name: string): FormData { const f = new FormData(); f.set('chatId', chatId); f.set('name', name); f.set('file', new File([png()], name, { type: 'image/png' })); return f }
function tform(chatId: string): FormData { const f = new FormData(); f.set('chatId', chatId); f.set('file', new File([Buffer.from('RIFF')], 'a.wav', { type: 'audio/wav' })); return f }
const png = () => Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

export function allCases(): Case[] {
  const out: Case[] = []
  for (const [route, spec] of Object.entries(SPECS)) {
    for (const who of WHO) {
      out.push({
        route, who, label: `${route} as ${who}`,
        exp: expectation(route, spec.scope, who),
        run: spec.build,
        check: spec.check ? (r, w) => spec.check!(r, w, who) : undefined,
        todo: spec.todo?.[who],
        skipPositive: spec.skipPositive,
      })
    }
  }
  return out
}
