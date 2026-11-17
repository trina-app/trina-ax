// One-tap next steps under an AI step (Step.fixes; docs/decisions/20261116-ai-share-who-can-open.md, plan
// docs/AGENTS/plan/20261116-1150-ai-share-who-can-open.md): "3 people in #Sales can't open it yet. [Let them view]",
// "It's Mina's file. [Ask Mina]", "Only admins can share this folder. [Ask an admin]", "Only you can see this chat.
// [Share with project]".
//
// The rules:
// - An offer is the SERVER's record (share_fix_offers, migration 363): which files (by their link ids, which follow a
//   move), which people (ids), which room. The step carries only what the person reads (names the server resolved,
//   counts) and the offer's id. Nothing on the button comes from the AI's text or a file's content.
// - Only the person the offer was made for runs it (anyone else: 404), once. The tap is the confirmation: the line
//   above the button named the people it is for.
// - Every tap is checked again as that person, now: let_view is a normal share (FileShares.change, via 'ai', audited
//   file.share, each person told as for any share), so someone who may not share the file is refused there; ask_owner
//   is the existing access request, asked for the people (FileShares.requestFor); ask_admin is a 1:1 message from the
//   person to the team's owner and admins, written by the server (the folder, the people, a link to the folder). It
//   changes nobody's access.
// - The people granted are the people listed, minus whoever left the room, is no longer an active member, became a
//   guest or can open the file already. Nobody is added: someone who joined the room after the offer was made is
//   counted in `left`, never granted.
// - A guest is never granted and never asked for.
// - share_project runs nothing here: the app opens its own "Share with project members" flow (POST /api/chats/:id/share,
//   with its check and confirm). The offer only says the chat is private in a team project.
import type { Database } from 'bun:sqlite'
import type { Locale, RunStepFixResult, StepFix } from '@mycel/shared/api'
import { plainLabel } from '@mycel/shared/api'
import { listWords } from '@mycel/shared'
import type { AppContext } from '../context'
import { audit } from '../admin/audit'
import { HttpError } from '../http/errors'
import { isStaff, loadPrincipal } from '../policy/access'
import { roomsOf } from '../rooms/service'
import { newId } from '../db'
import { accessRouteFor, nameOf } from './access-routes'
import { fileSharesOf } from './shares'
import { tr } from '../chat/i18n'
import { getTeamSettings } from '../admin/settings'

/** names shown on the line (the rest is the count) */
export const FIX_NAMES = 3
/** people one offer is for, at most */
export const FIX_PEOPLE_MAX = 50
/** files one offer is about, at most */
export const FIX_FILES_MAX = 10
/** the admins an "Ask an admin" message goes to, at most (the owner first) */
export const FIX_ADMINS_MAX = 3
const KEEP_MS = 30 * 86400_000

interface FileOf { share: string; people: string[] }
type Payload =
  | { kind: 'let_view' | 'ask_owner'; files: FileOf[]; roomId?: string }
  | { kind: 'ask_admin'; reason?: 'folder'; folder: string; people: string[]; admins: string[] }
  // the team turned off members' file sharing: ask to turn it on, for the person's own file (by its link id)
  | { kind: 'ask_admin'; reason: 'switch'; share: string; admins: string[] }
  | { kind: 'share_project'; projectId: string }
/** A "Let them view" worked out before anything is saved (ShareFixes.viewPlan): the first file's name, the files by
 * link id with the people for each, their paths (same order), the guests left out, and how many people in all. */
export interface ViewPlan { name: string; files: FileOf[]; paths: string[]; guests: ReadonlySet<string>; count: number }
interface Row { id: string; user_id: string; chat_id: string; kind: StepFix['kind']; payload: string; state: StepFix['state']; done_count: number | null }

const baseName = (p: string) => p.split('/').pop() ?? p
const isMember = (db: Database, id: string) => !!db.query("SELECT 1 FROM users WHERE id = ? AND status = 'active' AND deleted_at IS NULL AND guest = 0").get(id)
const isGuest = (db: Database, id: string) => !!db.query('SELECT 1 FROM users WHERE id = ? AND guest = 1').get(id)

