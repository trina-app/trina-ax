// A Google Drive an admin shares with the team (integrations/google-drive/shares.ts, share-admin.ts, read.ts
// FolderScope, tools/drive.ts sources). Security: only admins create, change or stop a share; a member outside its rule
// gets nothing; nothing outside the shared folders comes back (search filtered, list and read refused, also through a
// shortcut or a file in two folders); tokens never leave the server; stopping revokes; a gone admin stops the share and
// the admins are told; the rule is checked again on every call; the members' switch governs only their own Drive.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { makeCApp, jsonBody, type CApp } from '../lib/c-app'
import { googleDriveOf, type GoogleDrive } from '../../server/src/integrations/google-drive/oauth'
import { listShares, setMembersCanConnect, stopShare, updateShare } from '../../server/src/integrations/google-drive/share-admin'
import { shareRow } from '../../server/src/integrations/google-drive/shares'
import { checkDriveShareOwners } from '../../server/src/integrations/google-drive/shares'
import { registerDriveTools } from '../../server/src/tools/drive'
import { toolRegistry } from '../../server/src/tools/registry'
import { readScope, widening } from '../../server/src/chat/read-scope'
import { FakeGoogleDrive, DRIVE_CONFIG, membersMayConnect } from '../lib/fake-google-drive'

const FOLDER = 'application/vnd.google-apps.folder', SHORTCUT = 'application/vnd.google-apps.shortcut'
type Node = { name: string; mime: string; parents: string[]; driveId?: string; text?: string; target?: string }
/** carol's Drive: Finance (shared) with Q3 under it; HR and Legal (not shared); a shared drive Team Drive. */
const TREE: Record<string, Node> = {
  'F-shared': { name: 'Finance', mime: FOLDER, parents: ['root'] },
  'in-1': { name: 'budget.txt', mime: 'text/plain', parents: ['F-shared'], text: 'IN-FOLDER budget' },
  'F-sub': { name: 'Q3', mime: FOLDER, parents: ['F-shared'] },
  'in-deep': { name: 'deep.txt', mime: 'text/plain', parents: ['F-sub'], text: 'IN-SUBFOLDER deep' },
  'sc-out': { name: 'link to salaries', mime: SHORTCUT, parents: ['F-shared'], target: 'out-1' },
  'F-other': { name: 'HR', mime: FOLDER, parents: ['root'] },
  'F-other2': { name: 'Legal', mime: FOLDER, parents: ['root'] },
  'out-1': { name: 'salaries.txt', mime: 'text/plain', parents: ['F-other'], text: 'CANARY-OUTSIDE salaries' },
  'two-out': { name: 'two-outside.txt', mime: 'text/plain', parents: ['F-other', 'F-other2'], text: 'CANARY-TWO-OUTSIDE' },
  'two-in': { name: 'two-inside.txt', mime: 'text/plain', parents: ['F-other', 'F-sub'], text: 'IN-TWO-PARENTS' },
  'sc-in': { name: 'link to budget', mime: SHORTCUT, parents: ['F-other'], target: 'in-1' },
  'd-1': { name: 'drive.txt', mime: 'text/plain', parents: ['D-team'], driveId: 'D-team', text: 'IN-SHARED-DRIVE' },
}
const DRIVES = [{ id: 'D-team', name: 'Team Drive' }]

