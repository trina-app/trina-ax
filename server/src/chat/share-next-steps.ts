// The next steps the share and post tools hang under their step (Step.fixes; files/share-fixes.ts keeps the offers;
// docs/decisions/20261116-ai-share-who-can-open.md). One place, so post_to_room and share_with_person each need one
// call and never build an offer themselves:
//
//   fixesAfterPost      after a post went to a room: the people there who cannot open a linked file that did not go as
//                       a copy, or a file the text came from (the "N people can't see some of the sources" line, when
//                       the source is a file). "Let them view" when the sender may share it, else "Ask <owner>".
//                       Sources that are not files (a room, a connected service, an earlier conversation) get nothing:
//                       their warning stays as it was, and content that used answers hidden from a member is still
//                       never sent (chat/answer-share.ts, answer_share_hidden). When post_to_room's card was shown,
//                       its yes already gave "Let them view" (fileGapsOf + ShareFixes.viewPlan before the card,
//                       docs/decisions/20261117-post-to-room-one-card.md): what is left here is "Ask <owner>" and
//                       people that grant could not reach.
//   refusedShareFixes   share_with_person refused a path: someone else's file ("Ask <owner> to share it"), a team
//                       folder asked by a member, or the team's switch for members' sharing off ("Ask an admin", one
//                       kind with a reason on the offer).
//   alreadyOpen         "Jun can already open it through Sales": the share tool says it in place of sharing again.
//
// What the AI is told is counts and whether a button shows, never the names (it writes where, in a shared chat,
// everyone reads; the names are on the step, which only the person whose turn it is gets).
import type { StepFix } from '@mycel/shared/api'
import { accessRouteFor, folderAccess, nameOf, routeWords } from '../files/access-routes'
import { shareFixesOf } from '../files/share-fixes'
import { fileSharesOf } from '../files/shares'
import { readSharedFolder } from './grant-reads'
import { tr } from './i18n'
import { findPeople } from '../rooms/reader'
import type { PreparedShare } from './answer-share'
import type { TurnExec } from './turn'

type Exec = Pick<TurnExec, 'rt' | 'spec'>

/** The files of a post that some people in the room cannot open, each with those people: by path (a file the sender
 * reads by the folder rules) or by link id (one they have only through a share). What fixesAfterPost offers after the
 * post, and what post_to_room's card works out before it (ShareFixes.viewPlan). */
export async function fileGapsOf(exec: Exec, p: PreparedShare, attached: ReadonlySet<string>, roomId: string, o: { sources?: boolean } = {}): Promise<({ path: string; people: string[] } | { share: string; people: string[] })[]> {
  const by = new Map<string, Set<string>>()
  const add = (path: string, people: readonly string[]) => { const s = by.get(path) ?? by.set(path, new Set()).get(path)!; for (const id of people) s.add(id) }
  // a linked file that did not go as a copy and some member cannot open
  for (const r of p.check.rows) if (r.rel && !attached.has(r.rel) && r.unable.length) add(r.rel, r.unable)
  // a file the text came from that some member cannot open (not covered by a copy everyone can open); `sources: false`
  // leaves them out (post_to_room's Send that carries copies: see fileGapsOf's caller there)
  if (o.sources !== false) {
    const prov = await p.check.provenance(attached)
    for (const c of prov.counted ?? []) for (const f of c.files) if (!attached.has(f)) add(f, c.missing)
  }
  // a file someone shared with the sender, linked as /f/<id> (shared_with_me gives those links): the members of the room
  // who cannot open it (the room check reads only team-path links; docs/decisions/20261116-ai-sharing-integration.md)
  const byLink = new Map<string, string[]>()
  // a file the sender reads by the folder rules (their own one too) goes by its path: "Let them view" when theirs to
  // share; one they have only through a share goes by its link id: "Ask <owner>"
  for (const g of fileLinksCant(exec, p.body, roomId)) {
    if (g.byGrant) byLink.set(g.id, g.missing)
    else if (!attached.has(g.path)) add(g.path, g.missing)
  }
  return [...[...by].map(([path, people]) => ({ path, people: [...people] })), ...[...byLink].map(([share, people]) => ({ share, people }))]
}

