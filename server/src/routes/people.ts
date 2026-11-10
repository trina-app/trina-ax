// Route module "people" — owner: component A. The people directory, own profile and own photo
// (docs/DECISIONS.md "프로필과 사람 목록"). Contract: shared/src/api/people.ts
import { API } from '@mycel/shared/api'
import type { RouteModule } from './module'
import { audit } from '../admin/audit'
import { fail } from '../http/errors'
import { listPeople, MY_PROFILE_CHANGED, profileChangedFor, profileOf, readAvatar, removeAvatar, saveAvatar, updateProfile } from '../auth/profiles'
import { clearStatus, countWrite, setStatus, startStatusClock } from '../auth/status-messages'
import { teamTimeZone } from '../admin/settings'
import { presenceFor } from '../realtime/presence'

// the photo is an image only, never a document that runs anything (the same headers as the team logo)
const IMAGE_HEADERS = { 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox", 'content-disposition': 'inline' }

export const peopleRoutes: RouteModule = {
  name: 'people',
  owner: 'A',
  register(kit, ctx) {
    // statuses start and clear by themselves: the clock tells open windows when one does (auth/status-messages.ts)
    const clock = startStatusClock(ctx)
    // the signed-in person comes from the session, never from the request: nobody can change another person's profile
    kit.handle(API.listPeople, () => ({ people: listPeople(ctx.db) }))

    kit.handle(API.personAvatar, ({ c, params, query }) => {
      const a = readAvatar(ctx.db, params.id) ?? fail('not_found')
      const etag = `"${a.version}"`
      // the current version in the address: cached for good; anything else only briefly (it would show an old photo)
      const cache = query.v === String(a.version) ? 'private, max-age=31536000, immutable' : 'private, max-age=0, must-revalidate'
      const headers = { ...IMAGE_HEADERS, 'content-type': a.type, 'cache-control': cache, etag }
      if (c.req.header('if-none-match') === etag) return new Response(null, { status: 304, headers })
      return new Response(a.bytes as Uint8Array<ArrayBuffer>, { headers })
    })

    kit.handle(API.updateMyProfile, ({ body, auth }) => {
      const changes = updateProfile(ctx.db, auth.user.id, body)
      if (Object.keys(changes).length) {
        audit(ctx.db, { actor: auth.user.id, action: 'profile.update', target: auth.user.id, detail: { fields: Object.keys(changes), ...(changes.name ? { name: changes.name } : {}) } })
        ctx.services.realtime.publishEach(profileChangedFor(auth.user.id))
      }
      const name = (ctx.db.query('SELECT name FROM users WHERE id = ?').get(auth.user.id) as { name: string }).name
      return { id: auth.user.id, name, ...profileOf(ctx.db, auth.user.id) }
    })

    kit.handle(API.putMyAvatar, async ({ c, query, body, auth }) => {
      const r = await saveAvatar(ctx.db, auth.user.id, body, query.type, c.get('locale'))
      audit(ctx.db, { actor: auth.user.id, action: 'profile.avatar_set', target: auth.user.id, detail: { size: r.size, before: r.before } })
      ctx.services.realtime.publishEach(profileChangedFor(auth.user.id))
      return { avatarVersion: r.version }
    })

    // set yourself away, or back to automatic (docs/DECISIONS.md "접속 상태"): kept in the account's prefs until changed,
    // the team told at once (realtime/presence.ts); the person's other windows read their account again (the menu's word)
    kit.handle(API.setMyAway, ({ auth, body }) => {
      const row = ctx.db.query('SELECT prefs FROM users WHERE id = ? AND deleted_at IS NULL').get(auth.user.id) as { prefs: string | null } | null
      if (!row) fail('unauthorized')
      let prefs: Record<string, unknown> = {}
      try {
        const v: unknown = JSON.parse(row!.prefs || '{}')
        if (v && typeof v === 'object' && !Array.isArray(v)) prefs = v as Record<string, unknown>
      } catch { /* unreadable: start over, as PATCH /api/me does */ }
      if ((prefs.away === true) !== body.away) {
        if (body.away) prefs.away = true
        else delete prefs.away
        ctx.db.query('UPDATE users SET prefs = ? WHERE id = ?').run(JSON.stringify(prefs), auth.user.id)
        presenceFor(ctx)?.setAway(auth.user.id, body.away)
        ctx.services.realtime.publish(auth.user.id, MY_PROFILE_CHANGED)
      }
      return { away: body.away }
    })

    // my status message (docs/DECISIONS.md "상태 메시지"): only my own; the team is told only when what it sees changed
    // (a status that starts later is mine alone until its day: the clock tells them then), my other windows always.
    // Not audited, as the away setting is not: it is no account change.
    kit.handle(API.setMyStatus, ({ c, auth, body }) => {
      const locale = c.get('locale'), now = new Date()
      countWrite(ctx.db, auth.user.id, now.getTime(), locale)
      const r = setStatus(ctx.db, auth.user.id, body, { now, tz: teamTimeZone(ctx.db), locale })
      if (r.changed) ctx.services.realtime.publishEach(profileChangedFor(auth.user.id))
      else ctx.services.realtime.publish(auth.user.id, MY_PROFILE_CHANGED)
      clock.arm()
      return r.status
    })

    kit.handle(API.clearMyStatus, ({ c, auth }) => {
      countWrite(ctx.db, auth.user.id, Date.now(), c.get('locale'))
      const r = clearStatus(ctx.db, auth.user.id, new Date())
      if (r.changed) ctx.services.realtime.publishEach(profileChangedFor(auth.user.id))
      else if (r.removed) ctx.services.realtime.publish(auth.user.id, MY_PROFILE_CHANGED)
      if (r.removed) clock.arm()
    })

    kit.handle(API.deleteMyAvatar, ({ auth }) => {
      const before = removeAvatar(ctx.db, auth.user.id)
      if (before === null) return
      audit(ctx.db, { actor: auth.user.id, action: 'profile.avatar_remove', target: auth.user.id, detail: { before } })
      ctx.services.realtime.publishEach(profileChangedFor(auth.user.id))
    })
  },
}