function tree(fake: FakeGoogleDrive) {
  fake.response = (url) => {
    const p = url.pathname.replace(/^\/drive\/v3\//, '')
    if (p === 'drives') { const n = url.searchParams.get('q')?.match(/name contains '([^']*)'/)?.[1]; return Response.json({ drives: DRIVES.filter((d) => !n || d.name.includes(n)) }) }
    if (p.startsWith('drives/')) { const d = DRIVES.find((x) => x.id === p.slice(7)); return d ? Response.json(d) : Response.json({ error: 'nope' }, { status: 404 }) }
    const meta = (id: string, n: Node) => ({ id, name: n.name, mimeType: n.mime, parents: n.parents, ...(n.driveId ? { driveId: n.driveId } : {}), size: String((n.text ?? '').length), capabilities: { canDownload: true }, ...(n.target ? { shortcutDetails: { targetId: n.target } } : {}) })
    if (p === 'files') {
      const q = url.searchParams.get('q') ?? ''
      let items = Object.entries(TREE)
      const parent = q.match(/'([A-Za-z0-9_-]+)' in parents/)?.[1]
      if (parent) items = items.filter(([, n]) => n.parents.includes(parent))
      if (q.includes(`mimeType='${FOLDER}'`)) items = items.filter(([, n]) => n.mime === FOLDER)
      const text = q.match(/fullText contains '([^']*)'/)?.[1]
      if (text) items = items.filter(([, n]) => n.name.includes(text) || (n.text ?? '').includes(text))
      const name = q.match(/name contains '([^']*)'/)?.[1]
      if (name) items = items.filter(([, n]) => n.name.includes(name))
      const driveId = url.searchParams.get('driveId')
      if (driveId) items = items.filter(([, n]) => n.driveId === driveId)
      return Response.json({ files: items.map(([id, n]) => meta(id, n)) })
    }
    if (p.startsWith('files/')) {
      const id = p.split('/')[1]!, n = TREE[id]
      if (id === 'D-team') return Response.json({ id, name: 'Drive', mimeType: FOLDER, driveId: 'D-team' })
      if (!n) return Response.json({ error: 'hidden' }, { status: 404 })
      if (url.searchParams.get('alt') === 'media') return new Response(n.text ?? '')
      return Response.json(meta(id, n))
    }
    return null
  }
}

let a: CApp, fake: FakeGoogleDrive, svc: GoogleDrive, i = 0, shareId = ''
const session = (user: string, id: string) => {
  const now = new Date().toISOString(), later = new Date(Date.now() + 3600_000).toISOString()
  a.ctx.db.query("INSERT INTO sessions(id,user_id,token_hash,client,created_at,last_seen_at,expires_at) VALUES(?,?,?,'web',?,?,?)").run(id, user, id + '-hash', now, now, later)
}
/** carol (an admin) signs in with Google and confirms: a new share, no folders and nobody yet */
async function share(name = 'Company Drive', who = 'carol') {
  const f = svc.authorize(who, `${who}-session`, {})
  expect(await svc.callback(fake.authorize(f.authorizationUrl, who), { userId: who, sessionId: `${who}-session` })).toBe(true)
  return svc.completeShare(who, `${who}-session`, f.flowId, name).id
}
function call(name: string, input: unknown, user: 'alice' | 'bob' | 'erin' | 'carol' = 'alice') {
  const chat = a.chat(user), turn = a.turn(user, chat)
  return { chat, result: toolRegistry(a.ctx.files).call(name, input, a.toolCtx(user, turn)) }
}
const text = async (name: string, input: unknown, user: 'alice' | 'bob' | 'erin' | 'carol' = 'alice') => (await call(name, input, user).result)

beforeEach(async () => {
  a = await makeCApp('drive-shares-' + ++i); fake = new FakeGoogleDrive(); tree(fake)
  svc = googleDriveOf(a.ctx, { config: DRIVE_CONFIG, fetch: fake.fetch })
  for (const u of ['carol', 'dana', 'alice', 'bob']) session(u, `${u}-session`)
  registerDriveTools(a.ctx, toolRegistry(a.ctx.files))
  shareId = await share()
  // Finance (and below) for the marketing group (alice, erin); not bob
  await updateShare(a.ctx, 'carol', shareId, { folders: ['F-shared'], access: { everyone: false, groups: ['marketing'], users: [] } })
})
afterEach(async () => { await a?.close() })

