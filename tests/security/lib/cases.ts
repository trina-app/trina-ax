// One request builder per HTTP route (every key of API, plus the two raw routes). Each builder aims the request at
// a resource the acting person must NOT reach unless the design says so — alice's private chat/file/project, the
// finance folder, a trashed file — so a correct server answers 401/403/404 (never the data) to the wrong person.
// The expected allow/deny per persona is computed from the endpoint's auth level and the resource's scope.
import fs from 'node:fs'
import path from 'node:path'
import { ChatQueueSnapshot, CSRF_HEADER } from '@mycel/shared/api'
import type { Client, Resp } from './instance'
import { authOf, enc, leaks, levelExp, type Case, type Exp } from './matrix'
import { C, USER_OF, WHO, type Who, type World } from './world'
import { P4_SPECS } from './p4-cases'
import { INTEGRATION_SPECS } from './integrations-cases'
import { TEAM_ICON_SPECS } from './team-icon-cases'
import { PEOPLE_SPECS } from './people-cases'
import { REMOTE_MCP_SPECS } from './remote-mcp-cases'
import { PLUGIN_SPECS } from './plugin-cases'
import { ROOM_SPECS } from './rooms-cases'
import { SLACK_SPECS } from './slack-cases'
import { PROMO_VIDEO_SPECS } from './promo-video-cases'
import { INTRO_DECK_SPECS } from './intro-deck-cases'
import { SKILL_SHARE_SPECS } from './skill-share-cases'
import { KNOWLEDGE_GRAPH_SPECS } from './knowledge-graph-cases'

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
  | 'suggestion-alice' // a skill alice suggested into skills/: alice + the managers of skills/ (owner, admin)
  | 'skills-manager'  // acting on a suggestion for skills/: only its managers (owner, admin), not even alice
  | 'byLevel'         // nothing beyond the auth level (admin/owner endpoints, self-ish lists)
  | 'room-dm'         // the DM of alice and erin: only those two (not the owner, not an admin)
  | 'room-group'      // the group chat of alice, erin and frank: alice and erin (frank still has to change his password)
  | 'nobody'          // a resource of nobody (an unknown sign-in id): 4xx for everyone, after the auth level

export interface Spec { build: Build; scope: Scope; check?: (r: Resp, w: World, who: Who) => void | Promise<void>; todo?: Partial<Record<Who, string>>;
  /** the request carries intentionally-wrong credentials, or re-logs-in and swaps the client's cookie: a 2xx is not
   *  expected for the legit caller, so it is covered by the deny matrix + world build, not the positive-allow pass. */
  skipPositive?: boolean }

/** An admin-reauth case is sent with a wrong password: the owner and an admin pass the role gate and are refused for the
 * password (403 with a body.password field), a member is refused for the role (403 without it, before the password is
 * looked at), nobody is let through. So a refusal for the wrong reason does not pass as the right one. */
