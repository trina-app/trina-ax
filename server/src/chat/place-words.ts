// A team path as a card says it to a person (docs/DECISIONS.md "Plain words in errors, cards and steps"): the top folders
// by the words the Files screen uses (전사 공유, 부서, 프로젝트, 팀 스킬: shared/src/folder-labels.ts labeledPath), the
// person's own folder as 내 폴더 and what they attached to a chat as 첨부한 파일 (shared/src/step-labels.ts placeName),
// another person's folder by that person's name, and the team folder's top in words. Every folder below them keeps its
// own name, and two places must never read the same (a card is where the person decides): two people of the same name
// are told apart by their user name, and a folder at the top whose name is one of these words is said after the team
// folder's top ("팀 폴더 맨 위 › 내 폴더"). The disk path stays in what the AI reads and in the activity log.
import type { Database } from 'bun:sqlite'
import { labeledPath, OWN_FOLDER_LABEL, placeName, STEP_PLACE, TOP_FOLDER_LABELS, TOP_FOLDERS } from '@mycel/shared'
import type { Locale } from '@mycel/shared/api'
import { TEXT, tr } from './i18n'

const SEP = ' › '
const norm = (s: string) => s.normalize('NFC').trim().toLowerCase()
/** every word a card uses for a place, in every language: a folder of that name at the top would read like the place */
const PLACE_WORDS = new Set([
  ...Object.values(TOP_FOLDER_LABELS).flatMap((x) => Object.values(x)),
  ...Object.values(OWN_FOLDER_LABEL),
  ...Object.values(STEP_PLACE).flatMap((x) => Object.values(x)).filter((w) => !w.includes('{')),
  ...Object.values(TEXT.placeTop),
].map(norm))
/** "<name>님의 폴더" and its other languages, as a pattern (from placeOther itself) */
const otherFolder = new RegExp(Object.values(TEXT.placeOther).map((w) => `^${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\{name\\}', '.+')}$`).join('|'))

export function placeWords(db: Database, path: string, L: Locale, me: string): string {
  const segs = path.normalize('NFC').split('/').filter(Boolean)
  if (!segs.length) return tr('placeTop', L)
  // a path that steps up or stays put ("a/../b") is shown as it was given: words would hide where it really goes
  if (segs.some((s) => s === '.' || s === '..')) return path
  const [top, who, sub] = segs
  if (top === 'users' && who) {
    if (who === me) return sub === '.attachments' && segs[3] ? placeName(segs.join('/'), L) ?? labeledPath(segs.join('/'), L, me, SEP) : labeledPath(segs.join('/'), L, me, SEP)
    const u = db.query('SELECT name, username FROM users WHERE id = ?').get(who) as { name: string; username: string } | null
    if (u) {
      const twin = !!db.query('SELECT 1 FROM users WHERE name = ? AND id <> ? LIMIT 1').get(u.name, who)
      return [tr('placeOther', L, { name: twin ? `${u.name} (${u.username})` : u.name }), ...segs.slice(2)].join(SEP)
    }
  }
  // a folder at the top named like a place ("내 폴더", "전사 공유", "Bob님의 폴더"): after the top, so it reads as itself
  if (!(TOP_FOLDERS as readonly string[]).includes(top!) && (PLACE_WORDS.has(norm(top!)) || otherFolder.test(top!.normalize('NFC')))) return [tr('placeTop', L), ...segs].join(SEP)
  return labeledPath(segs.join('/'), L, me, SEP)
}