test('only admins create, change or stop a share; a member gets 403 and nothing changes', async () => {
  expect(() => svc.authorize('alice', 'alice-session', {})).toThrow('drive_access_denied')
  // a personal flow cannot be completed as a share, nor a share flow as one's own Drive
  membersMayConnect(a.ctx.db)
  const own = svc.authorize('alice', 'alice-session')
  await svc.callback(fake.authorize(own.authorizationUrl, 'alice'), { userId: 'alice', sessionId: 'alice-session' })
  expect(() => svc.completeShare('alice', 'alice-session', own.flowId, 'Mine now')).toThrow()
  const f = svc.authorize('carol', 'carol-session', {})
  await svc.callback(fake.authorize(f.authorizationUrl, 'carol'), { userId: 'carol', sessionId: 'carol-session' })
  expect(() => svc.complete('carol', 'carol-session', f.flowId)).toThrow('drive_not_found')
  for (const [method, path, body] of [
    ['POST', '/api/admin/google-drive/shares/authorize', {}], ['GET', '/api/admin/google-drive/shares', null],
    ['PATCH', `/api/admin/google-drive/shares/${shareId}`, { access: { everyone: true, groups: [], users: [] } }],
    ['DELETE', `/api/admin/google-drive/shares/${shareId}`, null], ['GET', `/api/admin/google-drive/shares/${shareId}/folders`, null],
    ['POST', '/api/admin/google-drive/shares/flows/00000000-0000-7000-8000-000000000000/complete', {}], ['PUT', '/api/admin/google-drive/members', { on: false }],
  ] as const) {
    const r = await a.json(path, { ...(body ? jsonBody(body, method) : { method }), as: 'alice' })
    expect(r.status).toBe(403)
  }
  await expect(updateShare(a.ctx, 'alice', shareId, { wholeDrive: true })).rejects.toThrow('drive_access_denied')
  await expect(stopShare(a.ctx, 'bob', shareId)).rejects.toThrow('drive_access_denied')
  expect(() => setMembersCanConnect(a.ctx, 'alice', true)).toThrow('drive_access_denied')
  expect(shareRow(a.ctx.db, shareId)).toMatchObject({ whole_drive: 0 })
  // an admin can
  const r = await a.json(`/api/admin/google-drive/shares/${shareId}`, { ...jsonBody({ name: 'Finance Drive' }, 'PATCH'), as: 'carol' })
  expect(r.status).toBe(200); expect(r.body.name).toBe('Finance Drive')
})

test('a member outside the rule gets nothing: no source, no shares listed, refused by name', async () => {
  const bob = await text('drive_list', {}, 'bob')
  expect(bob.isError).toBe(true); expect(bob.text).not.toContain('Finance'); expect(bob.text).not.toContain('budget')
  const byName = await text('drive_search', { query: 'budget', source: 'team:Company Drive' }, 'bob')
  expect(byName.isError).toBe(true); expect(byName.text).not.toContain('IN-FOLDER')
  expect(svc.status('bob').teamShares).toEqual([])
  expect(svc.status('alice').teamShares).toEqual([{ id: shareId, name: 'Company Drive', folders: [{ id: 'F-shared', name: 'Finance', kind: 'folder' }], wholeDrive: false }])
  // and an admin is not in the rule just for being one
  expect((await text('drive_list', {}, 'carol')).isError).toBe(true)
})