/** The offers of a step as they are now (run meanwhile, or nothing left to do): read when a message is shown. */
export function currentFixes(db: Database, fixes: readonly StepFix[]): StepFix[] {
  return fixes.map((f) => {
    const r = db.query('SELECT state, done_count, kind, chat_id FROM share_fix_offers WHERE id = ?').get(f.id) as { state: StepFix['state']; done_count: number | null; kind: string; chat_id: string } | null
    if (!r) return { ...f, state: 'gone' as const }
    // a chat shared since (from the title menu, or this button's own flow): done
    if (r.kind === 'share_project' && r.state === 'open' && db.query('SELECT 1 FROM chats WHERE id = ? AND shared_at IS NOT NULL').get(r.chat_id)) return { ...f, state: 'done' as const }
    return r.state === f.state && (r.done_count ?? undefined) === f.doneCount ? f : { ...f, state: r.state, ...(r.done_count !== null ? { doneCount: r.done_count } : {}) }
  })
}

const instances = new WeakMap<AppContext, ShareFixes>()
export const shareFixesOf = (ctx: AppContext): ShareFixes => {
  let s = instances.get(ctx)
  if (!s) { s = new ShareFixes(ctx); instances.set(ctx, s) }
  return s
}

export class ShareFixes {
  constructor(readonly ctx: AppContext) {}
  private get db() { return this.ctx.db }

  private save(userId: string, chatId: string, p: Payload): string {
    const id = newId()
    const at = new Date()
    this.db.query('DELETE FROM share_fix_offers WHERE created_at < ?').run(new Date(at.getTime() - KEEP_MS).toISOString())
    this.db.query('INSERT INTO share_fix_offers (id, user_id, chat_id, kind, payload, state, created_at) VALUES (?,?,?,?,?,?,?)').run(id, userId, chatId, p.kind, JSON.stringify(p), 'open', at.toISOString())
    return id
  }
  private names(ids: readonly string[]): string[] { return ids.slice(0, FIX_NAMES).map((id) => nameOf(this.ctx, id) ?? '').filter(Boolean) }

  /**
   * After a post to a room (or for one person asked about): for each file, the people who cannot open it. The files the
   * person may share become one "Let them view" (the people named); the others, when someone can be asked, one "Ask
   * <owner>" per owner (the people counted, not named, unless `named`: the person named them themselves). Guests are
   * counted apart and never in an offer. Files the person cannot open, folders, and files nobody can be asked about
   * give nothing. `place`: the room as the person sees it.
   */
  forFiles(userId: string, chatId: string, files: readonly ({ path: string; people: readonly string[] } | { share: string; people: readonly string[] })[], o: { roomId?: string; place?: string; named?: boolean } = {}): StepFix[] {
    const p = this.plan(userId, files)
    if (!p) return []
    const out: StepFix[] = []
    if (p.view.files.length) out.push(this.saveView(userId, chatId, p.view, o))
    for (const e of p.ask.values()) {
      const c = this.common(e.name, e.files, e.guests, o.place)
      const id = this.save(userId, chatId, { kind: 'ask_owner', files: e.files, ...(o.roomId ? { roomId: o.roomId } : {}) })
      out.push({ id, kind: 'ask_owner', ...c.base, ...(o.named ? { people: this.names(c.all) } : {}), ...(e.owner ? { owner: e.owner } : {}) })
    }
    return out
  }

  /**
   * The "Let them view" part of forFiles, worked out and NOT saved: the files the person may share and, for each, the
   * people who cannot open it (the same rules as forFiles). post_to_room shows it on its one card before the post
   * ("2 people there will be able to open quote.pdf") and, on the person's yes, saves it with saveView and runs it
   * (docs/decisions/20261117-post-to-room-one-card.md). Null: nothing the person may grant.
   */
  viewPlan(userId: string, files: readonly ({ path: string; people: readonly string[] } | { share: string; people: readonly string[] })[]): ViewPlan | null {
    const p = this.plan(userId, files)
    if (!p || !p.view.files.length) return null
    return { name: p.view.name, files: p.view.files, paths: p.view.paths, guests: p.view.guests, count: new Set(p.view.files.flatMap((f) => f.people)).size }
  }

  /** Save a let_view offer exactly as planned (its files, its people), for the person to run (a tap, or the post card's
   * yes: run right after). */
  saveView(userId: string, chatId: string, v: Pick<ViewPlan, 'name' | 'files' | 'guests'>, o: { roomId?: string; place?: string } = {}): StepFix {
    const c = this.common(v.name, v.files, v.guests, o.place)
    const id = this.save(userId, chatId, { kind: 'let_view', files: v.files, ...(o.roomId ? { roomId: o.roomId } : {}) })
    return { id, kind: 'let_view', ...c.base, people: this.names(c.all) }
  }

  /** Take back an offer nobody saw (the post card's grant that failed: the step gets forFiles' own offer instead). */
  drop(userId: string, id: string): void {
    this.db.query('DELETE FROM share_fix_offers WHERE id = ? AND user_id = ?').run(id, userId)
  }