const reauthCheck = (what: string) => (r: { status: number; json: any }, _w: unknown, who: string) => {
  if (r.status < 300) throw new Error(`${who}: ${what} went through with a wrong password`)
  const atPassword = !!r.json?.error?.fields?.['body.password']
  // 429: the same person's earlier wrong passwords in this run used up the limit (still a refusal at the password step)
  if ((who === 'owner' || who === 'admin') && r.status !== 429 && !(r.status === 403 && atPassword)) throw new Error(`${who}: ${what} was not refused at the password check (status ${r.status})`)
  if (who === 'member' && !(r.status === 403 && !atPassword)) throw new Error(`member: ${what} was not refused for the role (status ${r.status})`)
}
const J = (body: unknown) => ({ headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1' } as Record<string, string>, raw: JSON.stringify(body) })
/** a sealed value of the right shape that opens with no key (the server refuses it after the permission check) */
const FAKE_SEALED = { kid: '0123456789abcdef', epk: 'A'.repeat(87), iv: 'B'.repeat(16), ct: 'C'.repeat(40) }
const cm = () => 'cm-' + crypto.randomUUID()

/** who (besides the auth level) may pass the permission check for each scope */
function scopeAllows(scope: Scope, who: Who): boolean {
  switch (scope) {
    case 'self': case 'shared': case 'byLevel': return true
    case 'own-alice': case 'own-alice-chat': case 'users-alice': return who === 'memberIn'
    case 'finance': case 'finance-write': return who === 'memberOut' || who === 'owner' || who === 'admin'
    case 'falcon-read': return who === 'memberIn' || who === 'memberOut' || who === 'owner' || who === 'admin'
    case 'suggestion-alice': return who === 'memberIn' || who === 'owner' || who === 'admin'
    case 'skills-manager': return who === 'owner' || who === 'admin'
    case 'room-dm': case 'room-group': return who === 'memberIn' || who === 'other'
    case 'nobody': return false
  }
}
// users/alice/: owner and admin have NO access (design tab 2 rule 2/3)
const usersAliceAllows = (who: Who) => who === 'memberIn'

export function expectation(route: string, scope: Scope, who: Who): Exp {
  const lvl = levelExp(route, who)
  if (lvl !== 'allow') return lvl
  // The preview probe uses Alice's text file: she passes access checks but gets 503 no_preview.
  if ((route === 'preview' || route === 'hwpPreview') && scope === 'users-alice' && usersAliceAllows(who)) return 'pass-auth'
  if (scope === 'users-alice') return usersAliceAllows(who) ? 'allow' : 'deny'
  return scopeAllows(scope, who) ? 'allow' : 'deny'
}

/** The request builders, keyed by API route name. 'self' builders act on the caller's own newly-made data. */
export const SPECS: Record<string, Spec> = {
  ...P4_SPECS,
  ...INTEGRATION_SPECS,
  ...TEAM_ICON_SPECS,
  ...PEOPLE_SPECS,
  ...REMOTE_MCP_SPECS,
  ...PLUGIN_SPECS,
  ...ROOM_SPECS,
  ...SLACK_SPECS,
  ...PROMO_VIDEO_SPECS,
  ...INTRO_DECK_SPECS,
  ...SKILL_SHARE_SPECS,
  ...KNOWLEDGE_GRAPH_SPECS,
  // ---- auth / me (self or public) ----
  setupStatus: { build: (c) => c.get('/api/setup'), scope: 'byLevel' },
  setup: { skipPositive: true, build: (c) => c.post('/api/setup', { setupToken: 'x', teamName: 't', owner: { username: 'z', name: 'z', password: 'Zebra-copper-1-kite' } }), scope: 'byLevel',
    check: (r) => { if (r.status === 201) throw new Error('setup created a second owner after the team exists') } },
  login: { skipPositive: true, build: (c) => c.post('/api/auth/login', { username: 'nobody', password: 'wrong-pass-xyz' }), scope: 'byLevel' },
  logout: { skipPositive: true, build: (c) => c.post('/api/auth/logout'), scope: 'byLevel' },
  changePassword: { skipPositive: true, build: (c) => c.post('/api/auth/password', { currentPassword: 'wrong', newPassword: 'Totally-new-pass-99-zz' }), scope: 'byLevel' },
  me: { build: (c) => c.get('/api/me'), scope: 'byLevel' },
  updateMe: { build: (c) => c.patch('/api/me', { name: 'Renamed Self' }), scope: 'byLevel' },
  // fix/prod-ops: the desktop app's office address + certificate pin, and its "could not use the office address" report
  connectInfo: { build: (c) => c.get('/api/connect-info'), scope: 'byLevel' },
  lanFailure: { build: (c) => c.post('/api/connect-info/lan-failure', { code: 'unreachable' }), scope: 'byLevel' },
  mySessions: { build: (c) => c.get('/api/me/sessions'), scope: 'byLevel' },
  // own usage only: nothing in the request names another person (tests/unit/a-my-usage.test.ts)
  myUsage: { build: (c) => c.get('/api/me/usage'), scope: 'self' },
  revokeMySession: { skipPositive: true, build: (c, w) => c.del(`/api/me/sessions/${w.ids.aliceSession}`), scope: 'byLevel',
    // alice's session id: no one else may revoke it (cross-user). bob etc must 404, not kill her session.
    check: (r, w, who) => { if (who !== 'memberIn' && r.status < 400) throw new Error(`${who} revoked alice's session`) } },
  // own account deletion request (shared/src/api/account-deletion.ts): the caller's own only, whatever the request
  // names; the owner cannot ask (409, a state to change first, not a permission check)
  myDeletionRequest: { build: (c) => c.get('/api/me/deletion-request?userId=alice'), scope: 'self',
    check: (r, _w, who) => { if (r.status < 300 && r.json?.state !== (who === 'owner' ? 'owner' : 'none') && r.json?.state !== 'pending') throw new Error(`unexpected state for ${who}: ${r.text}`) } },
  requestAccountDeletion: { build: (c) => c.post('/api/me/deletion-request?userId=alice', { confirm: true }), scope: 'self',
    check: (r, _w, who) => {
      if (who === 'owner' && r.status !== 409) throw new Error(`the owner asked for their own account to be deleted: ${r.status}`)
      if (who !== 'owner' && r.status < 300 && r.json?.state !== 'pending') throw new Error(`${who}'s request is not their own: ${r.text}`)
    } },
  cancelAccountDeletion: { build: (c) => c.del('/api/me/deletion-request?userId=alice'), scope: 'self',
    check: (r, _w, who) => { if (r.status < 300 && r.json?.state !== (who === 'owner' ? 'owner' : 'none')) throw new Error(`${who}'s cancel left a request open: ${r.text}`) } },
  inviteInfo: { build: (c, w) => c.get(`/api/invites/${w.ids.inviteToken}`), scope: 'byLevel' },
  acceptInvite: { skipPositive: true, build: (c, w) => c.post(`/api/invites/${w.ids.inviteToken}/accept`, { username: 'newbie' + Math.random().toString(36).slice(2, 7), name: 'New Bie', password: 'Fresh-pass-Owl-3321-xy' }), scope: 'byLevel' },
  passwordResetInfo: { build: (c, w) => c.get(`/api/password-resets/${w.ids.resetToken}`), scope: 'byLevel' },
  completePasswordReset: { skipPositive: true, build: (c, w) => c.post(`/api/password-resets/${w.ids.resetToken}`, { password: 'Changed-pass-Fox-9087-qq' }), scope: 'byLevel',
    todo: {}, },

  // ---- chats (own only) ----
  listChats: { build: (c) => c.get('/api/chats'), scope: 'self',
    check: (r, w, who) => { if (who !== 'memberIn' && r.text.includes(C.aliceChatTitle)) throw new Error(`${who}'s chat list shows alice's chat`) } },
  createChat: { build: (c) => c.post('/api/chats', { title: 'mine' }), scope: 'self' },
  // engine / model choice is the admin's (r5-engine-choice.test.ts): members see canChoose false and no engines
  chatEngines: { build: (c) => c.get('/api/engines'), scope: 'self',
    check: (r, w, who) => { if (r.status === 200 && (who === 'memberIn' || who === 'other' || who === 'memberOut') && (r.json?.canChoose !== false || r.json?.engines?.length)) throw new Error(`${who} may pick the engine by default`) } },
  getChat: { build: (c, w) => c.get(`/api/chats/${w.ids.chatA}`), scope: 'own-alice-chat' },
  getChatQueue: { build: (c, w) => c.get(`/api/chats/${w.ids.chatA}/queue`), scope: 'own-alice-chat',
    check: (r, _w, who) => {
      if (who === 'memberIn') {
        if (r.status !== 200 || !ChatQueueSnapshot.safeParse(r.json).success) throw new Error('chat owner did not receive a valid queue snapshot')
        return
      }
      const status = who === 'anon' ? 401 : who === 'pwchange' ? 403 : 404
      const code = who === 'anon' ? 'unauthorized' : who === 'pwchange' ? 'password_change_required' : 'not_found'
      if (r.status !== status || r.json?.error?.code !== code) throw new Error(`${who} queue response must be ${status} ${code}`)
    } },
  updateChat: { build: (c, w) => c.patch(`/api/chats/${w.ids.chatA}`, { title: 'pwned-by-' + crypto.randomUUID().slice(0, 4) }), scope: 'own-alice-chat',
    check: (r, w, who) => { if (who !== 'memberIn' && r.status < 300) throw new Error(`${who} edited alice's chat`) } },
  deleteChat: { build: (c, w) => c.del(`/api/chats/${w.ids.chatA}`), scope: 'own-alice-chat',
    check: (r, w, who) => { if (who !== 'memberIn' && r.status < 300) throw new Error(`${who} deleted alice's chat`) } },
  restoreChat: { build: (c, w) => c.post(`/api/chats/${w.ids.chatA}/restore`), scope: 'own-alice-chat' },
  listMessages: { build: (c, w) => c.get(`/api/chats/${w.ids.chatA}/messages`), scope: 'own-alice-chat' },
  sendMessage: { build: (c, w) => c.post(`/api/chats/${w.ids.chatA}/messages`, { clientMessageId: cm(), attachmentIds: [], content: 'hi from intruder' }), scope: 'own-alice-chat',
    check: (r, w, who) => { if (who !== 'memberIn' && r.status < 300) throw new Error(`${who} posted into alice's chat`) } },
  stop: { build: (c, w) => c.post(`/api/chats/${w.ids.chatA}/stop`), scope: 'own-alice-chat' },
  messageSources: { build: (c, w) => c.get(`/api/chats/${w.ids.chatA}/messages/${w.ids.assistantMsg}/sources`), scope: 'own-alice-chat' },
  regenerate: { build: (c, w) => c.post(`/api/chats/${w.ids.chatA}/messages/${w.ids.assistantMsg}/regenerate`, { clientMessageId: cm() }), scope: 'own-alice-chat' },
  editMessage: { build: (c, w) => c.post(`/api/chats/${w.ids.chatA}/messages/${w.ids.userMsg}/edit`, { clientMessageId: cm(), content: 'x' }), scope: 'own-alice-chat' },
  selectBranch: { build: (c, w) => c.post(`/api/chats/${w.ids.chatA}/branch`, { messageId: w.ids.userMsg }), scope: 'own-alice-chat' },
  listTurnRequests: { build: (c, w) => c.get(`/api/chats/${w.ids.chatB}/requests`), scope: 'own-alice-chat' },
  answerTurn: { build: (c, w) => c.post(`/api/turns/${w.ids.turnB}/answer`, { kind: 'ask_user', requestId: w.ids.requestB, answer: 'from intruder' }), scope: 'own-alice-chat',
    check: (r, w, who) => { if (who !== 'memberIn' && r.status < 300) throw new Error(`${who} answered alice's card`) } },
  // an open connect_service card of alice's turn (buildWorld's connectCard option, which the matrix sets): only alice
  // may finish it. A skip is enough to show who reaches it: anyone else who got through would close it (2xx). Alice's
  // own skip runs in phase 2 and closes it (or meets a card whose time ran out: 409).
  connectTurn: { build: (c, w) => c.post(`/api/turns/${w.ids.turnConnect}/connect`, { action: 'skip', requestId: w.ids.requestConnect }), scope: 'own-alice-chat',
    check: (r, w, who) => {
      if (!w.ids.turnConnect) throw new Error('the world has no connect_service card (buildWorld connectCard)')
      if (who !== 'memberIn' && r.status < 300) throw new Error(`${who} finished alice's connect card`)
      if (who === 'memberIn' && r.status !== 409 && !(r.status === 200 && r.json?.state === 'skipped')) throw new Error(`alice could not finish her own connect card: ${r.status}`)
    } },
  listProjects: { build: (c) => c.get('/api/projects'), scope: 'self',
    check: (r, w, who) => { if (who !== 'memberIn' && r.text.includes(C.aliceProjInstr)) throw new Error(`${who} sees alice's private-folder project`) } },
  createProject: { build: (c) => c.post('/api/projects', { name: 'p', folderPath: 'shared', instructions: '' }), scope: 'shared' },
  getProject: { build: (c, w) => c.get(`/api/projects/${w.ids.projAlice}`), scope: 'users-alice' },
  updateProject: { build: (c, w) => c.patch(`/api/projects/${w.ids.projAlice}`, { instructions: 'pwned' }), scope: 'users-alice',
    check: (r, w, who) => { if (who !== 'memberIn' && r.status < 300) throw new Error(`${who} edited alice's project`) } },
  deleteProject: { build: (c, w) => c.del(`/api/projects/${w.ids.projAlice}`), scope: 'users-alice',
    check: (r, w, who) => { if (who !== 'memberIn' && r.status < 300) throw new Error(`${who} deleted alice's project`) } },
  // sharing by copy (sec/r1-sharing-works): reading the source is alice's alone; dryRun so the allowed pass copies nothing
  shareProject: { build: (c, w) => c.post(`/api/projects/${w.ids.projAlice}/share`, { toParent: 'shared', dryRun: true }), scope: 'users-alice',
    check: (r, w, who) => { if (who !== 'memberIn' && r.status < 300) throw new Error(`${who} shared alice's private project`) } },

  // ---- memories (own only) ----
  // scheduled tasks: own only (a schedule id of nobody: 404 for everyone, never another person's)
  listSchedules: { build: (c) => c.get('/api/schedules'), scope: 'self' },
  updateSchedule: { build: (c) => c.patch('/api/schedules/00000000-0000-7000-8000-000000000000', { enabled: false }), scope: 'self' },
  deleteSchedule: { build: (c) => c.del('/api/schedules/00000000-0000-7000-8000-000000000000'), scope: 'self' },
  // run now and edit: own tasks only (each person's own are covered in tests/unit/schedule-edit.test.ts, incl. 404 to others)
  runScheduleNow: { build: (c) => c.post('/api/schedules/00000000-0000-7000-8000-000000000000/run', {}), scope: 'self' },
  scheduleEditCard: { build: (c) => c.post('/api/schedules/00000000-0000-7000-8000-000000000000/edit', { kind: 'task', title: 'x', prompt: 'x x x', repeat: 'daily', time: '09:00', projectId: null }), scope: 'self' },
  editSchedule: { build: (c) => c.put('/api/schedules/00000000-0000-7000-8000-000000000000', { kind: 'template', time: '09:00', sourcePath: 'shared', outputPath: 'users/x' }), scope: 'self' },
  // nobody's task (each person's own waiting task is covered in tests/unit/schedule-review.test.ts, incl. 404 to others)
  getScheduleReview: { build: (c) => c.get('/api/schedules/00000000-0000-7000-8000-000000000000/review'), scope: 'nobody' },
  confirmScheduleReview: { build: (c) => c.post('/api/schedules/00000000-0000-7000-8000-000000000000/review', { requestId: 'schedule-review-x', answer: 'resume' }), scope: 'self' },
  listSchedulesAwaitingReview: { build: (c) => c.get('/api/admin/schedule-reviews'), scope: 'byLevel' },
  listMemories: { build: (c) => c.get('/api/memories'), scope: 'self',
    check: (r, w, who) => { if (who !== 'memberIn' && r.text.includes(C.aliceMemory)) throw new Error(`${who} sees alice's memory`) } },
  // adding is each person's own (a new memory of the caller); correcting someone else's is never allowed
  createMemory: { build: (c) => c.post('/api/memories', { text: 'matrix memory' }), scope: 'self' },
  updateMemory: { build: (c, w) => c.patch(`/api/memories/${w.ids.memory}`, { text: 'pwned memory' }), scope: 'own-alice',
    check: (r, w, who) => { if (who !== 'memberIn' && r.status < 300) throw new Error(`${who} changed alice's memory`) } },
  deleteMemory: { build: (c, w) => c.del(`/api/memories/${w.ids.memory}`), scope: 'own-alice',
    check: (r, w, who) => { if (who !== 'memberIn' && r.status < 300) throw new Error(`${who} deleted alice's memory`) } },
  clearMemories: { build: (c) => c.del('/api/memories'), scope: 'self' },
  // team skills (skills/**/*.md readable by the caller): the canary check covers every name in the list
  // skills/finance (everyone none + finance read) and alice's personal skill: the canary table denies them to everyone
  // else; this check also makes sure the people who may see them do
  listSkills: { build: (c) => c.get('/api/skills'), scope: 'self',
    check: (r, w, who) => {
      if (r.status !== 200) return
      if (['memberOut', 'owner', 'admin'].includes(who) && !r.text.includes(C.finSkill)) throw new Error(`${who} does not see the finance skill`)
      if (who === 'memberIn' && !r.text.includes(C.aliceSkill)) throw new Error('alice does not see her personal skill')
    } },
  listSkillIssues: { build: (c) => c.get('/api/skills/issues'), scope: 'self' },
  // team skills: suggestions are seen by their suggester and the managers of the target folder only (skills/suggestions.ts)
  skillsOverview: { build: (c) => c.get('/api/skills/overview'), scope: 'self' },
  listSkillSuggestions: { build: (c) => c.get('/api/skills/suggestions?scope=review'), scope: 'self',
    check: (r, w, who) => { if (!['memberIn', 'owner', 'admin'].includes(who) && r.text.includes(C.aliceSuggestion)) throw new Error(`${who} sees alice's skill suggestion`) } },
  getSkillSuggestion: { build: (c, w) => c.get(`/api/skills/suggestions/${w.ids.suggestion}`), scope: 'suggestion-alice' },
  // from alice's own file: nobody else may turn it into a suggestion (it would copy her file to the managers)
  createSkillSuggestion: { build: (c) => c.post('/api/skills/suggestions', { source: { kind: 'file', path: 'users/alice/todo.md' }, targetFolder: 'skills', name: 'from alice file', content: 'x' }), scope: 'users-alice' },
  approveSkillSuggestion: { build: (c, w) => c.post(`/api/skills/suggestions/${w.ids.suggestion}/approve`, { targetFolder: 'skills', name: 'approved by matrix', description: '', content: 'steps' }), scope: 'skills-manager',
    check: (r, w, who) => { if (!['owner', 'admin'].includes(who) && r.status < 300) throw new Error(`${who} registered a skill suggestion`) } },
  rejectSkillSuggestion: { build: (c, w) => c.post(`/api/skills/suggestions/${w.ids.suggestion}/reject`, { note: 'no' }), scope: 'skills-manager',
    check: (r, w, who) => { if (!['owner', 'admin'].includes(who) && r.status < 300) throw new Error(`${who} turned down a skill suggestion`) } },
  // the team API engine (feat/api-engine): the owner and admins, with their own password again; the key is never returned
  getApiEngine: { build: (c) => c.get('/api/admin/engines/api-config'), scope: 'byLevel' },
  putApiEngine: { skipPositive: true, build: (c) => c.put('/api/admin/engines/api-config', { password: 'wrong-pass', baseUrl: 'https://api.example.com/v1', model: 'matrix-model', label: 'matrix' }), scope: 'byLevel',
    check: reauthCheck('changing the team API engine') },
  listSkillChanges: { build: (c) => c.get('/api/admin/skill-changes'), scope: 'byLevel' },
  listSkillManagers: { build: (c) => c.get('/api/admin/skill-managers'), scope: 'byLevel' },
  // turning it OFF for someone who does not have it: allowed for admins, changes nothing (keeps the world pristine)
  setSkillManager: { build: (c) => c.put('/api/admin/skill-managers', { subjectType: 'user', subjectId: 'alice', path: 'skills', enabled: false }), scope: 'byLevel',
    check: (r, w, who) => { if (!['owner', 'admin'].includes(who) && r.status < 300) throw new Error(`${who} changed who manages team skills`) } },

  // ---- files (path-scoped) ----
  tree: { build: (c) => c.get('/api/files/tree?path=users%2Falice'), scope: 'users-alice',
    check: (r, w, who) => { if (who !== 'memberIn' && r.text.includes(C.aliceFileName)) throw new Error(`${who} sees a file name in users/alice`) } },
  content: { build: (c) => c.get('/api/files/content?path=users%2Falice%2Ftodo.md'), scope: 'users-alice' },
  saveContent: { build: (c) => c.put('/api/files/content', { path: 'users/alice/todo.md', content: 'overwritten', baseSha256: null }), scope: 'users-alice',
    check: (r, w, who) => { if (who !== 'memberIn' && r.status < 300) throw new Error(`${who} wrote into users/alice`) } },
  download: { build: (c) => c.get('/api/files/download?path=users%2Falice%2Ftodo.md'), scope: 'users-alice' },
  hwpPreview: { build: c => c.get('/api/files/hwp-preview?path=users%2Falice%2Ftodo.md&page=1'), scope: 'users-alice',
    check: (r, _w, who) => {
      const status = who === 'anon' ? 401 : who === 'pwchange' ? 403 : who === 'memberIn' ? 503 : 404
      if (r.status !== status) throw new Error(who + ' hwpPreview status: ' + r.status)
      if (who === 'memberIn' && r.json?.error?.params?.reason !== 'unsupported') throw new Error('expected unsupported')
    } },
  preview: { build: (c) => c.get('/api/files/preview?path=users%2Falice%2Ftodo.md'), scope: 'users-alice',
    check: (r, _w, who) => {
      const status = who === 'anon' ? 401 : who === 'pwchange' ? 403 : who === 'memberIn' ? 503 : 404
      const code = who === 'anon' ? 'unauthorized' : who === 'pwchange' ? 'password_change_required' : who === 'memberIn' ? 'unavailable' : 'not_found'
      if (r.status !== status || r.json?.error?.code !== code) throw new Error(`${who} preview response must be ${status} ${code}`)
      if (who === 'memberIn' && r.json?.error?.params?.reason !== 'no_preview') throw new Error('text-file preview must report no_preview')
    } },
  upload: { build: (c) => c.req('POST', '/api/files/upload', undefined, { form: uform('users/alice', 'x.bin') }), scope: 'users-alice' },
  mkdir: { build: (c) => c.post('/api/files/mkdir', { path: 'users/alice/intruder-dir' }), scope: 'users-alice' },
  move: { build: (c) => c.post('/api/files/move', { from: 'users/alice/todo.md', to: 'users/alice/moved.md' }), scope: 'users-alice' },
  remove: { build: (c) => c.del('/api/files?path=users%2Falice%2Ftodo.md'), scope: 'users-alice',
    check: (r, w, who) => { if (who !== 'memberIn' && r.status < 300) throw new Error(`${who} trashed a file in users/alice`) } },
  history: { build: (c) => c.get('/api/files/history?path=users%2Falice%2Ftodo.md'), scope: 'users-alice',
    check: (r, w, who) => { if (who !== 'memberIn' && r.text.includes(C.aliceFileOld)) throw new Error(`${who} sees alice's old version`) } },
  versionDownload: { build: (c, w) => w.ids.aliceVersion ? c.get(`/api/files/history/${w.ids.aliceVersion}/download`) : Promise.resolve({ status: 404, text: '', json: null, headers: new Headers() }), scope: 'users-alice' },
  copy: { build: (c) => c.post('/api/files/copy', { from: 'users/alice/todo.md', to: 'shared/copied-todo.md', dryRun: true }), scope: 'users-alice',
    check: (r, w, who) => { if (who !== 'memberIn' && r.status < 300) throw new Error(`${who} copied a file out of users/alice`) } },
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
  // team files attached by reference (the composer's "Add from team files") and the picker's listings: each persona
  // makes an own chat and aims at a file NAME inside users/alice/ (only alice may read it; owner and admin included
  // are refused with the plain 404). find / recent list only readable files: the canary check covers every name.
  attachTeamFile: { build: async (c, w) => { const own = await c.post('/api/chats', { title: 'attach probe' }); return c.post('/api/attachments/team-file', { chatId: own.json?.id ?? w.ids.chatA, path: `users/alice/${C.aliceFileName}.md` }) }, scope: 'users-alice',
    check: (r, w, who) => { if (who !== 'memberIn' && r.status < 300) throw new Error(`${who} attached a file from users/alice`) } },
  findFiles: { build: (c) => c.get('/api/files/find?q=SEC&limit=100'), scope: 'self' },
  searchFileContents: { build: (c) => c.get('/api/files/search?q=SEC&limit=100'), scope: 'self' },
  recentFiles: { build: (c) => c.get('/api/files/recent?limit=50'), scope: 'self' },
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
  // an admin is refused here without the password in the body (the owner is not asked); an admin deleting a member with
  // the password is in permission-matrix.test.ts and tests/unit/sec-account-delete-by-role.test.ts
  deleteUser: { skipPositive: true, build: (c) => c.del('/api/admin/users/erin'), scope: 'byLevel' },
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
  // shared/ and skills/ keep at least one rule, also for the owner and admins (fix/folders-safety 1b): the admin API
  // refuses "no rules" (400) and the delete below (409)
  putFolderRules: { build: (c, w) => c.put(`/api/admin/folders/${w.folders['groups/finance']}/rules`, { rules: [{ subjectType: 'user', subjectId: 'alice', access: 'write' }] }), scope: 'byLevel',
    check: async (r, w, who) => {
      if ((who === 'owner' || who === 'admin') && r.status >= 300) throw new Error('admin could not set folder rules')
      if (who !== 'owner' && who !== 'admin') return
      for (const p of ['shared', 'skills']) {
        const empty = await w.as[who].put(`/api/admin/folders/${w.folders[p]}/rules`, { rules: [] })
        if (empty.status !== 400) throw new Error(`${who} removed every rule of ${p}/: ${empty.status}`)
      }
      // a save that names rules the folder no longer has (another admin changed them: stage 5) is refused and changes
      // nothing; the folder's hash as listed saves
      const listed = async () => ((await w.as[who].get('/api/admin/folders')).json?.items ?? []) as { id: string; rules: unknown[]; rulesHash?: string }[]
      const fin = (await listed()).find((f) => f.id === w.folders['groups/finance'])
      if (!fin?.rulesHash) throw new Error(`${who}: the folder list carries no rules hash`)
      const stale = await w.as[who].put(`/api/admin/folders/${fin.id}/rules`, { rules: [], expectedHash: 'not-the-rules-hash' })
      if (stale.status !== 409 || stale.json?.error?.params?.reason !== 'rules_changed') throw new Error(`${who} saved over rules that changed: ${stale.status}`)
      if (JSON.stringify((await listed()).find((f) => f.id === fin.id)?.rules) !== JSON.stringify(fin.rules)) throw new Error(`${who}: a refused save changed the rules`)
      const same = await w.as[who].put(`/api/admin/folders/${fin.id}/rules`, { rules: [{ subjectType: 'user', subjectId: 'alice', access: 'write' }], expectedHash: fin.rulesHash })
      if (same.status !== 200) throw new Error(`${who} could not save with the folder's own hash: ${same.status}`)
    } },
  // the team's default folders and a group's folder row stay (409), for the owner and admins too. The group is made here:
  // the world's groups may already be gone (deleteGroup runs before this case), and nothing here may depend on order
  deleteFolder: { build: (c, w) => c.del(`/api/admin/folders/${w.folders['projects/falcon/public']}`), scope: 'byLevel',
    check: async (r, w, who) => {
      if (who !== 'owner' && who !== 'admin') return
      const c = w.as[who]
      const made = await c.post('/api/admin/groups', { name: `keep-${who}-${Math.random().toString(36).slice(2, 8)}`, memberIds: [] })
      if (made.status !== 201) throw new Error(`${who} could not make a group to test with: ${made.status}`)
      const listed = async () => ((await c.get('/api/admin/folders')).json?.items ?? []) as { id: string; path: string; groupId?: string | null }[]
      const own = (await listed()).find((f) => f.groupId === made.json.id)
      let cleanup: { group: number; row: number | null } | null = null
      try {
        if (!own) throw new Error('the new group has no folder row')
        const rows = (await listed()).filter((f) => f.path === 'shared' || f.path === 'skills')
        if (rows.length !== 2) throw new Error(`shared/ and skills/ rows: ${rows.map((f) => f.path).join(', ')}`)
        for (const f of [...rows, own]) {
          const d = await c.del(`/api/admin/folders/${f.id}`)
          if (d.status !== 409) throw new Error(`${who} removed the folder row of ${f.path}: ${d.status}`)
        }
        const left = new Set((await listed()).map((f) => f.id))
        for (const f of [...rows, own]) if (!left.has(f.id)) throw new Error(`the folder row of ${f.path} is gone`)
      } finally {
        // leave the world as it was, also when a check above failed: the group, then its row (an ordinary one once the
        // group is gone), then its folder on disk
        const group = (await c.del(`/api/admin/groups/${made.json.id}`)).status
        const row = own ? (await c.del(`/api/admin/folders/${own.id}`)).status : null
        if (own?.path.startsWith('groups/keep-')) fs.rmSync(path.join(w.inst.team, ...own.path.split('/')), { recursive: true, force: true })
        cleanup = { group, row }
      }
      // reached only when the checks passed (an earlier failure is the one reported)
      if (cleanup.group !== 204) throw new Error('the test group could not be deleted')
      if (cleanup.row !== null && cleanup.row !== 204) throw new Error('the row of a deleted group could not be removed')
    } },
  previewRules: { build: (c) => c.post('/api/admin/folder-rules/preview', { changes: [{ path: 'shared', rules: [{ subjectType: 'everyone', subjectId: null, access: 'read' }] }] }), scope: 'byLevel',
    check: (r, w, who) => { if ((who === 'owner' || who === 'admin') && r.text.includes(C.bobFile)) throw new Error('preview leaks private content') } },
  // the edit panel's preview (admin/access-edit.ts): admins and the owner only, nothing saved, no file content or name
  // of anyone's personal folder; a path inside alice's folder is refused without her file's name
  previewFolderEdit: { build: (c, w) => c.post('/api/admin/access/edit-preview', { path: w.groups.finFolder, rules: [{ subjectType: 'everyone', subjectId: null, access: 'read' }] }), scope: 'byLevel',
    check: async (r, w, who) => {
      if (r.status === 200) {
        if (r.text.includes(C.bobFile) || r.text.includes(C.aliceFileName) || r.text.includes('Private plan')) throw new Error(`${who}: the edit preview shows file content or a personal name`)
        if (typeof r.json?.hash !== 'string' || !Array.isArray(r.json?.changes)) throw new Error(`${who}: the edit preview has no hash or changes`)
        // nothing was saved: the finance folder's rules are as they were
        const still = ((await w.as[who].get('/api/admin/folders')).json?.items ?? []).find((f: any) => f.path === w.groups.finFolder)
        if (still?.rules?.some((x: any) => x.subjectType === 'everyone')) throw new Error(`${who}: the edit preview saved its rules`)
      }
      const probe = await w.as[who].post('/api/admin/access/edit-preview', { path: `users/alice/${C.aliceFileName}.md`, rules: [] })
      if (probe.status < 400 || probe.status >= 500) throw new Error(`${who}: a path in users/alice was answered (${probe.status})`)
      const l = [...leaks(who, probe.text), ...(probe.text.includes(C.aliceFileName) ? [C.aliceFileName] : [])]
      if (l.length) throw new Error(`${who}: the refusal shows ${l.join(', ')}`)
    } },
  // folder access explained (server/src/admin/access-explain.ts): admins and the owner only. A person's list holds
  // their own users/<id> row from the member list and nothing else of users/ (no file, folder or personal project
  // name of alice's: the canaries plus her private project's name) and nothing of .system/
  explainFolderAccess: { build: (c, w) => c.get(`/api/admin/access/folder?path=${enc(w.groups.finFolder)}`), scope: 'byLevel',
    check: async (r, w, who) => {
      if (r.status === 200 && r.json?.people?.find((p: any) => p.user.id === 'bob')?.access !== 'write') throw new Error(`${who}: the finance folder does not show bob writing`)
      // the refusal of a path inside alice's folder (a file name an admin may not know) carries nothing of it either
      const probe = await w.as[who].get(`/api/admin/access/folder?path=${enc(`users/alice/${C.aliceFileName}.md`)}`)
      if (probe.status < 400 || probe.status >= 500) throw new Error(`${who}: a path in users/alice was answered (${probe.status})`)
      const l = [...leaks(who, probe.text), ...(probe.text.includes(C.aliceFileName) ? [C.aliceFileName] : [])]
      if (l.length) throw new Error(`${who}: the refusal shows ${l.join(', ')}`)
    } },
  explainPersonAccess: { build: (c) => c.get('/api/admin/access/people/alice'), scope: 'byLevel',
    check: (r, w, who) => {
      if (r.status !== 200) return
      const paths: string[] = r.json.folders.map((f: any) => f.path)
      if (paths.some((p) => (p.startsWith('users/') && p !== 'users/alice') || p.startsWith('.system'))) throw new Error(`${who}: alice's folder list shows ${paths.filter((p) => p.startsWith('users/') || p.startsWith('.system')).join(', ')}`)
      if (r.text.includes('Private plan')) throw new Error(`${who}: alice's folder list names her personal project`)
      if (!paths.includes('projects/falcon')) throw new Error(`${who}: alice's folder list misses projects/falcon`)
    } },
  // the folder tree (admin/access-tree.ts): admins and the owner only. users/ is one row (how many personal folders)
  // and nothing in it is listed, never .system/; a path inside alice's folder is refused without her file's name; the
  // finance group's folder shows bob writing there
  explainAccessTree: { build: (c) => c.get('/api/admin/access/tree?path=&open=1'), scope: 'byLevel',
    check: async (r, w, who) => {
      if (r.status === 200) {
        const nodes: any[] = r.json.levels.flatMap((l: any) => l.children)
        const bad = nodes.map((n) => n.path).filter((p: string) => p.startsWith('users/') || p.startsWith('.system'))
        if (bad.length) throw new Error(`${who}: the tree shows ${bad.join(', ')}`)
        const users = nodes.find((n) => n.path === 'users')
        if (!users || users.folders || users.who.length || !users.kinds.includes('personal')) throw new Error(`${who}: users/ is not one closed row`)
        if (r.text.includes(C.aliceFileName) || r.text.includes('Private plan')) throw new Error(`${who}: the tree names something of alice's folder`)
        const fin = await w.as[who].get(`/api/admin/access/tree?path=${enc(w.groups.finFolder.split('/').slice(0, -1).join('/'))}`)
        const node = fin.json?.levels?.[0]?.children?.find((n: any) => n.path === w.groups.finFolder)
        if (!node?.who.some((x: any) => x.access === 'write' && x.reason === 'rule')) throw new Error(`${who}: the finance folder does not show its group writing`)
        // "rule folders only": nothing of users/ or .system/ either, and the finance group's folder is there
        const ruled = await w.as[who].get('/api/admin/access/tree?path=&rules=1&limit=500')
        const listed: string[] = [...(ruled.json?.levels?.[0]?.children ?? []), ...(ruled.json?.above ?? [])].map((n: any) => n.path)
        if (listed.some((p) => p.startsWith('users') || p.startsWith('.system'))) throw new Error(`${who}: rule folders only shows ${listed.join(', ')}`)
        if (!listed.includes(w.groups.finFolder)) throw new Error(`${who}: rule folders only misses the finance group's folder`)
        if (ruled.text.includes(C.aliceFileName) || ruled.text.includes('Private plan')) throw new Error(`${who}: rule folders only names something of alice's folder`)
      }
      const probe = await w.as[who].get(`/api/admin/access/tree?path=${enc('users/alice')}`)
      if (probe.status < 400 || probe.status >= 500) throw new Error(`${who}: users/alice was listed (${probe.status})`)
      const l = [...leaks(who, probe.text), ...(probe.text.includes(C.aliceFileName) ? [C.aliceFileName] : [])]
      if (l.length) throw new Error(`${who}: the refusal shows ${l.join(', ')}`)
    } },
  explainNewPersonAccess: { build: (c, w) => c.post('/api/admin/access/new-person', { role: 'member', groupIds: [w.groups.finance] }), scope: 'byLevel',
    check: (r, w, who) => { if (r.status === 200 && r.json.folders.some((f: any) => f.path.startsWith('users'))) throw new Error(`${who}: the new-person list shows users/`) } },
  engines: { build: (c) => c.get('/api/admin/engines'), scope: 'byLevel' },
  // the request a member would make to let themselves pick the engine (and to send conversations to OpenAI)
  updateEngines: { build: (c) => c.patch('/api/admin/engines', { concurrency: 3, memberChoice: { mode: 'off', groupIds: [], userIds: [] }, limitFallback: false }), scope: 'byLevel' },
  checkEngine: { build: (c) => c.post('/api/admin/engines/claude-code/check'), scope: 'byLevel' },
  // AI connections (docs/PERMISSIONS.md): the owner and admins change the team's (adding / replacing / signing in
  // asks for their own password again); members only their own. Secrets never appear in any response (matrix.ts ALL).
  listCredentials: { build: (c) => c.get('/api/admin/credentials'), scope: 'byLevel',
    check: (r, w, who) => { if ((who === 'owner' || who === 'admin') && !r.text.includes('Team Max')) throw new Error('the team connection is missing from the list') } },
  createCredential: { skipPositive: true, build: (c) => c.post('/api/admin/credentials', { kind: 'anthropic-api-key', label: 'x', sealed: FAKE_SEALED, password: 'wrong-pass' }), scope: 'byLevel',
    check: reauthCheck('adding an AI connection') },
  updateCredential: { build: (c, w) => c.patch(`/api/admin/credentials/${w.ids.teamCredential}`, { label: 'Team Max' }), scope: 'byLevel' },
  replaceCredentialSecret: { skipPositive: true, build: (c, w) => c.post(`/api/admin/credentials/${w.ids.teamCredential}/secret`, { sealed: FAKE_SEALED, password: 'wrong-pass' }), scope: 'byLevel', check: reauthCheck('replacing an AI connection\'s key') },
  deleteCredential: { build: (c) => c.del('/api/admin/credentials/00000000-0000-7000-8000-000000000000'), scope: 'byLevel' },
  checkCredential: { build: (c, w) => c.post(`/api/admin/credentials/${w.ids.teamCredential}/check`), scope: 'byLevel' },
  startCredentialLogin: { skipPositive: true, build: (c) => c.post('/api/admin/credential-logins', { label: 'x', acknowledgedPlanNotice: true, password: 'wrong-pass' }), scope: 'byLevel', check: reauthCheck('starting an AI sign-in') },
  getCredentialLogin: { build: (c) => c.get('/api/admin/credential-logins/nonexistent-login-id-0000'), scope: 'nobody' },
  cancelCredentialLogin: { build: (c) => c.del('/api/admin/credential-logins/nonexistent-login-id-0000'), scope: 'nobody' },
  // the Claude code of a sign-in: only its starter's (an unknown sign-in: 404 before the sealed value is opened)
  submitCredentialLoginCode: { build: (c) => c.post('/api/admin/credential-logins/nonexistent-login-id-0000/code', { sealed: FAKE_SEALED }), scope: 'nobody' },
  updateCredentialSettings: { build: (c) => c.patch('/api/admin/credential-settings', { memberOwn: true }), scope: 'byLevel' },
  sealingKey: { build: (c) => c.get('/api/credentials/sealing-key'), scope: 'self',
    check: (r) => { if (r.status === 200 && ('d' in (r.json?.publicJwk ?? {}) || /"d"\s*:/.test(r.text))) throw new Error('the sealing key response carries the private part') } },
  myCredentials: { build: (c) => c.get('/api/me/credentials'), scope: 'self',
    check: (r, w, who) => { if (who !== 'memberIn' && r.text.includes(C.aliceOwnName)) throw new Error(`${who} sees alice's own connection through /api/me`) } },
  createMyCredential: { skipPositive: true, build: (c) => c.post('/api/me/credentials', { kind: 'anthropic-api-key', label: 'x', sealed: FAKE_SEALED }), scope: 'self',
    check: (r, w, who) => { if (r.status < 300 && (r.json?.scope !== 'personal' || r.json?.owner?.id !== USER_OF[who])) throw new Error('a personal connection made for someone else') } },
  deleteMyCredential: { build: (c, w) => c.del(`/api/me/credentials/${w.ids.aliceOwnCredential}`), scope: 'own-alice' },
  startMyCredentialLogin: { skipPositive: true, build: (c) => c.post('/api/me/credential-logins', { label: '', acknowledgedPlanNotice: true }), scope: 'self' },
  getMyCredentialLogin: { build: (c) => c.get('/api/me/credential-logins/nonexistent-login-id-0000'), scope: 'nobody' },
  cancelMyCredentialLogin: { build: (c) => c.del('/api/me/credential-logins/nonexistent-login-id-0000'), scope: 'nobody' },
  submitMyCredentialLoginCode: { build: (c) => c.post('/api/me/credential-logins/nonexistent-login-id-0000/code', { sealed: FAKE_SEALED }), scope: 'nobody' },
  listBudgets: { build: (c) => c.get('/api/admin/budgets'), scope: 'byLevel' },
  createBudget: { build: (c) => c.post('/api/admin/budgets', { subjectType: 'team', subjectId: null, period: 'day', limitUsd: 10, action: 'warn' }), scope: 'byLevel' },
  updateBudget: { build: (c, w) => c.patch(`/api/admin/budgets/${w.ids.budget}`, { limitUsd: 20 }), scope: 'byLevel' },
  deleteBudget: { build: (c, w) => c.del(`/api/admin/budgets/${w.ids.budget}`), scope: 'byLevel' },
  settings: { build: (c) => c.get('/api/admin/settings'), scope: 'byLevel' },
  updateSettings: { build: (c) => c.patch('/api/admin/settings', { auditRetentionDays: 90 }), scope: 'byLevel' },
  speechHost: { build: (c) => c.get('/api/admin/speech-host'), scope: 'byLevel' },
  speechKey: { build: (c) => c.get('/api/admin/speech-key'), scope: 'byLevel', check: (r) => { if (r.text.includes('sk-or-')) throw new Error('the speech key status shows a key') } },
  setSpeechKey: { skipPositive: true, build: (c) => c.put('/api/admin/speech-key', { sealed: null, password: 'wrong-pass' }), scope: 'byLevel' },
  usage: { build: (c) => c.get('/api/admin/usage'), scope: 'byLevel' },
  audit: { build: (c) => c.get('/api/admin/audit?limit=200'), scope: 'byLevel',
    // the audit list must hide names/sizes inside OTHER people's users/<id>/ even from owner/admin (tab 2, DECISIONS
    // "남의 개인 폴더 안은 ... 감사 목록에서도 users/<id>/…로만 보인다"). Group-folder names (finance) are fine for them.
    check: (r, w, who) => { for (const x of [C.aliceFileName, C.aliceAttName, C.aliceUploadName, C.aliceTrashName]) if (r.text.includes(x)) throw new Error(`audit shows a name inside users/alice to ${who}: ${x}`) } },

  // ---- system (owner / public) ----
  health: { build: (c) => c.get('/api/health'), scope: 'byLevel' },
  diagnostics: { build: (c) => c.get('/api/admin/diagnostics'), scope: 'byLevel' },
  // storage use of the team disk + the plan (admin and owner; system/storage.ts)
  storage: { build: (c) => c.get('/api/admin/storage'), scope: 'byLevel' },
  // the plan card (admin and owner) and the operator's notices (everyone signed in, filtered by role): system/managed.ts
  plan: { build: (c) => c.get('/api/admin/plan'), scope: 'byLevel' },
  managedNotices: { build: (c) => c.get('/api/managed/notices'), scope: 'byLevel' },
  updateStatus: { build: (c) => c.get('/api/admin/update'), scope: 'byLevel' },
  startUpdate: { skipPositive: true, build: (c) => c.post('/api/admin/update', { password: 'wrong-pass' }), scope: 'byLevel' },
  // office mode automatic updates (admin and owner): status is null outside office mode; "now" re-asks the password
  officeUpdateStatus: { build: (c) => c.get('/api/admin/office-update'), scope: 'byLevel' },
  officeUpdateAction: { skipPositive: true, build: (c) => c.post('/api/admin/office-update', { action: 'now', password: 'wrong-pass' }), scope: 'byLevel' },
  listBackups: { build: (c) => c.get('/api/admin/backups'), scope: 'byLevel' },
  startBackup: { build: (c) => c.post('/api/admin/backup', { scope: 'db' }), scope: 'byLevel' },
  startRestore: { skipPositive: true, build: (c) => c.post('/api/admin/restore', { backupId: 'nope', password: 'wrong' }), scope: 'byLevel' },
  startExport: { build: (c) => c.post('/api/admin/export', { what: ['memories'], password: '' }), scope: 'byLevel' },
  connection: { build: (c) => c.get('/api/admin/connection'), scope: 'byLevel' },
  // connected folders (owner only; adding one asks for the password again)
  listConnected: { build: (c) => c.get('/api/admin/connected'), scope: 'byLevel' },
  addConnected: { skipPositive: true, build: (c) => c.post('/api/admin/connected', { name: 'nas', source: '/Volumes/none', password: 'wrong-pass' }), scope: 'byLevel' },
  syncConnected: { build: (c) => c.post('/api/admin/connected/00000000-0000-7000-8000-000000000000/sync'), scope: 'byLevel' },
  removeConnected: { build: (c) => c.del('/api/admin/connected/00000000-0000-7000-8000-000000000000'), scope: 'byLevel' },
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