/** The offers after a post, and what the tool's result says about them (English, for the AI). */
export async function fixesAfterPost(exec: Exec, p: PreparedShare, attached: ReadonlySet<string>, o: { roomId: string; place: string }): Promise<{ fixes: StepFix[]; note: string }> {
  const ctx = exec.rt.ctx
  const gaps = await fileGapsOf(exec, p, attached, o.roomId)
  if (!gaps.length) return { fixes: [], note: '' }
  const fixes = shareFixesOf(ctx).forFiles(exec.spec.userId, exec.spec.chatId, gaps, o)
  if (!fixes.length) return { fixes, note: '' }
  const n = fixes.reduce((x, f) => Math.max(x, f.count), 0)
  // each button by the label the person sees on it, in their language (in a chat others read, an owner's name is left out)
  const L = exec.spec.locale
  const shared = !!exec.rt.store.chatRow(exec.spec.chatId)?.people_shared_at
  const label = (f: StepFix) => f.kind === 'let_view' ? tr('fixButtonLetView', L) : f.kind === 'ask_owner' && f.owner && !shared ? tr('fixButtonAskOwner', L, { owner: f.owner }) : f.kind === 'ask_owner' && f.owner ? 'the button that asks the file\'s owner' : tr('fixButtonAskAdmin', L)
  const buttons = [...new Set(fixes.map((f) => `"${label(f)}"`))].join(' and ')
  return { fixes, note: `${n} ${n === 1 ? 'person' : 'people'} there cannot open ${fixes.length === 1 && !fixes[0]!.moreFiles ? 'the file' : 'some of the files'} yet. The user has a button under your answer for it, labelled ${buttons}; tell them so in one short sentence, calling the button by exactly that label, without naming the people who cannot open it.` }
}

/** The /f/<id> links in a post's text to files the sender opens now, with the room's members (not the sender) who
 * cannot open each: at most 10 files. `byGrant`: the sender has it only through a share. */