  private common(name: string, fs: FileOf[], guests: ReadonlySet<string>, place?: string) {
    const all = [...new Set(fs.flatMap((x) => x.people))]
    return { all, base: { file: plainLabel(name, 200), ...(fs.length > 1 ? { moreFiles: fs.length - 1 } : {}), ...(place ? { place: plainLabel(place, 200) } : {}), count: all.length, ...(guests.size ? { guests: guests.size } : {}), state: 'open' as const } }
  }

  /** forFiles' rules, nothing saved: the files the person may share (view) and, per owner, the others (ask). */
  private plan(userId: string, files: readonly ({ path: string; people: readonly string[] } | { share: string; people: readonly string[] })[]) {
    const me = loadPrincipal(this.db, userId)
    if (!me || me.role === 'guest') return null
    const shares = fileSharesOf(this.ctx)
    const view: { name: string; files: FileOf[]; paths: string[]; guests: Set<string> } = { name: '', files: [], paths: [], guests: new Set() }
    const ask = new Map<string, { owner: string; name: string; files: FileOf[]; guests: Set<string> }>()
    for (const f of files.slice(0, FIX_FILES_MAX)) {
      // by its path: a file the folder lets the person read (the Share dialog's view of it). By its link id: a file they
      // have through a share alone (never theirs to share: only its owner can be asked)
      let v: { path: string; canShare: boolean }
      let link: string
      if ('share' in f) {
        const o2 = shares.open(userId, f.share)
        if (o2.kind !== 'open') continue
        v = { path: o2.share.path, canShare: false }
        link = f.share
      } else {
        try { const x = shares.view(userId, f.path, 'en'); v = { path: x.path, canShare: x.canShare } } catch { continue }
        try { link = shares.linkFor(userId, v.path).id } catch { continue }
      }
      const guests = f.people.filter((id) => isGuest(this.db, id))
      const people = [...new Set(f.people)].filter((id) => id !== userId && isMember(this.db, id) && !accessRouteFor(this.ctx, id, v.path)).slice(0, FIX_PEOPLE_MAX)
      if (!people.length && !guests.length) continue
      if (v.canShare) {
        if (!people.length) continue
        if (!view.files.length) view.name = baseName(v.path)
        view.files.push({ share: link, people })
        view.paths.push(v.path)
        for (const g of guests) view.guests.add(g)
        continue
      }
      if (!people.length) continue
      const to = shares.askable(userId, link)
      if (!to.ids.length) continue
      const key = to.owner ? to.ids[0]! : ''
      const entry = ask.get(key) ?? ask.set(key, { owner: to.owner ? nameOf(this.ctx, to.ids[0]!) ?? '' : '', name: baseName(v.path), files: [], guests: new Set() }).get(key)!
      entry.files.push({ share: link, people })
      for (const g of guests) entry.guests.add(g)
    }
    return { view, ask }
  }

  /** The team's owner and admins a member's "Ask an admin" goes to: active, the owner first, at most FIX_ADMINS_MAX. */
  admins(but: string): string[] {
    return (this.db.query("SELECT id FROM users WHERE status = 'active' AND deleted_at IS NULL AND guest = 0 AND role IN ('owner','admin') AND id <> ? ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, name, id LIMIT ?").all(but, FIX_ADMINS_MAX) as { id: string }[]).map((r) => r.id)
  }

  /** "Ask an admin" about a team folder the person can open but may not share (they are no owner or admin): for
   * `people` (who cannot open it), or nobody named. Null: nothing to ask (the person is an admin, a personal folder, a
   * project's folder, no admin to ask). */
  forFolder(userId: string, chatId: string, folder: string, people: readonly string[], L: Locale = 'en'): StepFix | null {
    const me = loadPrincipal(this.db, userId)
    if (!me || me.role === 'guest' || isStaff(me)) return null
    const segs = folder.split('/').filter(Boolean)
    if (!segs.length || segs[0] === 'users' || !accessRouteFor(this.ctx, userId, folder)) return null
    const admins = this.admins(userId)
    if (!admins.length) return null
    const who = [...new Set(people)].filter((id) => id !== userId && isMember(this.db, id) && !accessRouteFor(this.ctx, id, folder)).slice(0, FIX_PEOPLE_MAX)
    const id = this.save(userId, chatId, { kind: 'ask_admin', folder: segs.join('/'), people: who, admins })
    return { id, kind: 'ask_admin', reason: 'folder', file: plainLabel(baseName(folder), 200), count: who.length, ...(who.length ? { people: this.names(who) } : {}), owner: plainLabel(listWords(admins.map((a) => nameOf(this.ctx, a) ?? '').filter(Boolean), L), 200), state: 'open' }
  }

