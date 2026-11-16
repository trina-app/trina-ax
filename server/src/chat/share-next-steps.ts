// The next steps the share and post tools hang under their step (Step.fixes; files/share-fixes.ts keeps the offers;
// docs/decisions/20261116-ai-share-who-can-open.md). One place, so post_to_room and share_with_person each need one
// call and never build an offer themselves:
//
//   fixesAfterPost      after a post went to a room: the people there who cannot open a linked file that did not go as
//                       a copy, or a file the text came from (the "N people can't see some of the sources" line, when
//                       the source is a file). "Let them view" when the sender may share it, else "Ask <owner>".
//                       Sources that are not files (a room, a connected service, an earlier conversation) get nothing:
//                       their warning stays as it was, and content that used answers hidden from a member is still
//                       never sent (chat/answer-share.ts, answer_share_hidden).
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
import { findPeople } from '../rooms/reader'
import type { PreparedShare } from './answer-share'
import type { TurnExec } from './turn'

type Exec = Pick<TurnExec, 'rt' | 'spec'>

/** The offers after a post, and what the tool's result says about them (English, for the AI). */
export async function fixesAfterPost(exec: Exec, p: PreparedShare, attached: ReadonlySet<string>, o: { roomId: string; place: string }): Promise<{ fixes: StepFix[]; note: string }> {
  const ctx = exec.rt.ctx
  const by = new Map<string, Set<string>>()
  const add = (path: string, people: readonly string[]) => { const s = by.get(path) ?? by.set(path, new Set()).get(path)!; for (const id of people) s.add(id) }
  // a linked file that did not go as a copy and some member cannot open
  for (const r of p.check.rows) if (r.rel && !attached.has(r.rel) && r.unable.length) add(r.rel, r.unable)
  // a file the text came from that some member cannot open (not covered by a copy everyone can open)
  const prov = await p.check.provenance(attached)
  for (const c of prov.counted ?? []) for (const f of c.files) if (!attached.has(f)) add(f, c.missing)
  if (!by.size) return { fixes: [], note: '' }
  const fixes = shareFixesOf(ctx).forFiles(exec.spec.userId, exec.spec.chatId, [...by].map(([path, people]) => ({ path, people: [...people] })), o)
  if (!fixes.length) return { fixes, note: '' }
  const n = fixes.reduce((x, f) => Math.max(x, f.count), 0)
  const buttons = [...new Set(fixes.map((f) => (f.kind === 'let_view' ? '"Let them view"' : '"Ask the owner"')))].join(' and ')
  return { fixes, note: `${n} ${n === 1 ? 'person' : 'people'} there cannot open ${fixes.length === 1 && !fixes[0]!.moreFiles ? 'the file' : 'some of the files'} yet. The user has a button under this step for it (${buttons}); tell them so in one short sentence, without naming anyone.` }
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
    const fix = shareFixesOf(ctx).forSwitch(exec.spec.userId, exec.spec.chatId, path)
    return fix ? { fixes: [fix], note: 'The user has a button on the card: "Ask an admin" (it sends the team\'s admins a message from the user asking to turn members\' file sharing back on; nothing changes by itself). Tell them so in one short sentence.' } : { fixes: [], note: '' }
  }
  const people = peopleOf(exec, refs)
  const folder = folderAccess(ctx, exec.spec.userId, path)
  if (folder) {
    if (folder.personal || folder.full) return { fixes: [], note: '' }
    const fix = shareFixesOf(ctx).forFolder(exec.spec.userId, exec.spec.chatId, folder.path, people)
    return fix ? { fixes: [fix], note: 'Only the team\'s owner and admins can share a team folder. The user has a button under this step: "Ask an admin" (it sends an admin a message from the user; nothing changes by itself). Tell them so in one short sentence.' } : { fixes: [], note: '' }
  }
  if (!people.length) return { fixes: [], note: '' }
  const fixes = shareFixesOf(ctx).forFiles(exec.spec.userId, exec.spec.chatId, [{ path, people }], { named: true })
  const fix = fixes.find((f) => f.kind === 'ask_owner')
  return fix ? { fixes: [fix], note: `The user has a button on the card: "Ask ${fix.owner ? 'the owner' : 'an admin'} to share it" (the file's owner gets the request and decides; view only). Tell them so in one short sentence${exec.rt.store.chatRow(exec.spec.chatId)?.people_shared_at ? ', without naming anyone' : ''}.` } : { fixes: [], note: '' }
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
