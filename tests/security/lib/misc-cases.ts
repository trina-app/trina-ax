// Matrix cases for routes that had none (the coverage test failed on dev without them): the dev environment, the team
// invite link, the welcome steps and the company profile, skill packs and drafts, the AI access request, the room
// search and the room AI's cards, the away switch, the demo company and the after-update to-dos.
//
// Each case aims at something the wrong person must not reach: alice's chat (getResultSuggestion, the drafts), the DM
// of alice and erin (rooms), projects/falcon (the dev environment: alice writes it, bob reads it), another person's
// share proposal. A write is refused after the permission check where it would change the world (an unknown group, a
// body that cannot be valid), so the role gate is tested without side effects. The owner's team start changes the world:
// it is in MISC_LAST_SPECS, spread at the end of SPECS (this table goes with the other tables, before cases.ts's own, so
// erin and bob still have their sessions: cases.ts deletes erin and resets bob's password in phase 2).
import type { Resp } from './instance'
import type { Spec } from './cases'
import { C, USER_OF, type Who, type World } from './world'

const UNKNOWN_GROUP = '01900000-0000-7000-8000-00000000f00d'
const err = (r: Resp) => r.json?.error as { fields?: Record<string, string>; params?: Record<string, unknown> } | undefined
const admin = (who: Who) => who === 'owner' || who === 'admin'

/** An owner or admin is refused for the body (400 with this field), never let through; a member is refused for the role. */
const bodyCheck = (field: string, what: string) => (r: Resp, _w: World, who: Who) => {
  if (r.status < 300) throw new Error(`${who}: ${what} went through with a body that cannot be valid`)
  if (admin(who) && !(r.status === 400 && err(r)?.fields?.[field])) throw new Error(`${who}: ${what} was not refused for ${field} (status ${r.status} ${r.text.slice(0, 160)})`)
  if ((who === 'memberIn' || who === 'other' || who === 'memberOut') && r.status !== 403) throw new Error(`${who}: ${what} was not refused for the role (status ${r.status})`)
}

// ---- the dev environment (experiment): every route is 404 while the server runs without MYCEL_DEV_ENV=1, so the
// flag (and for the srt runner's routes, MYCEL_DEV_ENV_RUNNER=srt) is on only while one request runs. No helper is
// set up (no MYCEL_BOXD_SOCK, no srt install): nothing starts, every answer stops at the checks.
async function devEnvOn<T>(runner: 'box' | 'srt', run: () => Promise<T>): Promise<T> {
  const before = { flag: process.env.MYCEL_DEV_ENV, runner: process.env.MYCEL_DEV_ENV_RUNNER }
  process.env.MYCEL_DEV_ENV = '1'
  if (runner === 'srt') process.env.MYCEL_DEV_ENV_RUNNER = 'srt'
  else delete process.env.MYCEL_DEV_ENV_RUNNER
  try { return await run() } finally {
    if (before.flag === undefined) delete process.env.MYCEL_DEV_ENV
    else process.env.MYCEL_DEV_ENV = before.flag
    if (before.runner === undefined) delete process.env.MYCEL_DEV_ENV_RUNNER
    else process.env.MYCEL_DEV_ENV_RUNNER = before.runner
  }
}
const NO_RUN = 'matrixnorun000000000000000000000'
const badScope = { mode: 'selected', groupIds: ['no-such-group'], userIds: [] }

// ---- the team invite link: one made once (by the owner, on the join case's first run in phase 1, where the denies run;
// no other case reads team links) for the two public routes; the admin writes are refused for an
// unknown group, so they never replace it; the owner's revoke (phase 2) takes it away
let link: Promise<string> | null = null
function linkToken(w: World): Promise<string> {
  link ??= (async () => {
    const r = await w.as.owner.ok('POST', '/api/admin/team-link', { groupIds: [], expiresInDays: 7 })
    const url = r.link?.url as string | null
    const token = url ? new URLSearchParams(new URL(url).hash.slice(1)).get('t') : null
    if (!token) throw new Error(`the team link has no token to use: ${JSON.stringify(r).slice(0, 200)}`)
    return token
  })()
  return link
}

