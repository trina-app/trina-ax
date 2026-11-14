// Guest states (docs/DECISIONS.md "Guest states: true reasons, a reset AI, and coming back with a restored place";
// the independent QA review of guest invites): converting resets the guest's AI and limit (QA TC-2199, 2247, 2306); a
// dead invite link says its true reason (TC-2219, 2225, 2226, 2230, 2297, 2298); Admin reads "N of M guests"
// (TC-2192); a refused send at the limit carries when it resets (TC-2201); a removed guest comes back only to a place
// that is there, said plainly otherwise (TC-2233, 2307, 2308); a restored project brings its guests back, a rename
// keeps them, deleting for good keeps them off (TC-2237–2242, 2295, 2296); a plan lowered below the guests removes
// nobody (TC-2256); a deleted team AI account leaves a guest with a plain state and nothing broken (TC-2255).
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import path from 'node:path'
import { Plan, setPlanForTests } from '../../server/src/system/limits'
import { setEnginesEnabled } from '../../server/src/admin/settings'
import { budgetBlock, periodEnd } from '../../server/src/admin/budgets'
import { teamTimeZone } from '../../server/src/admin/settings'
import { AUTH_MESSAGES } from '../../server/src/auth/messages'
import { addCred, testCredCtx } from '../lib/credentials'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'
import { addGuest, groupChat } from './guest-lib'

setDefaultTimeout(120_000)
let h: Harness
afterEach(async () => { setPlanForTests(undefined); await h?.close() })

const plan = (o: { maxGuests?: number; maxActiveMembers?: number }) =>
  Plan.parse({ format: 1, plan: 'team', maxConcurrency: 3, memoryMiB: 4096, cpuCores: 2, diskGiB: 50, maxActiveMembers: o.maxActiveMembers ?? 100, ...(o.maxGuests !== undefined ? { maxGuests: o.maxGuests } : {}) })
const key = (s: string) => `sk-ant-api03-${s}${'k'.repeat(30)}`
const status = (id: string) => (h.ctx.db.query('SELECT status FROM users WHERE id = ?').get(id) as { status: string }).status
const tokenOf = (inv: { url: string }) => inv.url.split('/invite/')[1]!
const info = (token: string) => h.client().call('GET', `/api/invites/${token}`)
const accept = (token: string, username: string) => h.client().try('POST', `/api/invites/${token}/accept`, { username, name: username, password: 'guest river lamp 77' })
const guestRow = async (owner: Client, id: string) => ((await owner.call('GET', '/api/admin/users')).items as { id: string; status: string; guest?: { placeOut?: string; teamAiGone?: boolean; ai: { mode: string } } }[]).find((u) => u.id === id)!

async function setup(name: string) {
  h = await harness(name)
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const otto = await addMember(h, owner, { username: 'otto' })
  const room = await groupChat(owner, [mia.id, nora.id, otto.id], 'Quote prep')
  const t = testCredCtx(h.ctx.db, path.join(h.ctx.config.dataDir, 'test-secrets'))
  setEnginesEnabled(h.ctx.db, { 'claude-code': true, codex: true })
  return { owner, mia, nora, otto, room, t }
}

