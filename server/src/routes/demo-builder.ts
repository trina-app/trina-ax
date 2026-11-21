// The free-roam demo's snapshot builder routes (shared/src/api/demo.ts DEMO_BUILDER; scripts/demo/free-roam/
// build-snapshot.ts). A snapshot is the END of the scripted story (scripts/demo/mina/): rooms with yesterday's messages,
// chats that were answered before the visitor came, a Gmail that is connected. The seed makes all of it through the
// public API; these four routes do the rest, which no person can do in the product: set when a room message was sent,
// who invited a person, a connection row with a made-up secret, the finished turns of a chat with no AI.
//
// They exist only while the demo file says `builder: true` (a demo file is itself refused outside a development server,
// app-config.ts readDemoFile), only for the owner (the builder signs in with the owner's random password), and answer
// 404 otherwise, like routes that are not there. The snapshot's own demo file never says `builder`, so no visitor's
// instance has them. Nothing here opens a socket: the secrets are made up and the demo's fakes answer them.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { API, type DemoBuilderChatTurns } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { newId } from '../db'
import { fail } from '../http/errors'
import type { RouteKit } from '../http/route'
import { integrationsOf } from '../integrations/connections/service'
import { connectionAad, setAccess } from '../integrations/connections/store'
import { APP_NAMES, APP_SLUGS, placeholderUrl } from '../integrations/google-apps/catalog'
import { DEMO_GOOGLE_KEY } from '../integrations/google-apps/service'
import { GOOGLE_AUTH, GOOGLE_TOKEN } from '../integrations/google-drive/client'
import { DRIVE_SCOPE } from '../integrations/google-drive/config'
import { googleDriveOf } from '../integrations/google-drive/oauth'
import { hiddenAnswersCutover, setHiddenAnswersCutover } from '../chat/shared-answers'
import { higgsfieldSavedTools } from '../demo/fakes/higgsfield'
import { demoOf } from './demo'
import { PROFILE_PATH } from '../onboarding/profile'

/** the made-up secrets start with this, so a scan of a snapshot can tell them from a real one */
export const FAKE_SECRET_PREFIX = 'demo-fake-'
const fakeSecret = () => FAKE_SECRET_PREFIX + crypto.randomBytes(18).toString('base64url')
/** the far future: a made-up token never expires (the fakes never refresh it) */
const NEVER = Date.parse('2099-01-01T00:00:00Z')
const HIGGSFIELD_URL = 'https://mcp.higgsfield.ai/mcp'

function builderOn(ctx: AppContext): boolean {
  return demoOf(ctx)?.builder === true
}

const userExists = (ctx: AppContext, id: string) => !!ctx.db.query("SELECT 1 FROM users WHERE id = ? AND status = 'active' AND deleted_at IS NULL").get(id)