// ---- a share proposal of the owner's (made once, ready: stopping its check changes nothing)
const DANA_SHARE = '01900000-0000-7000-8000-00000000da9b'
let share = false
function danaShare(w: World): void {
  if (share) return
  share = true
  const now = new Date()
  w.inst.ctx.db.query(`INSERT INTO skill_shares (id, created_by, source, status, ai, where_label, projects, result, created_at, expires_at, updated_at)
    VALUES (?, 'dana', 'browser', 'ready', 'none', NULL, NULL, ?, ?, ?, ?)`)
    .run(DANA_SHARE, JSON.stringify({ candidates: [], rule: null, ruleIn: null, tools: [], landing: null }), now.toISOString(), new Date(now.getTime() + 86_400_000).toISOString(), now.toISOString())
}

// ---- draft chats of the owner's own, with no answer yet (a company profile draft and a team skill draft), made once:
// only she reads or saves them; an admin gets 404, as for a chat that is not there (the routes are admin-level)
const DANA_PROFILE_DRAFT = '01900000-0000-7000-8000-00000000da91'
const DANA_SKILL_DRAFT = '01900000-0000-7000-8000-00000000da92'
let drafts = false
function danaDrafts(w: World): void {
  if (drafts) return
  drafts = true
  const db = w.inst.ctx.db, now = new Date().toISOString()
  for (const id of [DANA_PROFILE_DRAFT, DANA_SKILL_DRAFT]) db.query("INSERT INTO chats (id, user_id, title) VALUES (?, 'dana', 'draft')").run(id)
  db.query("INSERT INTO onboarding_profile_drafts (chat_id, user_id, source, website, site, created_at) VALUES (?, 'dana', 'text', '', NULL, ?)").run(DANA_PROFILE_DRAFT, now)
  const material = { title: '', question: '', answer: '', skill: null, files: [], used: [], locale: 'en', pack: 'general' }
  db.query("INSERT INTO onboarding_skill_drafts (chat_id, user_id, source_chat_id, source_message_id, material, created_at) VALUES (?, 'dana', ?, ?, ?, ?)")
    .run(DANA_SKILL_DRAFT, DANA_PROFILE_DRAFT, 'none', JSON.stringify(material), now)
}
/** the owner reads her own draft; an admin is told it is not there (404), never refused for the role */
const ownDraftCheck = (what: string, ownStatus: number) => (r: Resp, _w: World, who: Who) => {
  if (who === 'owner' && r.status !== ownStatus) throw new Error(`the owner's own ${what} answered ${r.status}, not ${ownStatus}: ${r.text.slice(0, 160)}`)
  if (who === 'admin' && r.status !== 404) throw new Error(`the admin reached the owner's ${what}: ${r.status}`)
}

