// The server record of an AI share card (shared/src/api/share-card.ts; docs/decisions/20261116-ai-share-card-and-stop.md).
// share_with_person (chat/share-with-person.ts) and stop_sharing (chat/stop-sharing.ts) write what they did on their
// step (`Step.shared`), and their confirmation card carries the same rows (`AskUserRequest.share`): the app draws the
// card from these, never from the AI's words. Everything here is read from the server's own records: a file's name and
// its place in words (chat/place-words.ts, never a path), a person's name and picture version, a group's size.
import { createHash } from 'node:crypto'
import type { Database } from 'bun:sqlite'
import { FILE_SHARE_EVERYONE, SHARE_CARD_PEOPLE_MAX, SHARE_CARD_STILL_MAX, plainLabel, type Locale, type ShareCardAsk, type ShareCardFile, type ShareCardStill, type ShareCardWho, type StepShared } from '@mycel/shared/api'
import type { FileShares, StillOpens } from '../files/shares'
import { placeWords } from './place-words'

export interface CardSubject { subjectType: 'user' | 'group'; subjectId: string; name: string }

/** A file as a card row: its name and the folder it is in, in the words the asker reads (`me`). */
export function cardFile(db: Database, path: string, L: Locale, me: string, linkId?: string | null): ShareCardFile {
  const at = path.lastIndexOf('/')
  return { ...(linkId ? { linkId } : {}), name: plainLabel(path.slice(at + 1), 255), place: plainLabel(placeWords(db, at > 0 ? path.slice(0, at) : '', L, me), 500) }
}

/** A person or group as a card row: a person's picture version, a group's size now (the whole team: its active members
 * who are not guests). */
export function cardWho(db: Database, w: CardSubject): ShareCardWho {
  const name = plainLabel(w.name, 200)
  if (w.subjectType === 'user') {
    const v = (db.query('SELECT avatar_version v FROM user_profiles WHERE user_id = ?').get(w.subjectId) as { v: number | null } | null)?.v
    return { subjectType: 'user', subjectId: w.subjectId, name, ...(v ? { avatarVersion: v } : {}) }
  }
  if (w.subjectId === FILE_SHARE_EVERYONE) {
    const n = (db.query("SELECT COUNT(*) n FROM users WHERE status = 'active' AND deleted_at IS NULL AND guest = 0").get() as { n: number }).n
    return { subjectType: 'group', subjectId: w.subjectId, name, everyone: true, members: n }
  }
  const n = (db.query("SELECT COUNT(*) n FROM group_members m JOIN users u ON u.id = m.user_id WHERE m.group_id = ? AND u.status = 'active' AND u.deleted_at IS NULL").get(w.subjectId) as { n: number }).n
  return { subjectType: 'group', subjectId: w.subjectId, name, members: n }
}

/** The people rows of a card, the first SHARE_CARD_PEOPLE_MAX and how many more. */
export function cardPeople(db: Database, who: readonly CardSubject[]): Pick<ShareCardAsk, 'who' | 'whoMore' | 'whoKey'> {
  const more = who.length - SHARE_CARD_PEOPLE_MAX
  // (more people than the card lists: their digest is part of the card, so a yes never reaches someone swapped in among
  // the ones it counts but does not show, chat/open-questions.ts sameCard; security review)
  const key = () => createHash('sha256').update(who.map((w) => `${w.subjectType}:${w.subjectId}`).sort().join('\n')).digest('hex').slice(0, 32)
  return { who: who.slice(0, SHARE_CARD_PEOPLE_MAX).map((w) => cardWho(db, w)), ...(more > 0 ? { whoMore: more, whoKey: key() } : {}) }
}

/** After a stop of several files: each person who can still open some of them, once, with how many files and through
 * what (the route of the first file found; a folder's rules before a group, a group before the whole team). */
export function cardStill(perFile: readonly StillOpens[][]): Pick<StepShared, 'still' | 'stillMore'> {
  const rank = { folder: 0, group: 1, everyone: 2 } as const
  const by = new Map<string, ShareCardStill>()
  for (const list of perFile) for (const s of list) {
    const have = by.get(s.userId)
    const row: ShareCardStill = { userId: s.userId, name: plainLabel(s.name, 200), ...(s.avatarVersion ? { avatarVersion: s.avatarVersion } : {}), through: s.through.kind, ...(s.through.kind === 'group' ? { group: plainLabel(s.through.name, 200) } : {}), files: (have?.files ?? 0) + 1 }
    by.set(s.userId, have && rank[have.through] <= rank[row.through] ? { ...have, files: row.files } : row)
  }
  const all = [...by.values()]
  if (!all.length) return {}
  const more = all.length - SHARE_CARD_STILL_MAX
  return { still: all.slice(0, SHARE_CARD_STILL_MAX), ...(more > 0 ? { stillMore: more } : {}) }
}

/** Whose file it is, for the card, when it is not the asker's own. */
export function cardOwner(owner: { id: string; name: string } | null | undefined, me: string): StepShared['owner'] | undefined {
  return owner && owner.id !== me ? { id: owner.id, name: plainLabel(owner.name, 200) } : undefined
}

/** The file's link id for a card (made on first use, as Copy link does), or null when the asker cannot open the file. */
export function cardLink(shares: FileShares, userId: string, path: string): string | null {
  try { return shares.linkFor(userId, path).id } catch { return null }
}

/** The line every share tool's result ends with once its card exists (the AI then says one short sentence). */
export const CARD_SAYS_IT = 'The user sees a card under your answer with the files, where they are, the people and a button, written by the app. Answer in one short sentence ("Done, Jun can view it now."); do not repeat the file names, places, links or the list of people.'
