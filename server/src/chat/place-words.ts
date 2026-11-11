// A team path as a card says it to a person (docs/DECISIONS.md "Plain words in errors, cards and steps"): the top folders
// by the words the Files screen uses (전사 공유, 부서, 프로젝트, 팀 스킬: shared/src/folder-labels.ts labeledPath), the
// person's own folder as 내 폴더 and what they attached to a chat as 첨부한 파일 (shared/src/step-labels.ts placeName),
// another person's folder by that person's name, and the team folder's top in words. Every folder below them keeps its
// own name, so two places never read the same (a card is where the person decides). The disk path stays in what the
// AI reads and in the activity log.
import type { Database } from 'bun:sqlite'
import { labeledPath, placeName } from '@mycel/shared'
import type { Locale } from '@mycel/shared/api'
import { tr } from './i18n'

const SEP = ' › '

export function placeWords(db: Database, path: string, L: Locale, me: string): string {
  const segs = path.normalize('NFC').split('/').filter(Boolean)
  if (!segs.length) return tr('placeTop', L)
  // a path that steps up or stays put ("a/../b") is shown as it was given: words would hide where it really goes
  if (segs.some((s) => s === '.' || s === '..')) return path
  const [top, who, sub] = segs
  if (top === 'users' && who) {
    if (who === me) return sub === '.attachments' && segs[3] ? placeName(segs.join('/'), L) ?? labeledPath(segs.join('/'), L, me, SEP) : labeledPath(segs.join('/'), L, me, SEP)
    const name = (db.query('SELECT name FROM users WHERE id = ?').get(who) as { name: string } | null)?.name
    if (name) return [tr('placeOther', L, { name }), ...segs.slice(2)].join(SEP)
  }
  return labeledPath(segs.join('/'), L, me, SEP)
}
