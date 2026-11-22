// "No card after an explicit ask" for saving, moving and copying to a place the person named (docs/decisions/
// 20261122-ask-less-explicit-save.md, QA TC-ask2-2, -8, -13): the wider-audience save card (chat/turn.ts
// confirmWidening) and the move / copy card whose people grow (tools/file-moves.ts) are skipped when the asker's own
// message of this turn asks to save, move, copy, make or put something there and names that place. The same rule and
// exclusions as docs/decisions/20261116-no-card-after-explicit-ask.md (chat/shared-actions.ts): deterministic, from the
// person's own words only (quoted lines left out, no "don't"), never in a chat with other people's words, a room read,
// a scheduled run, Slack, a restricted or template run, a confidential chat, or a message the app sent for them. When
// unsure, the card stays. Korean and other non-Latin words as escapes (no Korean text outside the language tables).
import type { Database } from 'bun:sqlite'
import { TOP_FOLDER_LABELS } from '@mycel/shared'
import { inSkills } from '../skills/guard'
import { withoutQuoteLines } from './read-rooms'
import { actionOff, fold, namedInFull, othersWordsIn, ownWords, saysDont } from './shared-actions'
import type { TurnExec } from './turn'

const re = (parts: string[]) => new RegExp(parts.join('|'), 'iu')
// Korean request endings (shared-actions.ts ASK_END) and "해 둬" (keep it there)
const ASK_END = '\\s?(?:\\uC918|\\uC8FC\\uC138\\uC694|\\uC8FC\\uC2DC\\uACA0|\\uC8FC\\uC2ED\\uC2DC\\uC624|\\uB2EC\\uB77C)'
const KEEP_END = `(?:${ASK_END}|\\s?\\uB46C|\\s?\\uB450\\uC138\\uC694)`
/** save, move, copy, make or put something somewhere, as a request: 저장해줘, 보관해줘, 복사해줘, 옮겨줘, 넣어줘, 만들어줘,
 * 담아줘 (also "… 둬"); save / store / put / move / copy / make / create / add … to / in / into; id, ja, es, zh alike */
export const PLACE_ASK = re([
  `(?:\\uC800\\uC7A5|\\uBCF4\\uAD00|\\uBCF5\\uC0AC)\\s?\\uD574${KEEP_END}`,
  `(?:\\uC62E\\uACA8|\\uB123\\uC5B4|\\uB9CC\\uB4E4\\uC5B4|\\uB2F4\\uC544)${KEEP_END}`,
  '\\b(?:save|store|put|move|copy|create|make|add)\\b[^\\n]{0,80}\\b(?:to|in|into|under|inside)\\b',
  '\\b(?:simpan|pindahkan|salin|buat)(?:kan)?\\b[^\\n]{0,80}\\b(?:ke|di)\\b',
  '\\b(?:guarda|guardar|mueve|mover|copia|copiar|crea|crear)\\b[^\\n]{0,80}\\b(?:en|a)\\b',
  // ja: 保存して, 移動して, コピーして, 作って, 入れて
  '\\u4FDD\\u5B58\\u3057\\u3066', '\\u79FB\\u52D5\\u3057\\u3066', '\\u30B3\\u30D4\\u30FC\\u3057\\u3066', '\\u4F5C\\u3063\\u3066', '\\u5165\\u308C\\u3066',
  // zh: 保存到, 存到, 移到, 复制到, 放到
  '\\u4FDD\\u5B58\\u5230', '\\u5B58\\u5230', '\\u79FB\\u5230', '\\u590D\\u5236\\u5230', '\\u653E\\u5230',
])
/** the project as a place: 프로젝트에 / 프로젝트 폴더에 / 프로젝트 안에 / 프로젝트로; in / to / into the project */
const PROJECT_PLACE = re([
  '\\uD504\\uB85C\\uC81D\\uD2B8(?:\\s?\\uD3F4\\uB354)?\\s?(?:\\uC5D0\\uB2E4\\uAC00|\\uC5D0\\uB2E4|\\uC5D0|\\uC548\\uC5D0|\\uC73C\\uB85C|\\uB85C)',
  '\\b(?:to|in|into|under)\\s+(?:the\\s+|this\\s+|our\\s+)?project(?:\\s+folder)?\\b',
])
/** everyone in the team should see it: 팀원들(도), 팀원 모두/전체, 전사, 모두가 / 모두 볼, 다들, 누구나, 전 직원, 회사 전체,
 * 모든 사람/팀원/직원; everyone, everybody, the whole/entire team or company, all staff, company-wide; not a bare 모두
 * or "all" ("파일 모두 옮겨줘" is all the files) */