  /** "Ask an admin" when the team turned off members' file sharing and the person's own file could not be shared:
   * the admins get the person's 1:1 message asking to turn it back on, naming the file. Null: nothing to ask (the
   * switch is on, the person is an admin, it is not their file, no admin to ask). */
  forSwitch(userId: string, chatId: string, path: string, L: Locale = 'en'): StepFix | null {
    const me = loadPrincipal(this.db, userId)
    if (!me || me.role === 'guest' || isStaff(me)) return null
    const shares = fileSharesOf(this.ctx)
    let link: string
    try {
      const v = shares.view(userId, path, 'en')
      if (!v.off || !v.mine) return null
      link = shares.linkFor(userId, v.path).id
    } catch { return null }
    const admins = this.admins(userId)
    if (!admins.length) return null
    const id = this.save(userId, chatId, { kind: 'ask_admin', reason: 'switch', share: link, admins })
    return { id, kind: 'ask_admin', reason: 'switch', file: plainLabel(baseName(path), 200), count: 0, owner: plainLabel(listWords(admins.map((a) => nameOf(this.ctx, a) ?? '').filter(Boolean), L), 200), state: 'open' }
  }

  /** "Share with project": the person's own private chat in a team project (the app's flow does the share and its
   * checks). `project`: its name. */
  forChat(userId: string, chatId: string, project: { id: string; name: string }): StepFix {
    const id = this.save(userId, chatId, { kind: 'share_project', projectId: project.id })
    return { id, kind: 'share_project', file: plainLabel(project.name, 200), count: 0, chatId, state: 'open' }
  }

  /** The offer's row, for the person it was made for; else not found. */
  private load(userId: string, id: string): Row {
    const r = /^[A-Za-z0-9_-]{1,64}$/.test(id) ? this.db.query('SELECT id, user_id, chat_id, kind, payload, state, done_count FROM share_fix_offers WHERE id = ?').get(id) as Row | null : null
    if (!r || r.user_id !== userId) throw new HttpError('not_found')
    return r
  }

  /** The people of `f` an offer may still act for now: listed then, an active member who is not a guest, still in the
   * room it was about (when it was about one), and unable to open the file. */
  private still(f: FileOf, path: string, roomId: string | undefined): string[] {
    const inRoom = roomId ? new Set((this.db.query('SELECT user_id FROM room_members WHERE room_id = ?').all(roomId) as { user_id: string }[]).map((r) => r.user_id)) : null
    return f.people.filter((id) => (!inRoom || inRoom.has(id)) && isMember(this.db, id) && !accessRouteFor(this.ctx, id, path))
  }