test('convert: the guest AI and its monthly limit go with the guest; a removed guest comes back as a member', async () => {
  const { owner, mia, room, t } = await setup('a-guests-states-convert')
  const team = addCred(t.cc, 'anthropic-api-key', key('guestteam'), { label: 'Main Claude' })
  const g = await addGuest(h, owner, { username: 'tia', place: { kind: 'room', id: room }, ai: { mode: 'team', credentialId: team, limitUsd: 15 } })
  expect((h.ctx.db.query("SELECT COUNT(*) AS n FROM budgets WHERE subject_type = 'user' AND subject_id = ?").get(g.id) as { n: number }).n).toBe(1)
  const u = await owner.call('POST', `/api/admin/users/${g.id}/convert-guest`)
  expect(u.role).toBe('member')
  expect(u.guest).toBeUndefined()
  // nothing of the guest's AI stays: no guests row (its team account), no $15 block of their own
  expect(h.ctx.db.query('SELECT 1 FROM guests WHERE user_id = ?').get(g.id)).toBeNull()
  expect((h.ctx.db.query("SELECT COUNT(*) AS n FROM budgets WHERE subject_type = 'user' AND subject_id = ?").get(g.id) as { n: number }).n).toBe(0)
  expect(budgetBlock(h.ctx.db, g.id, 'en')).toBeNull()

  // a removed guest made a team member: switched on with it, taking a seat (checked first: 409 seat_limit)
  const g2 = await addGuest(h, mia.client, { username: 'gus', place: { kind: 'room', id: room } })
  await owner.call('PATCH', `/api/admin/users/${g2.id}`, { status: 'disabled' })
  const seats = ((await owner.call('GET', '/api/admin/users')).items as { role: string; status: string }[]).filter((x) => x.role !== 'guest' && x.status === 'active').length
  setPlanForTests(plan({ maxActiveMembers: seats, maxGuests: 10 }))
  const full = await owner.try('POST', `/api/admin/users/${g2.id}/convert-guest`)
  expect(`${full.status} ${full.body.error.params.reason}`).toBe('409 seat_limit')
  expect(status(g2.id)).toBe('disabled')
  setPlanForTests(plan({ maxActiveMembers: seats + 1, maxGuests: 10 }))
  const back = await owner.call('POST', `/api/admin/users/${g2.id}/convert-guest`)
  expect(back).toMatchObject({ role: 'member', status: 'active' })
})