export function registerDemoBuilder(kit: RouteKit, ctx: AppContext) {
  kit.handle(API.demoBuilderRoomTimes, ({ body }) => {
    if (!builderOn(ctx)) return fail('not_found')
    const db = ctx.db
    if (!db.query('SELECT 1 FROM rooms WHERE id = ?').get(body.roomId)) fail('not_found')
    let updated = 0, dropped = 0
    db.transaction(() => {
      if (body.dropJoinLines) {
        dropped = db.query("DELETE FROM room_messages WHERE room_id = ? AND event IS NOT NULL AND json_extract(event, '$.type') = 'joined'").run(body.roomId).changes
      }
      const set = db.query('UPDATE room_messages SET created_at = ? WHERE id = ? AND room_id = ?')
      for (const t of body.times) updated += set.run(new Date(t.at).toISOString(), t.messageId, body.roomId).changes
      // the notices those messages made are as old as them (Activity sorts and keeps them by these times: a notice
      // left at the build's time sits on top, one older than 30 days drops out): a notice its message's time, the run it
      // held back (last_seq) that message's time; a thread's follow the time of its first reply (else of its root)
      db.query(`UPDATE room_notices SET created_at = m.created_at FROM room_messages m WHERE m.id = room_notices.source_id AND room_notices.room_id = ?`).run(body.roomId)
      db.query(`UPDATE room_notices SET last_at = m.created_at FROM room_messages m WHERE m.room_id = room_notices.room_id AND m.seq = room_notices.last_seq
        AND room_notices.room_id = ? AND room_notices.last_seq IS NOT NULL`).run(body.roomId)
      db.query(`UPDATE room_thread_follows SET created_at = COALESCE((SELECT MIN(r.created_at) FROM room_messages r WHERE r.thread_root_id = room_thread_follows.root_id),
        (SELECT m.created_at FROM room_messages m WHERE m.id = room_thread_follows.root_id), created_at) WHERE room_id = ?`).run(body.roomId)
      // the room's place in the lists follows its latest message
      const last = db.query('SELECT MAX(created_at) at FROM room_messages WHERE room_id = ?').get(body.roomId) as { at: string | null }
      if (last.at) db.query('UPDATE rooms SET activity_at = ? WHERE id = ?').run(last.at, body.roomId)
    })()
    return { updated, dropped }
  })

  kit.handle(API.demoBuilderWelcome, ({ body }) => {
    if (!builderOn(ctx)) return fail('not_found')
    if (!userExists(ctx, body.userId) || !userExists(ctx, body.inviterId)) fail('not_found')
    // the seed adds people directly ("Add directly" keeps no inviter); the story has them invited by someone
    const n = ctx.db.query("UPDATE member_welcome SET invited_by = ?, via = 'invite' WHERE user_id = ?").run(body.inviterId, body.userId).changes
    if (!n) ctx.db.query("INSERT INTO member_welcome (user_id, invited_by, via, joined_at, announced_at) VALUES (?, ?, 'invite', ?, ?)").run(body.userId, body.inviterId, new Date().toISOString(), new Date().toISOString())
    return { ok: true as const }
  })

  kit.handle(API.demoBuilderConnection, ({ body, auth }) => {
    if (!builderOn(ctx)) return fail('not_found')
    const now = new Date().toISOString()
    const account = JSON.stringify({ name: body.account.name, email: body.account.email })
    const db = ctx.db
    if (body.service === 'gmail') {
      const user = body.userId
      if (!user || !userExists(ctx, user)) return fail('not_found')
      const id = newId()
      const secret = {
        type: 'oauth', resource: null, scope: 'https://www.googleapis.com/auth/gmail.modify',
        server: { issuer: null, authorizationEndpoint: GOOGLE_AUTH, tokenEndpoint: GOOGLE_TOKEN, registrationEndpoint: null, revocationEndpoint: null },
        client: { clientId: 'demo-fake-client', clientSecret: null, authMethod: 'none', redirectUri: '' },
        tokens: { accessToken: fakeSecret(), refreshToken: fakeSecret(), expiresAt: NEVER },
        google: { app: 'gmail', key: DEMO_GOOGLE_KEY, mode: 'direct' },
      }
      const sealed = integrationsOf(ctx).box.seal(connectionAad({ id, scope: 'personal', owner_user_id: user }), secret)
      db.query(`INSERT INTO integrations (id, scope, owner_user_id, created_by, kind, name, slug, url, auth, auth_header, secret_enc, key_version, account, notes,
        write_policy, status, last_error, tools_json, tools_updated_at, last_used_at, version, created_at, updated_at, google_app)
        VALUES (?, 'personal', ?, ?, 'mcp', ?, ?, ?, 'oauth', NULL, ?, ?, ?, NULL, 'ask', 'connected', NULL, '[]', NULL, NULL, 1, ?, ?, 'gmail')`)
        .run(id, user, user, APP_NAMES.gmail, APP_SLUGS.gmail, placeholderUrl('gmail'), sealed.enc, sealed.keyVersion, account, now, now)
      integrationsOf(ctx).forget(id)
      return { id }
    }
    if (body.service === 'google-drive') {
      const user = body.userId
      if (!user || !userExists(ctx, user)) return fail('not_found')
      const drive = googleDriveOf(ctx)
      const id = newId()
      const sealed = drive.store.seal(user, id, { accessToken: fakeSecret(), refreshToken: fakeSecret(), expiresAt: NEVER })
      db.transaction(() => {
        db.query('DELETE FROM drive_connections WHERE user_id = ?').run(user)
        db.query(`INSERT INTO drive_connections(id,user_id,config_key,account,scopes,secret_enc,key_version,status,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'connected',?,?,?)`)
          .run(id, user, drive.key, JSON.stringify({ subject: `demo-${user}`, ...body.account }), JSON.stringify([DRIVE_SCOPE]), sealed.enc, sealed.keyVersion, new Date(NEVER).toISOString(), now, now)
      })()
      return { id }
    }
    // higgsfield: the team's, for everyone (the story's banner was shot with it). No secret at all (auth none): the
    // demo's fake answers its address (server/src/demo/fakes/higgsfield.ts), and there is no sign-in to make up. Its
    // saved tools are the fake's list, as a check of the connection would have saved them: a connection's turn tools
    // come from that list, and with '[]' the AI had no image tool (QA TC-5559)
    const id = newId()
    db.transaction(() => {
      db.query(`INSERT INTO integrations (id, scope, owner_user_id, created_by, kind, name, slug, url, auth, auth_header, secret_enc, key_version, account, notes,
        write_policy, status, last_error, tools_json, tools_updated_at, last_used_at, version, created_at, updated_at)
        VALUES (?, 'team', NULL, ?, 'mcp', 'Higgsfield', 'higgsfield', ?, 'none', NULL, NULL, 1, ?, NULL, 'allow', 'connected', NULL, ?, ?, NULL, 1, ?, ?)`)
        .run(id, auth.user.id, HIGGSFIELD_URL, account, JSON.stringify(higgsfieldSavedTools()), now, now, now)
      setAccess(db, id, { everyone: true, groups: [], users: [] })
    })()
    integrationsOf(ctx).forget(id)
    return { id }
  })

  kit.handle(API.demoBuilderChatTurns, ({ body }): DemoBuilderChatTurns => {
    if (!builderOn(ctx)) return fail('not_found')
    const db = ctx.db
    const chat = db.query('SELECT id, user_id, engine, model FROM chats WHERE id = ? AND deleted_at IS NULL').get(body.chatId) as { id: string; user_id: string; engine: string; model: string | null } | null
    if (!chat) return fail('not_found')
    const out: DemoBuilderChatTurns['turns'] = []
    db.transaction(() => {
      // after the chat's last message (a second call goes on from there)
      let parent = (db.query('SELECT id FROM messages WHERE chat_id = ? ORDER BY created_at DESC, id DESC LIMIT 1').get(chat.id) as { id: string } | null)?.id ?? null
      const msg = db.query(`INSERT INTO messages (id, chat_id, parent_id, role, author_id, content, attachments, steps, status, turn_id, engine, model, client_message_id, created_at, updated_at, auto_sent)
        VALUES (?,?,?,?,?,?,'[]','[]','done',?,?,?,NULL,?,?,0)`)
      const turn = db.query(`INSERT INTO turns (id, chat_id, user_id, engine, model, status, started_at, ended_at, message_id, user_message_id, shared_checked, people_checked)
        VALUES (?,?,?,?,?,'done',?,?,?,?,1,1)`)
      let first: string | null = null, last = ''
      for (const t of body.turns) {
        const at = new Date(t.at).toISOString()
        const answeredAt = new Date(Date.parse(at) + 20_000).toISOString()
        const askId = newId(), answerId = newId(), turnId = newId()
        msg.run(askId, chat.id, parent, 'user', chat.user_id, t.ask, null, null, null, at, at)
        turn.run(turnId, chat.id, chat.user_id, chat.engine, chat.model, at, answeredAt, answerId, askId)
        msg.run(answerId, chat.id, askId, 'assistant', null, t.answer, turnId, chat.engine, chat.model, answeredAt, answeredAt)
        parent = answerId
        first ??= at
        last = answeredAt
        out.push({ askId, answerId })
      }
      // the chat was made then and answered then; its person has seen the answers. Its shown branch ends at the last
      // answer (chats.active_leaf_id): without it the chat reads as empty and a follow-up starts with no parent
      db.query('UPDATE chats SET created_at = MIN(created_at, ?), updated_at = ?, seen_at = ?, active_leaf_id = COALESCE(?, active_leaf_id) WHERE id = ?')
        .run(first, last, last, out.at(-1)?.answerId ?? null, chat.id)
      // the story's answers are seen like answers of today: shared before them and from the hidden-answers cutover on
      // (chat/shared-answers.ts afterCutover), so a project's members see them and may reply in their threads
      if (first) {
        db.query('UPDATE chats SET shared_at = MIN(shared_at, ?) WHERE id = ? AND shared_at IS NOT NULL').run(first, chat.id)
        const cutover = hiddenAnswersCutover(db)
        if (!cutover || first < cutover) setHiddenAnswersCutover(db, first)
      }
    })()
    return { turns: out }
  })

  kit.handle(API.demoBuilderThreadTimes, ({ body }) => {
    if (!builderOn(ctx)) return fail('not_found')
    const db = ctx.db
    let updated = 0
    db.transaction(() => {
      const set = db.query('UPDATE chat_thread_replies SET created_at = ? WHERE id = ? AND chat_id = ?')
      for (const t of body.times) updated += set.run(new Date(t.at).toISOString(), t.replyId, body.chatId).changes
      // a notice (one per person and thread, chat/threads.ts) is as old as the reply it names; read or not, it stays so
      db.query(`UPDATE chat_thread_notices SET created_at = r.created_at, push_at = r.created_at
        FROM chat_thread_replies r WHERE r.id = chat_thread_notices.reply_id AND chat_thread_notices.chat_id = ?`).run(body.chatId)
      db.query(`UPDATE chat_thread_follows SET created_at = COALESCE((SELECT MIN(created_at) FROM chat_thread_replies r WHERE r.root_id = chat_thread_follows.root_id), created_at)
        WHERE chat_id = ?`).run(body.chatId)
    })()
    return { updated }
  })

  kit.handle(API.demoBuilderFileTimes, ({ body }) => {
    if (!builderOn(ctx)) return fail('not_found')
    const db = ctx.db
    const root = path.resolve(ctx.config.teamRoot)
    const inside = (p: string) => {
      const abs = path.resolve(root, p)
      return abs.startsWith(root + path.sep) ? abs : fail('validation', undefined, { fields: { path: 'outside the team folder' } })
    }
    const under = (p: string, top: string) => p === top || p.startsWith(top.replace(/\/+$/, '') + '/')
    let updated = 0, hidden = 0
    // oldest first: Files › Recent lists by the newest change (file_events id), so the changes are written again in the
    // story's order, each at its time; the file on disk gets the same time (the list shows it)
    const times = [...body.times].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    for (const t of times) {
      const abs = inside(t.path)
      const at = new Date(t.at)
      // the company profile says when it was saved in its own updatedAt, which the API prefers to the file's time: the
      // story's too (QA TC-5935). Builder only, so the rewrite skips versions (a later save takes its base from the file)
      let rewritten: Buffer | null = null
      if (t.path === PROFILE_PATH) {
        try {
          rewritten = Buffer.from(JSON.stringify({ ...JSON.parse(fs.readFileSync(abs, 'utf8')), updatedAt: at.toISOString() }, null, 2) + '\n', 'utf8')
          fs.writeFileSync(abs, rewritten)
        } catch { rewritten = null /* not there or not JSON: the time below is enough */ }
      }
      try { fs.utimesSync(abs, at, at) } catch { continue }
      db.transaction(() => {
        const last = db.query("SELECT user_id, size, sha256, detail FROM file_events WHERE path = ? AND action IN ('create', 'update', 'upload', 'restore') ORDER BY id DESC LIMIT 1").get(t.path) as { user_id: string; size: number | null; sha256: string | null; detail: string | null } | null
        if (!last) return
        db.query("DELETE FROM file_events WHERE path = ? AND action IN ('create', 'update', 'upload', 'restore')").run(t.path)
        db.query("INSERT INTO file_events (user_id, path, action, size, sha256, detail, at) VALUES (?, ?, 'upload', ?, ?, ?, ?)").run(last.user_id, t.path, rewritten?.length ?? last.size, rewritten ? crypto.createHash('sha256').update(rewritten).digest('hex') : last.sha256, last.detail, at.toISOString())
        updated++
      })()
    }
    // a folder shows when something in it last changed (the list's time): each folder above a dated file takes the newest
    // time of what is directly in it, deepest first, so a folder never says the build's time when its files are older
    const dirs = new Set<string>()
    for (const t of times) for (let d = path.dirname(inside(t.path)); d.startsWith(root + path.sep); d = path.dirname(d)) dirs.add(d)
    for (const d of [...dirs].sort((a, b) => b.split(path.sep).length - a.split(path.sep).length)) {
      try {
        const newest = Math.max(...fs.readdirSync(d).map((n) => { try { return fs.statSync(path.join(d, n)).mtimeMs } catch { return 0 } }))
        if (newest > 0) fs.utimesSync(d, new Date(newest), new Date(newest))
      } catch { /* a folder that went away */ }
    }
    // a folder with nothing dated in it (people's own folders, the team skills', the team folder itself) still says the
    // build's time, later than the story: every folder takes the newest time inside it, never past the story's newest
    // dated change (QA TC-5743). Hidden folders (.system, attachments) are left as they are.
    const story = times.length ? Date.parse(times.at(-1)!.at) : NaN
    const settle = (d: string): number => {
      let newest = 0
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue
        const p = path.join(d, e.name)
        try { newest = Math.max(newest, e.isDirectory() ? settle(p) : Math.min(fs.statSync(p).mtimeMs, story)) } catch { /* gone */ }
      }
      const at = new Date(Math.min(newest || story, story))
      fs.utimesSync(d, at, at)
      return at.getTime()
    }
    if (Number.isFinite(story)) { try { settle(root) } catch { /* the team folder is read on the next build */ } }
    // a person's memories, at the story's time
    for (const m of body.memories) {
      db.query(`UPDATE memories SET created_at = ? WHERE user_id = ?${m.text ? ' AND text = ?' : ''}`).run(...[new Date(m.at).toISOString(), m.userId, ...(m.text ? [m.text] : [])])
    }
    // the seed's own changes of these (the team skills, the company profile): not something a person did lately
    for (const top of body.hideFromRecent) {
      inside(top)
      const rows = db.query("SELECT id, path FROM file_events WHERE action IN ('create', 'update', 'upload', 'restore')").all() as { id: number; path: string }[]
      for (const r of rows) if (under(r.path, top)) hidden += db.query('DELETE FROM file_events WHERE id = ?').run(r.id).changes
    }
    return { updated, hidden }
  })
}