export const MISC_SPECS: Record<string, Spec> = {
  // ---- dev environment of a project: seen like the project (projects/falcon: alice, bob who reads it, owner, admin)
  devEnv: { build: (c, w) => devEnvOn('box', () => c.get(`/api/projects/${w.ids.projFalcon}/dev-env`)), scope: 'falcon-read',
    // alice's personal project: only alice, never the owner or an admin
    check: async (r, w, who) => {
      if (who === 'anon' || who === 'pwchange') return
      const own = await devEnvOn('box', () => w.as[who].get(`/api/projects/${w.ids.projAlice}/dev-env`))
      if ((who === 'memberIn') !== (own.status === 200)) throw new Error(`${who}: alice's personal project's dev environment answered ${own.status}`)
    } },
  devEnvActivity: { build: (c, w) => devEnvOn('box', () => c.get(`/api/projects/${w.ids.projFalcon}/dev-env/activity`)), scope: 'falcon-read' },
  // the project's settings: admins only (a member 403); the body names an unknown group, so nothing is saved
  updateDevEnv: { build: (c, w) => devEnvOn('box', () => c.put(`/api/projects/${w.ids.projFalcon}/dev-env`, { enabled: false, scope: badScope })), scope: 'byLevel',
    check: async (r, w, who) => {
      bodyCheck('body.scope.groupIds', 'a project dev environment change')(r, w, who)
      // an admin does not reach alice's personal project either
      if (admin(who)) {
        const own = await devEnvOn('box', () => w.as[who].put(`/api/projects/${w.ids.projAlice}/dev-env`, { enabled: false, scope: badScope }))
        if (own.status !== 404) throw new Error(`${who}: alice's personal project's dev environment answered ${own.status}`)
      }
    } },
  // stop / restart the box: people who may use it, and admins. It is off here, so nobody may use it: alice and bob see
  // the project and are refused (403), erin does not see it (404); the owner and the admin pass and meet no helper (409)
  devEnvBox: { build: (c, w) => devEnvOn('box', () => c.post(`/api/projects/${w.ids.projFalcon}/dev-env/box`, { action: 'stop' })), scope: 'admins',
    check: (r, _w, who) => {
      const want: Partial<Record<Who, number>> = { owner: 409, admin: 409, memberIn: 403, memberOut: 403, other: 404 }
      if (want[who] !== undefined && r.status !== want[who]) throw new Error(`${who}: stopping the box answered ${r.status}, not ${want[who]}`)
    } },
  // a preview link: who can read the folder, while the project's dev environment is on (off here: 409 after the check)
  devEnvPreview: { build: (c, w) => devEnvOn('box', () => c.post(`/api/projects/${w.ids.projFalcon}/dev-env/preview`, { port: 3000 })), scope: 'falcon-read',
    check: (r, _w, who) => { if (r.status < 300) throw new Error(`${who}: a preview link was issued for a project whose dev environment is off`) } },
  // srt: a run of this project nobody has (who started a run, who may use it, admins: tests/unit/dev-env-queue.test.ts)
  devEnvRunStop: { build: (c, w) => devEnvOn('srt', () => c.post(`/api/projects/${w.ids.projFalcon}/dev-env/runs/${NO_RUN}/stop`)), scope: 'nobody' },
  devEnvTeam: { build: (c) => devEnvOn('box', () => c.get('/api/admin/dev-env')), scope: 'byLevel' },
  updateDevEnvTeam: { build: (c) => devEnvOn('srt', () => c.put('/api/admin/dev-env', { scope: { ...badScope, groupIds: [UNKNOWN_GROUP] } })), scope: 'byLevel',
    check: bodyCheck('body.scope.groupIds', 'a team dev environment change') },
  // srt: each person's own runs and sites (only their own: the request names nobody)
  myDevEnvRuns: { build: (c) => devEnvOn('srt', () => c.get('/api/dev-env/runs')), scope: 'self',
    check: (r, _w, who) => { if (r.status === 200 && [...r.json.running, ...r.json.waiting].some((x: any) => x.by?.id !== USER_OF[who])) throw new Error(`${who} sees someone else's run`) } },
  stopMyDevEnvRun: { build: (c) => devEnvOn('srt', () => c.post(`/api/dev-env/runs/${NO_RUN}/stop`)), scope: 'nobody' },
  myDevEnvSites: { build: (c) => devEnvOn('srt', () => c.get('/api/dev-env/sites')), scope: 'self' },
  removeMyDevEnvSite: { build: (c) => devEnvOn('srt', () => c.post('/api/dev-env/sites/remove', { host: 'example.com' })), scope: 'nobody' },
  // Full internet on: never without the network and the warning (409 for everyone signed in here)
  setMyDevEnvFullInternet: { build: (c) => devEnvOn('srt', () => c.put('/api/dev-env/full-internet', { on: true })), scope: 'self',
    check: (r, _w, who) => {
      if (r.status < 300) throw new Error(`${who}: Full internet went on without the warning`)
      if (who !== 'anon' && who !== 'pwchange' && r.status !== 409) throw new Error(`${who}: Full internet was refused with ${r.status}, not 409`)
    } },

  // ---- the team invite link (owners and admins; the two public routes take the token in the body)
  getTeamLink: { build: (c) => c.get('/api/admin/team-link'), scope: 'byLevel' },
  createTeamLink: { build: (c) => c.post('/api/admin/team-link', { groupIds: [UNKNOWN_GROUP] }), scope: 'byLevel', check: bodyCheck('body.groupIds', 'a team link') },
  updateTeamLink: { build: (c) => c.patch('/api/admin/team-link', { addGroupIds: [UNKNOWN_GROUP] }), scope: 'byLevel', check: bodyCheck('body.addGroupIds', 'a team link change') },
  // what the link is for: the team's name and whether it works, for anyone with the token; never its groups, maker,
  // address or uses. An unknown token: 404 with nothing about the team
  teamLinkInfo: { build: async (c, w) => c.post('/api/team-link/info', { token: await linkToken(w) }), scope: 'byLevel',
    check: async (r, w, who) => {
      if (r.status !== 200 || r.json?.teamName !== 'Sec Team' || r.json?.valid !== true) throw new Error(`${who}: the link's info answered ${r.status} ${r.text.slice(0, 160)}`)
      const extra = Object.keys(r.json).filter((k) => !['teamName', 'valid', 'problem', 'expiresAt', 'skillName', 'skillTitle'].includes(k))
      if (extra.length) throw new Error(`${who}: the link's info carries ${extra.join(', ')}`)
      if (who === 'anon') {
        const none = await w.as.anon.post('/api/team-link/info', { token: 'x'.repeat(43) })
        if (none.status !== 404 || none.text.includes('Sec Team')) throw new Error(`an unknown token answered ${none.status} ${none.text.slice(0, 160)}`)
      }
    } },
  // joining with the token: refused for a weak password, after the token was found (nobody gets an account here)
  joinTeamLink: { skipPositive: true, build: async (c, w) => c.post('/api/team-link/join', { token: await linkToken(w), username: 'matrixjoin', name: 'Matrix Join', password: 'aaaaaaaa' }), scope: 'nobody',
    check: (r, _w, who) => { if (!(r.status === 400 && err(r)?.fields?.['body.password'])) throw new Error(`${who}: a join with a weak password answered ${r.status} ${r.text.slice(0, 160)}`) } },
  revokeTeamLink: { build: (c) => c.del('/api/admin/team-link'), scope: 'byLevel',
    check: (r, _w, who) => { if (!admin(who) && r.status < 400) throw new Error(`${who} revoked the team link`) } },

  // ---- the welcome steps (owners and admins read them, the owner records them)
  getWelcome: { build: (c) => c.get('/api/onboarding/welcome'), scope: 'byLevel' },
  // the result chat must be the owner's own: alice's chat is refused (404), nothing is recorded
  updateWelcome: { build: (c, w) => c.patch('/api/onboarding/welcome', { resultChatId: w.ids.chatA }), scope: 'byLevel',
    check: (r, _w, who) => { if (who === 'owner' && r.status !== 404) throw new Error(`the owner pointed the welcome steps at alice's chat: ${r.status}`) } },
  // the brand step: owner only; a body that cannot be valid (an empty path), so no folder or file is made
  welcomeBrand: { build: (c) => c.post('/api/onboarding/welcome/brand', { files: [''] }), scope: 'byLevel',
    check: (r, _w, who) => { if (r.status < 300) throw new Error(`${who}: the brand step ran with an empty file path`) } },
  // one suggestion under an answer of the caller's own chat: alice's answer, for alice only (404 for anyone else)
  getResultSuggestion: { build: (c, w) => c.get(`/api/onboarding/suggestion?chatId=${w.ids.chatA}&messageId=${w.ids.assistantMsg}`), scope: 'own-alice' },
  // closing a suggestion: the caller's own (the body names nobody; one that names a person is refused)
  dismissSuggestion: { build: (c) => c.post('/api/onboarding/suggestion/dismiss', { key: 'deck-video' }), scope: 'self',
    check: async (r, w, who) => {
      if (r.status !== 204) return
      const kept = w.inst.ctx.db.query("SELECT user_id FROM suggestion_dismissals WHERE key = 'deck-video'").all() as { user_id: string }[]
      if (!kept.some((x) => x.user_id === USER_OF[who])) throw new Error(`${who}: the dismissal was not kept for the caller`)
      const spoof = await w.as[who].req('POST', '/api/onboarding/suggestion/dismiss', { key: 'ppt', userId: 'alice' })
      if (spoof.status !== 400) throw new Error(`${who}: a body naming a person was not refused: ${spoof.status}`)
    } },

  // ---- the company profile: any member reads it when the folder rules let them (null here); owners and admins save
  getCompanyProfile: { build: (c) => c.get('/api/onboarding/profile'), scope: 'self' },
  saveCompanyProfile: { build: (c) => c.put('/api/onboarding/profile', {}), scope: 'byLevel',
    check: (r, _w, who) => { if (r.status < 300) throw new Error(`${who}: an empty company profile was saved`) } },
  // a draft from the website or pasted text: owners and admins; neither given, so no chat starts (400 after the check)
  startProfileDraft: { build: (c) => c.post('/api/onboarding/profile/draft', {}), scope: 'byLevel', check: bodyCheck('body', 'a profile draft') },
  // a profile draft chat of the caller's own: the owner's draft is hers only (an admin 404, members 403 for the role)
  getProfileDraft: { build: (c, w) => { danaDrafts(w); return c.get(`/api/onboarding/profile/draft/${DANA_PROFILE_DRAFT}`) }, scope: 'own-owner', check: ownDraftCheck('profile draft', 200) },
  // a team skill from one of the caller's chats: alice's chat is not the owner's or an admin's to draft, read or save
  startSkillDraft: { build: (c, w) => c.post('/api/onboarding/skill-draft', { chatId: w.ids.chatA }), scope: 'nobody' },
  // the owner's own skill draft (no answer yet): only she reads it; her save is refused as not ready (409), nothing saved
  getSkillDraft: { build: (c, w) => { danaDrafts(w); return c.get(`/api/onboarding/skill-draft/${DANA_SKILL_DRAFT}`) }, scope: 'own-owner', check: ownDraftCheck('skill draft', 200) },
  saveSkillDraft: { build: (c, w) => { danaDrafts(w); return c.post(`/api/onboarding/skill-draft/${DANA_SKILL_DRAFT}/save`, { title: 'x' }) }, scope: 'own-owner', check: ownDraftCheck('skill draft save', 409) },
  // the 7-day team goal (owners and admins)
  getTeamGoal: { build: (c) => c.get('/api/onboarding/goal'), scope: 'byLevel' },
  // recommended skill packs (owners and admins); a skill the pack does not have, so nothing is written
  listSkillPacks: { build: (c) => c.get('/api/onboarding/packs'), scope: 'byLevel' },
  installSkillPack: { build: (c) => c.post('/api/onboarding/packs/general/install', { skills: ['no-such-skill'] }), scope: 'byLevel', check: bodyCheck('body.skills.0', 'a pack install') },

  // ---- AI access: everyone reads their own; asking the owner is for members who cannot use AI (never the owner or an
  // admin: 403). Here the team connection answers everyone, so every member is refused too.
  getAiAccess: { build: (c) => c.get('/api/me/ai-access'), scope: 'self' },
  requestAiAccess: { skipPositive: true, build: (c) => c.post('/api/me/ai-access/request'), scope: 'members',
    check: async (r, w, who) => {
      if (who === 'anon' || who === 'pwchange') return
      if (admin(who)) { if (r.status !== 403) throw new Error(`${who}: asking for AI access answered ${r.status}, not 403`); return }
      const usable = (await w.as[who].get('/api/me/ai-access')).json?.usable
      if (usable && r.status !== 403) throw new Error(`${who} can use AI and still asked the owner: ${r.status}`)
      if (!usable && r.status !== 200) throw new Error(`${who} cannot use AI and could not ask: ${r.status}`)
    } },
  // the hosting service's trial credit (owners and admins; none on a self-hosted server), never its key
  trialCredit: { build: (c) => c.get('/api/admin/trial-credit'), scope: 'byLevel', check: (r) => { if (r.text.includes('sk-or-')) throw new Error('the trial credit shows a key') } },

  // ---- rooms: the open cards of my own questions in a room I am in (the DM: alice and erin only)
  listRoomAiRequests: { build: (c, w) => c.get(`/api/rooms/${w.ids.dmRoom}/ai/requests`), scope: 'room-dm' },
  // search: each person's own rooms; the DM's message is found by its two people and by nobody else (the matrix's
  // canary check catches it for everyone else)
  searchRoomMessages: { build: (c) => c.get(`/api/room-messages?q=${encodeURIComponent(C.dmMsg)}`), scope: 'self',
    check: (r, _w, who) => { if ((who === 'memberIn' || who === 'other') && !r.text.includes(C.dmMsg)) throw new Error(`${who} does not find the DM's message`) } },
  // the files sent there, by name: the DM's file is found by its two people and by nobody else (the canary check)
  searchRoomFiles: { build: (c) => c.get(`/api/room-files?q=${encodeURIComponent(C.dmFileName)}`), scope: 'self',
    check: (r, _w, who) => { if ((who === 'memberIn' || who === 'other') && !r.text.includes(C.dmFileName)) throw new Error(`${who} does not find the DM's file`) } },
  // away: only my own (a body naming someone else is refused)
  setMyAway: { build: (c) => c.put('/api/me/away', { away: false }), scope: 'self',
    check: async (r, w, who) => {
      if (r.status !== 200) return
      const spoof = await w.as[who].req('PUT', '/api/me/away', { away: true, userId: 'alice' })
      if (spoof.status !== 400) throw new Error(`${who}: a body naming a person was not refused: ${spoof.status}`)
    } },

  // ---- a share proposal's check: its proposer's only (the owner's ready proposal: 200 for her, 404 for anyone else)
  stopSkillShareCheck: { build: (c, w) => { danaShare(w); return c.post(`/api/skill-shares/${DANA_SHARE}/stop-check`) }, scope: 'own-owner',
    check: (r, _w, who) => {
      if (who === 'owner' && r.status !== 200) throw new Error(`the owner could not stop her own share's check: ${r.status}`)
      if (who !== 'owner' && r.status < 400) throw new Error(`${who} stopped the owner's share check`)
      if (who === 'admin' && r.status !== 404) throw new Error(`the admin was refused the owner's share with ${r.status}, not 404`)
    } },

  // ---- the demo company exists only on a development server started with it: elsewhere 404 for everyone, signed in
  // or not, like a route that is not there; switching never signs anyone in
  demoInfo: { build: (c) => c.get('/api/demo'), scope: 'nobody', check: (r, _w, who) => { if (r.status !== 404) throw new Error(`${who}: the demo info answered ${r.status}`) } },
  demoSwitch: { skipPositive: true, build: (c) => c.post('/api/demo/persona', { key: 'newHire' }), scope: 'nobody',
    check: (r, _w, who) => { if (r.status !== 404) throw new Error(`${who}: the demo switch answered ${r.status}`) } },

  // ---- after-update to-dos (owners and admins); a to-do nobody has: 404 after the check
  afterUpdateActions: { build: (c) => c.get('/api/admin/after-update'), scope: 'byLevel' },
  dismissAfterUpdate: { build: (c) => c.post('/api/admin/after-update/no-such-todo/dismiss', {}), scope: 'byLevel',
    check: (r, _w, who) => { if (admin(who) && r.status !== 404) throw new Error(`${who}: dismissing an unknown to-do answered ${r.status}`) } },
}

/** Spread at the very end of SPECS: the owner's team start, once (a group named after the team with its folders, the
 * owner in it). It changes the world, so it runs after every other case of its phase (only the owner is let through;
 * the refusals run in phase 1 and change nothing). */
export const MISC_LAST_SPECS: Record<string, Spec> = {
  setupWelcomeTeam: { build: (c) => c.post('/api/onboarding/welcome/team'), scope: 'byLevel',
    check: (r, _w, who) => { if (who === 'owner' && r.status !== 200) throw new Error(`the owner's team start answered ${r.status} ${r.text.slice(0, 160)}`) } },
}