test('only files inside the shared folders: search filtered, list and read refused outside, also via a shortcut or two parents', async () => {
  // the top of a team Drive is its shared folders
  const top = await text('drive_list', {})
  expect(top.isError).not.toBe(true)
  expect((top.structured as any).source).toBe('team:Company Drive')
  expect((top.structured as any).files.map((f: any) => f.id)).toEqual(['F-shared'])
  // a folder inside, and one below it
  expect((await text('drive_list', { folderId: 'F-shared' })).structured).toMatchObject({ files: expect.arrayContaining([expect.objectContaining({ id: 'in-1' }), expect.objectContaining({ id: 'F-sub' })]) })
  expect(((await text('drive_list', { folderId: 'F-sub' })).structured as any).files.map((f: any) => f.id).sort()).toEqual(['in-deep', 'two-in'])
  // a folder outside, the account's root, a shared drive that is not shared
  for (const input of [{ folderId: 'F-other' }, { folderId: 'F-other2' }, { folderId: 'D-team', driveId: 'D-team' }]) {
    const r = await text('drive_list', input)
    expect(r.isError).toBe(true); expect(r.text).not.toContain('salaries')
  }
  // search: everything matching in the account, only the inside ones come back
  const found = await text('drive_search', { query: 'txt' })
  const ids = ((found.structured as any).files as { id: string }[]).map((f) => f.id).sort()
  expect(ids).toEqual(['in-1', 'in-deep', 'two-in'])
  expect(found.text).not.toContain('salaries'); expect(found.text).not.toContain('two-outside'); expect(found.text).not.toContain('drive.txt')
  // reads
  expect((await text('drive_read', { fileId: 'in-1' })).text).toContain('IN-FOLDER budget')
  expect((await text('drive_read', { fileId: 'in-deep' })).text).toContain('IN-SUBFOLDER deep')
  expect((await text('drive_read', { fileId: 'two-in' })).text).toContain('IN-TWO-PARENTS') // one of its two folders is inside
  expect((await text('drive_read', { fileId: 'sc-in' })).text).toContain('IN-FOLDER budget') // a shortcut outside to a file inside
  for (const fileId of ['out-1', 'two-out', 'sc-out', 'd-1', 'missing']) {
    const r = await text('drive_read', { fileId })
    expect(r.isError).toBe(true)
    expect(r.text).not.toMatch(/CANARY|salaries|IN-SHARED-DRIVE/)
    // outside answers like a file that is not there
    expect(r.text).toBe((await text('drive_read', { fileId: 'missing' })).text)
  }
  // what a team share returned is readable by its rule's people, so saving it where more can see asks first
  const c = call('drive_read', { fileId: 'in-1' }); await c.result
  expect(readScope(a.ctx.db, c.chat)).toEqual([{ type: 'drive_share', id: shareId }])
  expect(widening(a.ctx.db, c.chat, ['shared'])?.narrower).toEqual([{ type: 'drive_share', id: shareId }])
  // a shared drive added to the share: its files come in
  await updateShare(a.ctx, 'carol', shareId, { folders: ['F-shared', 'D-team'] })
  expect((await text('drive_read', { fileId: 'd-1' })).text).toContain('IN-SHARED-DRIVE')
  expect((await text('drive_read', { fileId: 'out-1' })).isError).toBe(true)
})

test('folders come from Google: an id that is not a folder of this account is refused, names are Google’s', async () => {
  await expect(updateShare(a.ctx, 'carol', shareId, { folders: ['in-1'] })).rejects.toThrow('drive_folder_invalid')
  await expect(updateShare(a.ctx, 'carol', shareId, { folders: ['nope'] })).rejects.toThrow('drive_folder_invalid')
  const s = await updateShare(a.ctx, 'carol', shareId, { folders: ['F-sub', 'D-team'] })
  expect(s.folders).toEqual([{ id: 'F-sub', name: 'Q3', kind: 'folder' }, { id: 'D-team', name: 'Team Drive', kind: 'drive' }])
  const picker = await a.json(`/api/admin/google-drive/shares/${shareId}/folders`, { as: 'carol' })
  expect(picker.body.items).toEqual([{ id: 'D-team', name: 'Team Drive', kind: 'drive' }, { id: 'F-shared', name: 'Finance', kind: 'folder' }, { id: 'F-other', name: 'HR', kind: 'folder' }, { id: 'F-other2', name: 'Legal', kind: 'folder' }])
  expect((await a.json(`/api/admin/google-drive/shares/${shareId}/folders?q=Q3`, { as: 'carol' })).body.items).toEqual([{ id: 'F-sub', name: 'Q3', kind: 'folder' }])
})

test('tokens never leave the server: not in any response, the audit log or a member’s view', async () => {
  const dump = JSON.stringify([
    (await a.json('/api/admin/google-drive/shares', { as: 'carol' })).body,
    (await a.json('/api/admin/google-drive', { as: 'carol' })).body,
    (await a.json('/api/integrations/google-drive', { as: 'alice' })).body,
    await text('drive_read', { fileId: 'in-1' }),
    a.ctx.db.query('SELECT * FROM audit_log').all(),
  ])
  expect(dump).not.toContain('CANARY-access'); expect(dump).not.toContain('CANARY-refresh'); expect(dump).not.toContain('CANARY-client-secret')
  const row = shareRow(a.ctx.db, shareId)!
  expect(dump).not.toContain(row.secret_enc!)
  // the member sees the share's name and folders, not whose account it is
  expect(JSON.stringify((await a.json('/api/integrations/google-drive', { as: 'alice' })).body)).not.toContain('carol@example.test')
  // the stored secret is sealed, not the tokens themselves
  expect(row.secret_enc).not.toContain('CANARY')
})