  /**
   * POST /api/share-fixes/:id/run. Returns the offer as the step now shows it: done with how many people it reached
   * (`doneCount`) and how many in the room still cannot open it and were not listed (`left`), or gone (nothing left).
   * A refusal of the action itself (the person may no longer share the file, the budget, nobody to ask) is thrown with
   * the server's words and leaves the offer open.
   */
  run(userId: string, id: string, L: Locale): RunStepFixResult {
    const r = this.load(userId, id)
    const p = JSON.parse(r.payload) as Payload
    const pub = (state: StepFix['state'], done?: number, left?: number): RunStepFixResult => ({ state, ...(done !== undefined ? { doneCount: done } : {}), ...(left ? { left } : {}) })
    if (r.state !== 'open') return pub(r.state, r.done_count ?? undefined)
    if (p.kind === 'share_project') return pub('open')
    // one run at a time: the offer is taken first, and put back when the action is refused
    if (this.db.query("UPDATE share_fix_offers SET state = 'done', done_at = ? WHERE id = ? AND state = 'open'").run(new Date().toISOString(), r.id).changes !== 1) return pub('done')
    const settle = (state: StepFix['state'], done: number) => { this.db.query('UPDATE share_fix_offers SET state = ?, done_count = ? WHERE id = ?').run(state, done, r.id) }
    try {
      const me = loadPrincipal(this.db, userId)
      if (!me || me.role === 'guest') throw new HttpError('not_found')
      if (p.kind === 'ask_admin') {
        const done = this.askAdmin(userId, r.id, p, L)
        settle(done ? 'done' : 'gone', done)
        return pub(done ? 'done' : 'gone', done)
      }
      const shares = fileSharesOf(this.ctx)
      // the room the offer was about must still be one of the person's (they left it, it was archived: nothing to do)
      if (p.roomId) try { roomsOf(this.ctx).mine(userId, p.roomId) } catch { settle('gone', 0); return pub('gone', 0) }
      const reached = new Set<string>()
      const paths: string[] = []
      for (const f of p.files) {
        const s = shares.row(f.share)
        if (!s || s.state !== 'live') continue
        paths.push(s.path)
        const people = this.still(f, s.path, p.roomId)
        if (!people.length) continue
        if (p.kind === 'let_view') {
          // the Share dialog's own call: the owner with edit access (or an admin for a team file), members only while
          // the team allows it, never a guest; audited file.share with via 'ai'
          const res = shares.change(userId, s.path, people.map((subjectId) => ({ subjectType: 'user' as const, subjectId })), [], L, 'ai')
          for (const x of people) if (res.added.includes(x) || accessRouteFor(this.ctx, x, s.path)) reached.add(x)
        } else {
          const res = shares.requestFor(userId, f.share, people, L)
          for (const x of [...res.asked, ...res.already]) reached.add(x)
        }
      }
      // who in the room cannot open some file of it now and was not reached: people who joined since are among them
      let left = 0
      if (p.roomId && p.kind === 'let_view') {
        const members = (this.db.query('SELECT user_id FROM room_members WHERE room_id = ? AND user_id <> ?').all(p.roomId, userId) as { user_id: string }[]).map((x) => x.user_id)
        left = members.filter((m) => !reached.has(m) && isMember(this.db, m) && paths.some((path) => !accessRouteFor(this.ctx, m, path))).length
      }
      audit(this.db, { actor: userId, action: 'share.fix', target: `share-fix:${r.id}`, detail: { kind: p.kind, files: p.files.length, people: reached.size, via: 'ai' } })
      settle(reached.size ? 'done' : 'gone', reached.size)
      return pub(reached.size ? 'done' : 'gone', reached.size, left)
    } catch (e) {
      this.db.query("UPDATE share_fix_offers SET state = 'open', done_at = NULL WHERE id = ?").run(r.id)
      throw e
    }
  }

  /** The person's own 1:1 message to each admin, written here: the folder by name with a link to it, and the people
   * who cannot open it. Returns how many admins got it. */
  private askAdmin(userId: string, offerId: string, p: Extract<Payload, { kind: 'ask_admin' }>, L: Locale): number {
    const me = loadPrincipal(this.db, userId)!
    if (isStaff(me)) return 0
    let body: string, path: string, people: string[] = []
    if (p.reason === 'switch') {
      // still worth asking: the switch is still off and the file is still theirs (else nothing to do)
      const s = fileSharesOf(this.ctx).row(p.share)
      if (!s || s.state !== 'live' || s.owner_id !== userId || getTeamSettings(this.db).memberFileShares !== false) return 0
      path = s.path
      // the file by its name only: an admin may not be able to open it (a personal folder), and nothing is shared by this
      body = tr('fixAskAdminSwitch', L, { file: plainLabel(baseName(s.path), 120), setting: tr('fixSwitchName', L) })
    } else {
      // still theirs to ask about: they can open the folder and are no admin (an admin shares it themselves)
      if (!accessRouteFor(this.ctx, userId, p.folder)) return 0
      path = p.folder
      people = p.people.filter((id) => isMember(this.db, id) && !accessRouteFor(this.ctx, id, p.folder)).map((id) => nameOf(this.ctx, id) ?? '').filter(Boolean)
      const name = plainLabel(baseName(p.folder), 120).replace(/[\[\]()]/g, ' ')
      const link = `[${name}](/files/view?path=${encodeURIComponent(p.folder)})`
      body = people.length ? tr('fixAskAdminPeople', L, { folder: link, people: people.join(', ') }) : tr('fixAskAdmin', L, { folder: link })
    }
    const rooms = roomsOf(this.ctx)
    let sent = 0
    for (const admin of p.admins.slice(0, FIX_ADMINS_MAX)) {
      const a = loadPrincipal(this.db, admin)
      if (!a || !isStaff(a)) continue
      const room = rooms.openDm(userId, admin)
      rooms.takeSendToken(userId)
      rooms.send(userId, room.id, { body, mentions: [], fileIds: [], clientMessageId: `fix-${offerId}-${sent}`, threadRootId: null }, { locale: L })
      sent++
    }
    if (sent) audit(this.db, { actor: userId, action: 'share.fix', target: `share-fix:${offerId}`, detail: { kind: 'ask_admin', reason: p.reason ?? 'folder', path, admins: sent, people: people.length, via: 'ai' } })
    return sent
  }
}