function fileLinksCant(exec: Exec, body: string, roomId: string): { id: string; path: string; name: string; byGrant: boolean; missing: string[] }[] {
  const ctx = exec.rt.ctx
  const shares = fileSharesOf(ctx)
  const out: { id: string; path: string; name: string; byGrant: boolean; missing: string[] }[] = []
  const seen = new Set<string>()
  for (const m of body.matchAll(/(?:^|[\s(<"'])(?:https?:\/\/[^/\s]+)?\/f\/([A-Za-z0-9_-]{22})(?![A-Za-z0-9_-])/g)) {
    const id = m[1]!
    if (seen.has(id) || seen.size >= 10) continue
    seen.add(id)
    const s = shares.row(id)
    const mine = s ? shares.open(exec.spec.userId, id) : null
    if (!s || s.state !== 'live' || !mine || mine.kind !== 'open') continue
    const members = (ctx.db.query('SELECT user_id FROM room_members WHERE room_id = ? AND user_id <> ?').all(roomId, exec.spec.userId) as { user_id: string }[]).map((r) => r.user_id)
    const missing = members.filter((u) => shares.open(u, id).kind !== 'open')
    if (missing.length) out.push({ id, path: s.path, name: mine.name, byGrant: mine.by === 'grant', missing })
  }
  return out
}

/** For the post card: the files linked as /f/<id> that the sender has only through a share, by name, and how many in
 * the room cannot open each (a file the sender may share is the room check's own line). */
export function grantedLinksCant(exec: Exec, body: string, roomId: string): { name: string; missing: string[] }[] {
  try { return fileLinksCant(exec, body, roomId).filter((g) => g.byGrant).map((g) => ({ name: g.name, missing: g.missing })) } catch { return [] }
}

/** When the post's "sources" are files shared with the sender (a grant read: chat/grant-reads.ts grantOnly): how many
 * of the room's members (not the sender) cannot open one of them: the files read through a share in this answer and
 * the shared files the text links. The file's owner and anyone who can open it are not counted, so the sources line
 * and the file line say the same number. Null when no such file is known, or the chat read inside a folder shared with
 * the sender (the room check's own count stands). */
export function grantSourceCant(exec: Exec & { files?: { grantReadPaths?: ReadonlySet<string> } }, body: string, roomId: string): number | null {
  try {
    // a shared folder was read too: its people are not counted here, so the room check's count stands (QA TC-4482)
    if (readSharedFolder(exec)) return null
    const ctx = exec.rt.ctx
    const shares = fileSharesOf(ctx)
    const ids = new Set<string>()
    for (const p of exec.files?.grantReadPaths ?? []) { const s = shares.liveRow(p); if (s) ids.add(s.id) }
    for (const g of fileLinksCant(exec, body, roomId)) if (g.byGrant) ids.add(g.id)
    if (!ids.size) return null
    const members = (ctx.db.query('SELECT user_id FROM room_members WHERE room_id = ? AND user_id <> ?').all(roomId, exec.spec.userId) as { user_id: string }[]).map((r) => r.user_id)
    return members.filter((u) => [...ids].some((id) => shares.open(u, id).kind !== 'open')).length
  } catch { return null }
}

/** The teammates `refs` name, when each names exactly one (a name that matches several, a group, or nobody is left
 * out: the offer is then for nobody by name). */
function peopleOf(exec: Exec, refs: readonly string[]): string[] {
  const out: string[] = []
  for (const ref of refs) {
    const p = findPeople(exec.rt.db, exec.spec.userId, ref)
    if (p && 'one' in p) out.push(p.one.id)
  }
  return out
}

/**
 * share_with_person could not share `path` for the people the user named (`refs`, as the user wrote them). The offers
 * for the step and a sentence for the AI, or nothing (no offer applies: the usual refusal stands).
 * - someone else's file the user can open: "Ask <owner> to share it" for those people who cannot open it yet;
 * - a team folder, asked by a member: "Ask an admin".
 */
export function refusedShareFixes(exec: Exec, path: string, refs: readonly string[], cause: 'file' | 'switch' = 'file'): { fixes: StepFix[]; note: string } {
  const ctx = exec.rt.ctx
  // the team turned off members' file sharing: one "Ask an admin" to turn it on (the same kind as the folder's, its
  // reason on the offer; files/share-fixes.ts forSwitch)
  if (cause === 'switch') {
    const fix = shareFixesOf(ctx).forSwitch(exec.spec.userId, exec.spec.chatId, path, exec.spec.locale)
    return fix ? { fixes: [fix], note: 'The user has a button on the card under your answer: "Ask an admin" (it sends the team\'s admins a message from the user asking to turn members\' file sharing back on; nothing changes by itself). Tell them so in one short sentence.' } : { fixes: [], note: '' }
  }
  const people = peopleOf(exec, refs)
  const folder = folderAccess(ctx, exec.spec.userId, path)
  if (folder) {
    if (folder.personal || folder.full) return { fixes: [], note: '' }
    const fix = shareFixesOf(ctx).forFolder(exec.spec.userId, exec.spec.chatId, folder.path, people, exec.spec.locale)
    return fix ? { fixes: [fix], note: 'Only the team\'s owner and admins can share a team folder. The user has a button under this step: "Ask an admin" (it sends an admin a message from the user; nothing changes by itself). Tell them so in one short sentence.' } : { fixes: [], note: '' }
  }
  if (!people.length) return { fixes: [], note: '' }
  const fixes = shareFixesOf(ctx).forFiles(exec.spec.userId, exec.spec.chatId, [{ path, people }], { named: true })
  const fix = fixes.find((f) => f.kind === 'ask_owner')
  return fix ? { fixes: [fix], note: `The user has a button on the card: ${fix.owner ? 'the one that asks the file\'s owner' : '"Ask an admin"'} (${fix.owner ? 'the owner' : 'an admin'} gets the request and decides; view only). Tell them so in one short sentence${exec.rt.store.chatRow(exec.spec.chatId)?.people_shared_at ? ', without naming anyone' : ''}.` } : { fixes: [], note: '' }
}

/** share_with_person was asked to share a file the user has only through a share (someone else's file, shared with
 * them by link): "Ask <owner> to share it" for the people the user named, by the file's link id (its path is not
 * theirs to see). Nothing when nobody named can be asked for. */
export function refusedGrantedFixes(exec: Exec, shareId: string, refs: readonly string[]): StepFix[] {
  const people = peopleOf(exec, refs)
  if (!people.length) return []
  return shareFixesOf(exec.rt.ctx).forFiles(exec.spec.userId, exec.spec.chatId, [{ share: shareId, people }], { named: true }).filter((f) => f.kind === 'ask_owner').slice(0, 1)
}

/** The people of `ids` who can already open every file of `paths`, each with how ("Jun can already open it: through
 * the "Sales" group…", English for the AI; with several files the route of the first). */
export function alreadyOpen(exec: Exec, paths: readonly string[], ids: readonly string[]): { id: string; words: string }[] {
  const ctx = exec.rt.ctx
  const out: { id: string; words: string }[] = []
  for (const id of ids) {
    const routes = paths.map((p) => accessRouteFor(ctx, id, p))
    const name = nameOf(ctx, id)
    if (!name || !routes.length || routes.some((r) => !r)) continue
    out.push({ id, words: `${name} can already open ${paths.length === 1 ? 'it' : 'them'}: ${routeWords(ctx, routes[0]!, exec.spec.userId)}` })
  }
  return out
}