const EVERYONE = re([
  '\\uD300\\uC6D0\\uB4E4', '\\uD300\\uC6D0\\s?(?:\\uBAA8\\uB450|\\uC804\\uCCB4|\\uB2E4)',
  '\\uC804\\uC0AC(?![\\uAC00-\\uD7A3])', '\\uC804\\uC0AC(?:\\uC5D0|\\uB85C|\\uC6D0|\\uC801|\\s?\\uACF5\\uC720)',
  '\\uBAA8\\uB450\\s?(?:\\uAC00|\\uBCFC|\\uBCF4\\uAC8C|\\uBCF4\\uB3C4\\uB85D|\\uC5F4|\\uD55C\\uD14C|\\uC5D0\\uAC8C)',
  '\\uB2E4\\uB4E4', '\\uB204\\uAD6C\\uB098', '\\uC804\\s?\\uC9C1\\uC6D0', '\\uD68C\\uC0AC\\s?(?:\\uC804\\uCCB4|\\uC0AC\\uB78C)', '\\uBAA8\\uB4E0\\s?(?:\\uC0AC\\uB78C|\\uD300\\uC6D0|\\uC9C1\\uC6D0)',
  '\\b(?:everyone|everybody|company-wide|all staff|all members)\\b', '\\b(?:the\\s+)?(?:whole|entire)\\s+(?:team|company)\\b',
  '\\bsemua orang\\b', '\\u5168\\u54E1', '\\u307F\\u3093\\u306A', '\\u6240\\u6709\\u4EBA', '\\u5927\\u5BB6',
])

/** What says the destination folder in a person's words: its shown names, and whether it is the chat's own project
 * folder or the company-wide folder (shared/). */
export interface PlaceFacts { names: readonly string[]; project?: boolean; everyone?: boolean }

/**
 * Does the person's message (as they wrote it) ask to save, move or copy to the destination `f` describes? Quoted lines
 * are left out; a "don't" anywhere fails it; the request verb and the place must both be there: the folder by a shown
 * name in full as a place ("마케팅에", "to Marketing"), "프로젝트"/"project" for the chat's own project folder, or an
 * everyone-word for the company-wide folder. Pure; fails closed.
 */
export function asksToPlaceIn(said: string, f: PlaceFacts): boolean {
  const own = ownWords(withoutQuoteLines(said ?? ''))
  if (!own.trim() || !PLACE_ASK.test(own) || saysDont(own)) return false
  if (f.names.length && namedInFull(own, f.names, { place: true })) return true
  if (f.project && PROJECT_PLACE.test(own)) return true
  return !!f.everyone && EVERYONE.test(fold(own))
}

/** The facts of the destination folder `dir` (a team path) for this chat: its own name (a folder at the top by the
 * Files screen's words: 전사 공유, Company-wide), its project's name when it is a project's folder, whether it is the
 * chat's project folder, whether it is the company-wide folder itself. */
export function placeFacts(db: Database, chatId: string, dir: string): PlaceFacts {
  const segs = dir.split('/').filter(Boolean)
  const names = new Set<string>()
  const top = segs[0]
  if (segs.length === 1 && top === 'shared') for (const w of Object.values(TOP_FOLDER_LABELS.shared)) names.add(w)
  // a folder below the top folders (never "users/<id>": an id is nobody's word for a place)
  else if (segs.length >= 2 && !(top === 'users' && segs.length === 2)) names.add(segs.at(-1)!)
  const path = segs.join('/')
  for (const p of db.query('SELECT name FROM projects WHERE folder_path = ? AND trashed_with IS NULL').all(path) as { name: string }[]) if (p.name?.trim()) names.add(p.name.trim())
  const mine = db.query('SELECT p.folder_path AS f FROM chats c JOIN projects p ON p.id = c.project_id WHERE c.id = ? AND p.trashed_with IS NULL').get(chatId) as { f: string } | null
  const project = !!mine && mine.f.split('/').filter(Boolean).join('/') === path
  return { names: [...names], project, everyone: path === 'shared' }
}

type PlaceExec = Pick<TurnExec, 'restricted' | 'templateRun' | 'spec' | 'rt' | 'shared' | 'otherAuthors' | 'roomsSeen'> & Partial<Pick<TurnExec, 'othersWords' | 'alwaysPlace'>>

/**
 * The asker's own message of this turn asked to save, move or copy into the folder `dir` and named it (asksToPlaceIn),
 * and nothing else may have chosen it: no other people's words in the chat (othersWordsIn: shared, others wrote in it,
 * rooms read, content someone else wrote), not a scheduled run, Slack, a restricted or template run or a confidential
 * chat (actionOff), not a message the app sent for them, not a skill folder or a hidden one. Fails closed.
 */
export function explicitPlaceAsk(exec: PlaceExec, dir: string): boolean {
  try {
    const path = dir.split('/').filter(Boolean)
    if (!path.length || path.some((s) => s.startsWith('.') || s === '..') || inSkills(path.join('/')) || inSkills(`${path.join('/')}/x`)) return false
    if (othersWordsIn(exec) || actionOff(exec, null)) return false
    const db = exec.rt.db
    const m = db.query('SELECT content, auto_sent FROM messages WHERE id = ?').get(exec.spec.userMessageId) as { content: string | null; auto_sent: number | null } | null
    if (!m || m.auto_sent) return false
    return asksToPlaceIn(m.content ?? '', placeFacts(db, exec.spec.chatId, path.join('/')))
  } catch { return false }
}