test('the rule is checked again on every call; changes are audited without file names or contents', async () => {
  expect((await text('drive_read', { fileId: 'in-1' })).isError).not.toBe(true)
  await updateShare(a.ctx, 'carol', shareId, { access: { everyone: false, groups: [], users: ['bob'] } })
  expect((await text('drive_read', { fileId: 'in-1' })).isError).toBe(true)
  expect((await text('drive_read', { fileId: 'in-1' }, 'bob')).text).toContain('IN-FOLDER budget')
  await updateShare(a.ctx, 'carol', shareId, { wholeDrive: true })
  expect((await text('drive_read', { fileId: 'out-1' }, 'bob')).text).toContain('CANARY-OUTSIDE') // the whole Drive, chosen with a warning
  const log = a.ctx.db.query("SELECT action, target, detail FROM audit_log WHERE action LIKE 'drive.share%' ORDER BY id").all() as { action: string; target: string; detail: string | null }[]
  expect(log.map((x) => x.action)).toEqual(['drive.share_created', 'drive.share_folders_changed', 'drive.share_audience_changed', 'drive.share_audience_changed', 'drive.share_folders_changed'])
  expect(log.every((x) => x.target === shareId)).toBe(true)
  expect(JSON.stringify(log)).not.toMatch(/budget|Finance|IN-FOLDER|carol@/)
})

const signIn = (id: string) => (a.ctx.db.query("SELECT user_id FROM team_sign_ins WHERE kind = 'drive_share' AND target_id = ?").get(id) as { user_id: string } | null)?.user_id

test('stop sharing deletes the tokens at once and revokes them at Google', async () => {
  // completeShare recorded whose Google sign-in it is (팀장 넘기기 reads only that); stopping it clears it
  expect(signIn(shareId)).toBe('carol')
  const r = await a.json(`/api/admin/google-drive/shares/${shareId}`, { method: 'DELETE', as: 'carol' })
  expect(r.status).toBe(200); expect(r.body).toEqual({ stopped: true, revocation: 'revoked' })
  expect(fake.revoked).toBe(true)
  expect(shareRow(a.ctx.db, shareId)).toBeNull()
  expect(signIn(shareId)).toBeUndefined()
  expect(a.ctx.db.query('SELECT count(*) n FROM drive_team_share_access WHERE share_id=?').get(shareId)).toEqual({ n: 0 })
  expect((await text('drive_read', { fileId: 'in-1' })).isError).toBe(true)
  expect(svc.status('alice').teamShares).toEqual([])
  expect(a.ctx.db.query("SELECT count(*) n FROM audit_log WHERE action='drive.share_stopped'").get()).toEqual({ n: 1 })
})

test('when its admin is disabled the share stops, its tokens go, and the admins get an Inbox notice', async () => {
  a.ctx.db.query("UPDATE users SET status='disabled' WHERE id='carol'").run()
  checkDriveShareOwners(a.ctx)
  const row = shareRow(a.ctx.db, shareId)!
  expect(row).toMatchObject({ status: 'needs_reconnect', reason: 'owner_gone', secret_enc: null })
  // the gone admin's sign-in is no one's live sign-in any more
  expect(signIn(shareId)).toBeUndefined()
  await new Promise((r) => setTimeout(r, 5))
  expect(fake.revoked).toBe(true)
  expect((await text('drive_read', { fileId: 'in-1' })).isError).toBe(true)
  const notices = a.ctx.db.query("SELECT user_id FROM drive_share_notices WHERE event_type='drive.share_reconnect'").all() as { user_id: string }[]
  expect(notices.map((n) => n.user_id)).toEqual(['dana'])
  expect(listShares(a.ctx, 'dana')[0]).toMatchObject({ status: 'needs_reconnect', reason: 'owner_gone', folders: [{ id: 'F-shared' }] })
  // another admin signs in again: folders and rule stay, it works again
  const f = svc.authorize('dana', 'dana-session', { shareId })
  await svc.callback(fake.authorize(f.authorizationUrl, 'dana'), { userId: 'dana', sessionId: 'dana-session' })
  svc.completeShare('dana', 'dana-session', f.flowId)
  expect(signIn(shareId)).toBe('dana')
  expect(listShares(a.ctx, 'dana')[0]).toMatchObject({ status: 'connected', reason: null, owner: { id: 'dana' }, folders: [{ id: 'F-shared' }] })
  expect((await text('drive_read', { fileId: 'in-1' })).text).toContain('IN-FOLDER budget')
})

