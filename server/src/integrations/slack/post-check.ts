// "Post to channel" checks what the answer used (docs/SLACK.md, docs/DECISIONS.md "Slack: Post to channel checks what
// the answer used"). A Slack question is a normal turn of the asker's, with their whole reach (their groups' folders,
// their own folder, memories, personal connections), and posting puts the answer in front of the channel. Who is in a
// Slack channel cannot be mapped to accounts here, so the audience is the whole team: every active account but the
// asker. The check is 대화방에 보내기's (chat/answer-share.ts provenanceChecker over the answer's branch: the files it
// read, the chat's read scope when it describes the answer, "not all known" otherwise) and the share of a chat's memory
// rule (chat/share-chat.ts memoriesInPlay); a team connection or a shared Google Drive counts as not team-wide whoever
// its rules let use it (the room AI's rule, rooms/ai.ts decide: what it returned is outside content). With nobody else on
// the team the channel still has people: the asker's own material and an answer not all known still count. The asker is
// told the places as they may look at them themselves (placeOf), never what is in them and never who cannot see them.
// Never posted, whatever the asker says (as 대화방에 보내기 refuses them): a confidential conversation (safe operations
// 1A, safe-ops/confidential.ts) and an answer that read a room some member would see but for old answers hidden from
// them (the asker cannot see what is at stake for them).
import type { AnswerSharePlace, Locale } from '@mycel/shared/api'
import type { AppContext } from '../../context'
import { branchUse, confirmMac, provenanceChecker } from '../../chat/answer-share'
import { memoriesInPlay } from '../../chat/share-chat'
import { confidentialChat } from '../../safe-ops/confidential'
import { sourceKey } from '../../chat/read-scope'
import { say, type TextKey } from './text'

/** What the notice names besides the shared places: the asker's own material, apart. */
export type OwnPlace = 'folder' | 'browser' | 'connection' | 'memories'
export interface PostCheck {
  /** never posted, not even after the notice: a confidential conversation, or old room answers hidden from someone */
  refused: 'confidential' | 'hidden' | null
  /** everything it used, every active member of the team may read now: posted at once */
  teamWide: boolean
  places: AnswerSharePlace[]
  own: OwnPlace[]
  /** more that is not named: a place the asker may not look at now, or not all of it is known */
  otherPlaces: boolean
  /** the key "Post anyway" carries: what the notice said, for this request and this asker */
  key: string
}

/** The check of one answer asked in Slack (`r`: its request row), as the asker sees it now. */
export async function postCheck(ctx: AppContext, r: { id: string; user_id: string; slack_user_id: string; chat_id: string; message_id: string }): Promise<PostCheck> {
  const db = ctx.db
  const me = r.user_id
  // the whole team: every account that may read now, but the asker (a disabled or deleted account reads nothing)
  const audience = (db.query("SELECT id FROM users WHERE status = 'active' AND deleted_at IS NULL AND id <> ? ORDER BY id").all(me) as { id: string }[]).map((u) => u.id)
  const use = branchUse(db, r.chat_id, r.message_id)
  const pc = provenanceChecker(ctx, me, audience, use.answers)
  const prov = await pc.of([use], new Set())
  // nobody else on the team (one account, or every other one disabled): the asker's own material and an answer not all
  // known are not team-wide either (the channel has people all the same)
  const alone = audience.length === 0
  const mineAt = (p: string) => { const [top, id] = p.split('/').filter(Boolean); return top === 'users' && id === me }
  const ownFiles = use.files.some((f) => mineAt(f.path))
  const ownUse = ownFiles || use.other.some((s) => (s.type === 'user' && s.id === me) || (s.type === 'name' && mineAt(s.path)))
  const memories = memoriesInPlay(db, r.chat_id, me)
  // a team connection or a shared Drive: not team-wide, whatever its rules (named by its name, as 대화방에 보내기 does)
  const outside = use.other.filter((s) => s.type === 'integration' || s.type === 'drive_share')
  const places = new Map<string, AnswerSharePlace>()
  let otherPlaces = prov.otherPlaces
  let mine = false
  for (const p of prov.places) { if (p.kind === 'mine') mine = true; else places.set(JSON.stringify(p), p) }
  if (alone && ownUse) mine = true
  for (const s of outside) { const p = pc.placeOf(s); if (p) places.set(JSON.stringify(p), p); else otherPlaces = true }
  // the asker's own material by what it was (the app says "my folder" for all three): their folder, the in-app browser,
  // their personal connections (and personal Drive). Only when the check counted it
  const own = new Set<OwnPlace>()
  if (mine) {
    for (const s of use.other) if (s.type === 'user' && s.id === me) own.add(s.via === 'browser' ? 'browser' : s.via === 'connection' ? 'connection' : 'folder')
    if (!own.size || ownFiles) own.add('folder')
  }
  if (memories) own.add('memories')
  // (a member who would see a room it read but for old answers hidden from them: never posted)
  const hidden = prov.hidden
  const teamWide = !prov.unknown && !prov.roomsUnseen && prov.missing.size === 0 && !(alone && ownUse) && !memories && !outside.length && !hidden
  const ownList = (['folder', 'browser', 'connection', 'memories'] as const).filter((k) => own.has(k))
  const placeList = [...places.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  const key = confirmMac(ctx, {
    kind: 'slack.post', v: 1, request: r.id, userId: me, slackUser: r.slack_user_id, message: r.message_id,
    sources: prov.keys, outside: outside.map(sourceKey).sort(), places: placeList, own: ownList, otherPlaces, unknown: prov.unknown, hidden, alone,
  })
  const refused = confidentialChat(db, r.chat_id) ? 'confidential' as const : hidden ? 'hidden' as const : null
  return { refused, teamWide, places: placeList, own: ownList, otherPlaces, key }
}

const OWN: Record<OwnPlace, TextKey> = { folder: 'placeMine', browser: 'placeBrowser', connection: 'placeConnection', memories: 'placeMemories' }

/** A place as the notice names it, in the asker's language (plain text: never Slack markup). */
function placeWord(p: AnswerSharePlace, locale: Locale): string {
  switch (p.kind) {
    case 'folder': return p.path ? `${p.path.replace(/\/+$/, '')}/` : say('placeTop', locale)
    case 'mine': return say('placeMine', locale)
    case 'service': return p.name
    case 'room': return p.name ? say('placeRoom', locale, { name: p.name }) : say('placeEveryone', locale)
    case 'conversation': return say('placeConversation', locale)
  }
}

/** The places of a check as one list in the asker's language: the shared places, then their own, then "other material".
 * At most 12 named (each at most 120 characters); the rest is "other material" too. */
export function placesText(c: Pick<PostCheck, 'places' | 'own' | 'otherPlaces'>, locale: Locale): string {
  const words = [...c.places.map((p) => placeWord(p, locale)), ...c.own.map((k) => say(OWN[k], locale))]
    .map((w) => w.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()).filter(Boolean)
    .map((w) => (w.length > 120 ? `${w.slice(0, 119)}…` : w))
  const named = words.slice(0, 12)
  if (c.otherPlaces || words.length > named.length || !named.length) named.push(say('placeOther', locale))
  return named.join(locale === 'ja' ? '、' : ', ')
}