test('a dead invite link says its true reason: expired, used, revoked, the inviter gone, the place gone', async () => {
  const { owner, mia, nora, room } = await setup('a-guests-states-reasons')
  const live = await mia.client.call('POST', '/api/guest-invites', { place: { kind: 'room', id: room } })
  expect((await info(tokenOf(live))).reason).toBeUndefined()
  // used
  expect((await accept(tokenOf(live), 'gus')).status).toBe(201)
  expect(await info(tokenOf(live))).toMatchObject({ valid: false, reason: 'used' })
  // revoked by hand (the owner's own member invite)
  const rev = await owner.call('POST', '/api/admin/invites', { role: 'member' })
  await owner.call('DELETE', `/api/admin/invites/${rev.invite.id}`)
  expect(await info(tokenOf(rev))).toMatchObject({ valid: false, reason: 'revoked' })
  // expired
  const old = await mia.client.call('POST', '/api/guest-invites', { place: { kind: 'room', id: room } })
  h.ctx.db.query("UPDATE invites SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(old.invite.id)
  expect(await info(tokenOf(old))).toMatchObject({ valid: false, reason: 'expired' })
  // the inviter left the room (TC-2225): the page says so, and the accept (TC-2226) too, with the same sentence
  const left = await nora.client.call('POST', '/api/guest-invites', { place: { kind: 'room', id: room } })
  await nora.client.call('POST', `/api/rooms/${room}/leave`)
  const i = await info(tokenOf(left))
  expect(i).toMatchObject({ valid: false, reason: 'inviter_gone' })
  // only the reason: no place, no inviter, nothing of the team but its name
  expect(i.guestPlace).toBeUndefined()
  expect(i.inviterName).toBeNull()
  const refused = await accept(tokenOf(left), 'gia')
  expect(`${refused.status} ${refused.body.error.params.reason}`).toBe('410 inviter_gone')
  expect(refused.body.error.message).toBe(AUTH_MESSAGES.inviteInviterGone.ko)
  expect(h.ctx.db.query("SELECT 1 FROM users WHERE username = 'gia'").get()).toBeNull()
  // the inviter switched off (TC-2298): their links were turned off with them, and the page says why
  const byMia = await mia.client.call('POST', '/api/guest-invites', { place: { kind: 'room', id: room } })
  await owner.call('PATCH', `/api/admin/users/${mia.id}`, { status: 'disabled' })
  expect(await info(tokenOf(byMia))).toMatchObject({ valid: false, reason: 'inviter_gone' })
  // a Team AI link made by an admin who is then made a member (TC-2230)
  const ada = await addMember(h, owner, { username: 'ada', role: 'admin' })
  const t = testCredCtx(h.ctx.db, path.join(h.ctx.config.dataDir, 'test-secrets-2'))
  const team = addCred(t.cc, 'anthropic-api-key', key('reasonteam'), { label: 'team' })
  const p = await ada.client.call('POST', '/api/projects', { name: 'Launch', scope: 'team' })
  const teamLink = await ada.client.call('POST', '/api/guest-invites', { place: { kind: 'project', id: p.id }, ai: { mode: 'team', credentialId: team, limitUsd: 5 } })
  await owner.call('PATCH', `/api/admin/users/${ada.id}`, { role: 'member' })
  expect((await info(tokenOf(teamLink))).reason).toBe('inviter_gone')
  // the place gone (TC-2297): the project in the trash
  const p2 = await owner.call('POST', '/api/projects', { name: 'Trashed', scope: 'team' })
  const placeLink = await owner.call('POST', '/api/guest-invites', { place: { kind: 'project', id: p2.id } })
  await owner.call('DELETE', `/api/projects/${p2.id}`)
  expect(await info(tokenOf(placeLink))).toMatchObject({ valid: false, reason: 'place_gone' })
  const r2 = await accept(tokenOf(placeLink), 'gil')
  expect(`${r2.status} ${r2.body.error.params.reason}`).toBe('410 place_gone')
  // each reason has its own sentence in every language
  for (const k of ['inviteExpired', 'inviteUsedUp', 'inviteRevoked', 'inviteInviterGone', 'invitePlaceGone'] as const) expect(Object.keys(AUTH_MESSAGES[k]).sort()).toEqual(['en', 'es', 'id', 'ja', 'ko', 'zh'])
})

test('Admin reads N of M guests; a plan lowered below the guests removes nobody and refuses new invites', async () => {
  const { owner, mia, room } = await setup('a-guests-states-cap')
  const p = await owner.call('POST', '/api/projects', { name: 'Quote', scope: 'team' })
  const a = await addGuest(h, mia.client, { username: 'gus', place: { kind: 'room', id: room } })
  const b = await addGuest(h, owner, { username: 'gia', place: { kind: 'project', id: p.id } })
  // no plan (self-hosted): no cap, the count still there for the owner and admins; a member does not learn it
  expect(await owner.call('GET', '/api/guest-invites/limit')).toMatchObject({ full: false, limit: null, used: 2 })
  expect((await mia.client.call('GET', '/api/guest-invites/limit')).used).toBeUndefined()
  // the plan lowered to one guest (TC-2256): both stay, a new invite is refused with the cap
  setPlanForTests(plan({ maxGuests: 1 }))
  expect(await owner.call('GET', '/api/guest-invites/limit')).toMatchObject({ full: true, limit: 1, used: 2 })
  const r = await mia.client.try('POST', '/api/guest-invites', { place: { kind: 'room', id: room } })
  expect(`${r.status} ${r.body.error.params.reason}`).toBe('409 guest_limit')
  // nothing switches anyone off: not an access change, not the start-up pass
  const { disablePlacelessGuests } = await import('../../server/src/admin/guests')
  disablePlacelessGuests(h.ctx, null)
  expect([status(a.id), status(b.id)]).toEqual(['active', 'active'])
  expect((await a.client.try('GET', `/api/rooms/${room}`)).status).toBe(200)
  // one removed: at the cap now, still full, and the removed one cannot come back over it
  await owner.call('PATCH', `/api/admin/users/${b.id}`, { status: 'disabled' })
  expect(await owner.call('GET', '/api/guest-invites/limit')).toMatchObject({ full: true, limit: 1, used: 1 })
  const on = await owner.try('PATCH', `/api/admin/users/${b.id}`, { status: 'active' })
  expect(`${on.status} ${on.body.error.params.reason}`).toBe('409 guest_limit')
})

test('a removed guest: switched on while their place is there; said plainly why not when it is not', async () => {
  const { owner, mia, nora, otto, room } = await setup('a-guests-states-switch-on')
  // a project guest removed by hand, still a person of the project: on again, and they sign in into it
  const p = await owner.call('POST', '/api/projects', { name: 'Quote', scope: 'team' })
  const g = await addGuest(h, owner, { username: 'gus', place: { kind: 'project', id: p.id } })
  await owner.call('PATCH', `/api/admin/users/${g.id}`, { status: 'disabled' })
  expect((await guestRow(owner, g.id)).guest?.placeOut).toBeUndefined()
  await owner.call('PATCH', `/api/admin/users/${g.id}`, { status: 'active' })
  expect(status(g.id)).toBe('active')
  const c = h.client({ ip: '10.0.0.7' })
  await c.login('gus', g.password)
  expect((await c.call('GET', '/api/projects')).items.map((x: { id: string }) => x.id)).toEqual([p.id])
  // a room guest taken out of the room: off, the row says so, and switching on says why in plain words (a removed
  // room guest is out of the room: an account switched off leaves its group chats)
  const gr = await addGuest(h, mia.client, { username: 'gwen', place: { kind: 'room', id: room } })
  await owner.call('DELETE', `/api/rooms/${room}/members/${gr.id}`)
  expect(status(gr.id)).toBe('disabled')
  expect((await guestRow(owner, gr.id)).guest?.placeOut).toBe('left')
  const r = await owner.try('PATCH', `/api/admin/users/${gr.id}`, { status: 'active' })
  expect(r.status).toBe(409)
  expect(r.body.error.params).toMatchObject({ reason: 'guest_no_place', placeOut: 'left' })
  expect(r.body.error.message).toBe(AUTH_MESSAGES.guestNoPlaceLeft.ko)
  // the room closed (everyone left): gone, with the owner's sentence
  const room2 = await groupChat(mia.client, [nora.id, otto.id], 'Closing')
  const g2 = await addGuest(h, mia.client, { username: 'gia', place: { kind: 'room', id: room2 } })
  await owner.call('PATCH', `/api/admin/users/${g2.id}`, { status: 'disabled' })
  await mia.client.call('POST', `/api/rooms/${room2}/leave`)
  await nora.client.call('POST', `/api/rooms/${room2}/leave`)
  await otto.client.call('POST', `/api/rooms/${room2}/leave`)
  expect((await guestRow(owner, g2.id)).guest?.placeOut).toBe('gone')
  const r2 = await owner.try('PATCH', `/api/admin/users/${g2.id}`, { status: 'active' })
  expect(r2.body.error.params).toMatchObject({ reason: 'guest_no_place', placeOut: 'gone' })
  expect(AUTH_MESSAGES.guestNoPlaceGone.en).toBe("Their room or project is gone, so there's nothing to bring them back to. Invite them again or make them a team member.")
  // the way out it offers works: made a team member (a member needs no place), on again
  expect(await owner.call('POST', `/api/admin/users/${g2.id}/convert-guest`)).toMatchObject({ role: 'member', status: 'active' })
})

test('a project back from the trash brings its guests back; not one an admin switched by hand; rename keeps them; deleted for good keeps them off', async () => {
  const { owner, mia } = await setup('a-guests-states-restore')
  const p = await owner.call('POST', '/api/projects', { name: 'Quote', scope: 'team' })
  const g = await addGuest(h, owner, { username: 'gus', place: { kind: 'project', id: p.id } })
  const g2 = await addGuest(h, owner, { username: 'gia', place: { kind: 'project', id: p.id } })
  // rename (TC-2296): the guest stays, and every place that names it reads the new name
  await owner.call('PATCH', `/api/projects/${p.id}`, { name: 'Quote 2026' })
  expect(status(g.id)).toBe('active')
  expect((await g.client.call('GET', '/api/me')).guest.place.name).toBe('Quote 2026')
  // to the trash: both off, the row says trashed
  await owner.call('DELETE', `/api/projects/${p.id}`)
  expect([status(g.id), status(g2.id)]).toEqual(['disabled', 'disabled'])
  expect((await guestRow(owner, g.id)).guest?.placeOut).toBe('trashed')
  const r = await owner.try('PATCH', `/api/admin/users/${g.id}`, { status: 'active' })
  expect(r.body.error.params).toMatchObject({ reason: 'guest_no_place', placeOut: 'trashed' })
  // an admin decides about gia by hand meanwhile (on is refused, so: a removal recorded by hand)
  h.ctx.db.query('UPDATE guests SET off_with_place = NULL WHERE user_id = ?').run(g2.id)
  // restored: gus is back and signs in into the project; gia, decided about by hand, stays off
  await owner.call('POST', `/api/projects/${p.id}/restore`)
  expect(status(g.id)).toBe('active')
  expect(status(g2.id)).toBe('disabled')
  const c = h.client({ ip: '10.0.0.6' })
  await c.login('gus', g.password)
  expect((await c.call('GET', '/api/projects')).items.map((x: { id: string }) => x.id)).toEqual([p.id])
  expect(h.ctx.db.query("SELECT 1 FROM audit_log WHERE action = 'user.update' AND target = ? AND detail LIKE '%guest_place_back%'").get(g.id)).not.toBeNull()

  // the trash, then a hand switch-off in between (removed for good by an admin): the restore does not bring them back
  const q = await owner.call('POST', '/api/projects', { name: 'Second', scope: 'team' })
  const g3 = await addGuest(h, owner, { username: 'gwen', place: { kind: 'project', id: q.id } })
  await owner.call('DELETE', `/api/projects/${q.id}`)
  await owner.call('PATCH', `/api/admin/users/${g3.id}`, { status: 'disabled' })
  await owner.call('POST', `/api/projects/${q.id}/restore`)
  expect(status(g3.id)).toBe('disabled')

  // deleted for good (TC-2295): off, and the row says the place is gone
  const d = await owner.call('POST', '/api/projects', { name: 'Gone', scope: 'team' })
  const g4 = await addGuest(h, owner, { username: 'gail', place: { kind: 'project', id: d.id } })
  await owner.call('DELETE', `/api/projects/${d.id}`)
  await owner.call('DELETE', `/api/projects/${d.id}`)
  expect(status(g4.id)).toBe('disabled')
  expect((await guestRow(owner, g4.id)).guest?.placeOut).toBe('gone')
  expect((await owner.try('POST', `/api/projects/${d.id}/restore`)).status).toBeGreaterThanOrEqual(400)
  expect(status(g4.id)).toBe('disabled')
  void mia
})

test('a refused send at the limit says when it resets: the same date as the budget', async () => {
  const { owner, room, t } = await setup('a-guests-states-limit')
  const team = addCred(t.cc, 'anthropic-api-key', key('limitteam'), { label: 'team' })
  const g = await addGuest(h, owner, { username: 'tia', place: { kind: 'room', id: room }, ai: { mode: 'team', credentialId: team, limitUsd: 1 } })
  h.ctx.db.query("INSERT INTO turns (id, chat_id, user_id, engine, status, started_at, cost_usd) VALUES ('g-use', 'c', ?, 'claude-code', 'done', ?, 2)").run(g.id, new Date().toISOString())
  const b = budgetBlock(h.ctx.db, g.id, 'en')!
  expect(b.resetsAt).toBe(periodEnd('month', new Date(), teamTimeZone(h.ctx.db)).toISOString())
  const r = await g.client.try('POST', '/api/chats', { message: 'hello' })
  expect(r.body.error.code).toBe('budget_exceeded')
  expect(r.body.error.params.resetsAt).toBe(b.resetsAt)
})

test('the team AI account a Team AI guest uses is deleted: a plain state for the guest and Admin, nothing breaks', async () => {
  const { owner, room, t } = await setup('a-guests-states-ai-gone')
  const team = addCred(t.cc, 'anthropic-api-key', key('goneteam'), { label: 'team' })
  const g = await addGuest(h, owner, { username: 'tia', place: { kind: 'room', id: room }, ai: { mode: 'team', credentialId: team, limitUsd: 5 } })
  expect((await g.client.call('GET', '/api/me')).guest.teamAiGone).toBeUndefined()
  await owner.call('DELETE', `/api/admin/credentials/${team}`)
  const me = await g.client.call('GET', '/api/me')
  expect(me.guest).toMatchObject({ ai: { mode: 'none' }, teamAiGone: true })
  // ai-access answers (no AI here), the guest keeps the room, and a send is refused plainly, not a crash
  const access = await g.client.call('GET', '/api/me/ai-access')
  expect(access.usable).toBe(false)
  expect((await g.client.call('GET', `/api/rooms/${room}`)).id).toBe(room)
  const row = await guestRow(owner, g.id)
  expect(row.guest).toMatchObject({ ai: { mode: 'none' }, teamAiGone: true })
  expect(row.status).toBe('active')
  // Change AI puts it right, and the mark goes
  const team2 = addCred(t.cc, 'anthropic-api-key', key('newteam'), { label: 'team 2' })
  await owner.call('PATCH', `/api/admin/users/${g.id}/guest-ai`, { mode: 'team', credentialId: team2, limitUsd: 5 })
  expect((await guestRow(owner, g.id)).guest?.teamAiGone).toBeUndefined()
})