// docs/DECISIONS.md "W6" (onboarding v6's 도구 연결, re-check N1): an owner or admin may start their own sign-in while
// the switch is off; the switch turns on only with the confirmed account, and only when the confirm asks for it
test('the members’ switch off: an owner or admin may still sign in to their own Drive; the confirm with membersOn turns it on; a cancel or a confirm without it changes nothing; members are refused', async () => {
  // a team made before migration 339 (or one whose admin turned it off)
  setMembersCanConnect(a.ctx, 'carol', false)
  expect(() => svc.authorize('alice', 'alice-session')).toThrow('drive_members_off')
  // the owner starts; cancelling changes nothing
  const first = svc.authorize('dana', 'dana-session')
  svc.cancel('dana', 'dana-session', first.flowId)
  expect(svc.status('alice').personalAllowed).toBe(false)
  // signed in, but confirmed without asking to turn the switch on: refused, nothing changes
  const f = svc.authorize('dana', 'dana-session')
  await svc.callback(fake.authorize(f.authorizationUrl, 'dana'), { userId: 'dana', sessionId: 'dana-session' })
  expect(() => svc.complete('dana', 'dana-session', f.flowId)).toThrow('drive_members_off')
  expect(svc.status('dana').status).toBe('disconnected')
  expect(svc.status('alice').personalAllowed).toBe(false)
  // the confirm that names it: connected, and the switch is on for everyone, in one step, audited
  expect(svc.complete('dana', 'dana-session', f.flowId, { membersOn: true })).toMatchObject({ status: 'connected', personalAllowed: true })
  expect(svc.status('alice').personalAllowed).toBe(true)
  expect(a.ctx.db.query("SELECT actor_id AS actor, detail FROM audit_log WHERE action = 'drive.members_switch' ORDER BY id DESC LIMIT 1").get()).toMatchObject({ actor: 'dana' })
  // an admin may too; a member who asks for it while it is off is still refused
  setMembersCanConnect(a.ctx, 'carol', false)
  const c = svc.authorize('carol', 'carol-session')
  await svc.callback(fake.authorize(c.authorizationUrl, 'carol'), { userId: 'carol', sessionId: 'carol-session' })
  expect(svc.complete('carol', 'carol-session', c.flowId, { membersOn: true }).status).toBe('connected')
  setMembersCanConnect(a.ctx, 'carol', false)
  expect(() => svc.authorize('alice', 'alice-session')).toThrow('drive_members_off')
  setMembersCanConnect(a.ctx, 'carol', false)
})

test('the members’ switch: off for a team made before migration 339; their own Drive only while it is on; the team share works either way', async () => {
  setMembersCanConnect(a.ctx, 'carol', false)
  expect(svc.status('alice').personalAllowed).toBe(false)
  expect(() => svc.authorize('alice', 'alice-session')).toThrow('drive_members_off')
  setMembersCanConnect(a.ctx, 'carol', true)
  const f = svc.authorize('alice', 'alice-session')
  await svc.callback(fake.authorize(f.authorizationUrl, 'alice'), { userId: 'alice', sessionId: 'alice-session' })
  svc.complete('alice', 'alice-session', f.flowId)
  // both: their own by default, the team's by name, each result says its source and the other (this fake answers
  // every account from the same tree)
  const mine = await text('drive_read', { fileId: 'out-1' })
  expect(mine.structured).toMatchObject({ source: 'mine', otherSources: ['team:Company Drive'] })
  expect((await text('drive_read', { fileId: 'in-1', source: 'team:Company Drive' })).structured).toMatchObject({ source: 'team:Company Drive', otherSources: ['mine'] })
  expect((await text('drive_read', { fileId: 'x', source: 'team:Nope' })).text).toContain('"team:Company Drive"')
  setMembersCanConnect(a.ctx, 'carol', false)
  expect((await text('drive_read', { fileId: 'out-1', source: 'mine' })).isError).toBe(true)
  expect((await text('drive_read', { fileId: 'in-1' })).structured).toMatchObject({ source: 'team:Company Drive' })
})
