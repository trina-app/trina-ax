// "No card after an explicit ask" for saving, moving and copying to a place the person named (docs/decisions/
// 20261122-ask-less-explicit-save.md, QA TC-ask2-2, -8, -13): the wider-audience save card (chat/turn.ts
// confirmWidening) and the move / copy card whose people grow (tools/file-moves.ts) are skipped when the asker's own
// message of this turn asks to save, move, copy, make or put something there and names that place. The same rule and
// exclusions as docs/decisions/20261116-no-card-after-explicit-ask.md (chat/shared-actions.ts): deterministic, from the
// person's own words only (quoted lines left out, no "don't"), never in a chat with other people's words, a room read,
// a scheduled run, Slack, a restricted or template run, a confidential chat, or a message the app sent for them. When
// unsure, the card stays. Korean and other non-Latin words as escapes (no Korean text outside the language tables).
import type { Database } from 'bun:sqlite'
import fs from 'node:fs'
import nodePath from 'node:path'
import { TOP_FOLDER_LABELS } from '@mycel/shared'
import type { FileService } from '../files/service'
import { siblingVisible } from '../policy/authorize'
import { inSkills } from '../skills/guard'
import { withoutQuoteLines } from './read-rooms'
import { actionOff, fold, fromAsker, namedInFull, othersWordsIn, ownWords, saysDont } from './shared-actions'
import type { TurnExec } from './turn'

const re = (parts: string[]) => new RegExp(parts.join('|'), 'iu')
// Korean request endings (shared-actions.ts ASK_END) and "해 둬" (keep it there)
const ASK_END = '\\s?(?:\\uC918|\\uC8FC\\uC138\\uC694|\\uC8FC\\uC2DC\\uACA0|\\uC8FC\\uC2ED\\uC2DC\\uC624|\\uB2EC\\uB77C)'
const KEEP_END = `(?:${ASK_END}|\\s?\\uB46C|\\s?\\uB450\\uC138\\uC694)`
/** save, move, copy, make or put something somewhere, as a request: 저장해줘, 보관해줘, 복사해줘, 옮겨줘, 넣어줘, 만들어줘,
 * 담아줘 (also "… 둬"); the verb alone in English (save / store / put / move / copy / make / create / add), id, es; ja,
 * zh alike. The place is matched apart from it, in the same clause and close by (asksToPlaceIn), so "make it in
 * English" is no place. */
export const PLACE_ASK = re([
  `(?:\\uC800\\uC7A5|\\uBCF4\\uAD00|\\uBCF5\\uC0AC)\\s?\\uD574${KEEP_END}`,
  `(?:\\uC62E\\uACA8|\\uB123\\uC5B4|\\uB9CC\\uB4E4\\uC5B4|\\uB2F4\\uC544)${KEEP_END}`,
  '\\b(?:save|store|put|move|copy|create|make|add)\\b',
  '\\b(?:simpan|pindahkan|salin|buat)(?:kan)?\\b',
  '\\b(?:guarda|guardar|mueve|mover|copia|copiar|crea|crear)\\b',
  // ja: 保存して, 移動して, コピーして, 作って, 入れて
  '\\u4FDD\\u5B58\\u3057\\u3066', '\\u79FB\\u52D5\\u3057\\u3066', '\\u30B3\\u30D4\\u30FC\\u3057\\u3066', '\\u4F5C\\u3063\\u3066', '\\u5165\\u308C\\u3066',
  // zh: 保存到, 存到, 移到, 复制到, 放到
  '\\u4FDD\\u5B58\\u5230', '\\u5B58\\u5230', '\\u79FB\\u5230', '\\u590D\\u5236\\u5230', '\\u653E\\u5230',
])
/** "에 대해 / 에 대한 / 에 관해 / 에 관한" right after 에: a topic, not a place ("프로젝트에 대해 만들어줘") */
const NOT_TOPIC = '(?!\\s?(?:\uB300\uD574|\uB300\uD55C|\uAD00\uD574|\uAD00\uD55C))'
/** the project as a place: 프로젝트에 / 프로젝트 폴더에 / 프로젝트 안에 / 프로젝트로; in / to / into the project */
const PROJECT_PLACE = re([
  `\uD504\uB85C\uC81D\uD2B8(?:\\s?\uD3F4\uB354)?\\s?(?:\uC5D0\uB2E4\uAC00|\uC5D0\uB2E4|\uC548\uC5D0|\uC5D0${NOT_TOPIC}|\uC73C\uB85C|\uB85C)`,
  '\\b(?:to|in|into|under)\\s+(?:the\\s+|this\\s+|our\\s+)?project(?:\\s+folder)?\\b',
])
/** everyone in the team should see it, as a seeing or saving phrase (an everyone-word alone, "다들 뭐라고 했는지" or
 * "what everyone said", is no place): 모두가 / 팀원들도 / 다들 / 누구나 / 전 직원 … 볼 수 있게 / 보게 / 보도록 / 열 수 있게;
 * 전사(공유)에 / 전사로; for everyone to see, where / so everyone can see, visible to everyone; id, ja, zh alike */
const WHO_ALL = '(?:\uD300\uC6D0\\s?(?:\uB4E4)?|\uBAA8\uB450|\uB2E4\uB4E4|\uB204\uAD6C\uB098|\uC804\\s?\uC9C1\uC6D0|\uD68C\uC0AC\\s?\uC0AC\uB78C\\s?(?:\uB4E4)?|\uBAA8\uB4E0\\s?(?:\uC0AC\uB78C|\uD300\uC6D0|\uC9C1\uC6D0)\\s?(?:\uB4E4)?|\uD300\\s?\uC804\uCCB4|\uD68C\uC0AC\\s?\uC804\uCCB4)'
const SEE_KO = '(?:\uBCFC\\s?\uC218\\s?\uC788|\uBCF4\uAC8C|\uBCF4\uB3C4\uB85D|\uBCF4\uC774\uAC8C|\uBCF4\uC774\uB3C4\uB85D|\uC5F4\\s?\uC218\\s?\uC788|\uC5F4\uC5B4\\s?\uBCFC|\uD655\uC778\uD560\\s?\uC218\\s?\uC788)'
const WHO_EN = '(?:everyone|everybody|the (?:whole|entire) (?:team|company)|all staff|all members|the team)'
const EVERYONE_SEE = re([
  `${WHO_ALL}\\s?(?:\uC774|\uAC00|\uB3C4|\uC5D0\uAC8C|\uD55C\uD14C)?\\s?(?:\uB2E4\\s?)?${SEE_KO}`,
  `\uC804\uC0AC\\s?(?:\uACF5\uC720)?\\s?(?:\uD3F4\uB354)?\\s?(?:\uC5D0\uB2E4\uAC00|\uC5D0\uB2E4|\uC5D0${NOT_TOPIC}|\uB85C)`,
  `\\bfor ${WHO_EN} to (?:see|read|open|view)\\b`,
  `\\b(?:where|so|so that) ${WHO_EN} (?:can|could|will|may) (?:see|read|open|view)\\b`,
  `\\b(?:visible|available|open) to ${WHO_EN}\\b`,
  '\\b(?:to|in|into) (?:the )?company-wide\\b',
  '\\bagar semua orang (?:bisa|dapat) (?:lihat|melihat|membaca|buka)\\b',
  '(?:\\u5168\\u54E1|\\u307F\\u3093\\u306A)(?:\\u304C|\\u306B)?(?:\\u898B|\\u95B2\\u89A7)',
  '(?:\\u5927\\u5BB6|\\u6240\\u6709\\u4EBA)\\u90FD?(?:\\u80FD|\\u53EF\\u4EE5)(?:\\u770B|\\u67E5\\u770B)',
])
/** a topic, not a place: "X에 대해 / 에 대한 / 에 관해 / 에 관한", about / regarding X: left out before a name is matched */
const TOPIC = /[\p{L}\p{N}_.-]+\s?\uC5D0\s?(?:\uB300\uD574|\uB300\uD55C|\uAD00\uD574|\uAD00\uD55C)|\b(?:about|regarding|concerning)\s+(?:the\s+|our\s+|this\s+)?[\p{L}\p{N}_.-]+/giu
/** the place and the request word: in one clause (no sentence break between) and at most this many characters apart */
const NEAR = 40
/** sentence breaks: . ! ? (before a space or the end, never inside report.md), a line break, 。！？ */
const BREAK = /[.!?](?=\s|$)|[\n\u3002\uFF01\uFF1F]/u

/** What says the destination folder in a person's words: its shown names, and whether it is the chat's own project
 * folder or the company-wide folder (shared/). */
export interface PlaceFacts { names: readonly string[]; project?: boolean; everyone?: boolean }

/** `text` around [from, to) with `NEAR` characters each side, widened to whole words */
function around(text: string, from: number, to: number): string {
  let a = Math.max(0, from - NEAR), b = Math.min(text.length, to + NEAR)
  while (a > 0 && !/\s/u.test(text[a - 1]!)) a--
  while (b < text.length && !/\s/u.test(text[b]!)) b++
  return text.slice(a, b)
}

/**
 * Does the person's message (as they wrote it) ask to save, move or copy to the destination `f` describes? Quoted lines
 * are left out; a "don't" anywhere fails it; in one clause, the request word and, close to it (NEAR), the place: the
 * folder by a shown name in full as a place ("마케팅에", "to Marketing"), "프로젝트에"/"in the project" for the chat's
 * own project folder, or a seeing / saving phrase for everyone ("모두가 볼 수 있게", "for everyone to see") for the
 * company-wide folder. A topic ("에 대해", "about") is no place. Pure; fails closed.
 */
export function asksToPlaceIn(said: string, f: PlaceFacts): boolean {
  const own = ownWords(withoutQuoteLines(said ?? ''))
  if (!own.trim() || !PLACE_ASK.test(own) || saysDont(own)) return false
  const verbs = new RegExp(PLACE_ASK.source, 'giu')
  for (const clause0 of own.split(BREAK)) {
    const clause = fold(clause0).replace(TOPIC, ' ')
    for (const m of clause.matchAll(verbs)) {
      const near = around(clause, m.index!, m.index! + m[0].length)
      if (f.names.length && namedInFull(near, f.names, { place: true })) return true
      if (f.project && PROJECT_PLACE.test(near)) return true
      if (f.everyone && EVERYONE_SEE.test(near)) return true
    }
  }
  return false
}

/** How many folders `user` can see (the file screen's siblingVisible) are named `name` (folded): a walk of folders
 * only, at most FOLDER_SCAN of them; a cut walk counts as "more than one" (fails closed). */
const FOLDER_SCAN = 5000
export function visibleFoldersNamed(files: Pick<FileService, 'fx' | 'rules' | 'principal'>, userId: string, name: string): number {
  const want = fold(name)
  const user = files.principal(userId)
  const rules = files.rules()
  const queue: string[][] = [[]]
  let n = 0
  for (let seen = 0; queue.length; seen++) {
    if (seen >= FOLDER_SCAN) return Infinity
    const dir = queue.shift()!
    let list: fs.Dirent[]
    try { list = fs.readdirSync(nodePath.join(files.fx.root, ...dir), { withFileTypes: true }) } catch { continue }
    for (const e of list) {
      if (!e.isDirectory() || !siblingVisible(files.fx, rules, user, dir, e.name)) continue
      if (fold(e.name) === want && ++n > 1) return n
      queue.push([...dir, e.name])
    }
  }
  return n
}

/** The facts of the destination folder `dir` (a team path) for this chat: its own name (a folder at the top by the
 * Files screen's words: 전사 공유, Company-wide), its project's name when it is a project's folder, whether it is the
 * chat's project folder, whether it is the company-wide folder itself. With `seen` (the person and the files), a
 * folder's own name counts only when it is the one folder of that name they can see, and a project's name only when
 * no other live project has it (two "마케팅" folders: the name does not say which, so the card stays). */
export function placeFacts(db: Database, chatId: string, dir: string, seen?: { files: Pick<FileService, 'fx' | 'rules' | 'principal'>; userId: string }): PlaceFacts {
  const segs = dir.split('/').filter(Boolean)
  const names = new Set<string>()
  const top = segs[0]
  if (segs.length === 1 && top === 'shared') for (const w of Object.values(TOP_FOLDER_LABELS.shared)) names.add(w)
  // a folder below the top folders (never "users/<id>": an id is nobody's word for a place)
  else if (segs.length >= 2 && !(top === 'users' && segs.length === 2)) {
    const last = segs.at(-1)!
    if (!seen || visibleFoldersNamed(seen.files, seen.userId, last) === 1) names.add(last)
  }
  const path = segs.join('/')
  for (const p of db.query('SELECT name FROM projects WHERE folder_path = ? AND trashed_with IS NULL').all(path) as { name: string }[]) {
    const name = p.name?.trim()
    if (!name) continue
    const same = (db.query('SELECT COUNT(*) AS n FROM projects WHERE trashed_with IS NULL AND lower(trim(name)) = lower(?)').get(name) as { n: number }).n
    if (!seen || same <= 1) names.add(name)
  }
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
    return asksToPlaceIn(m.content ?? '', placeFacts(db, exec.spec.chatId, path.join('/'), { files: exec.rt.files, userId: exec.spec.userId }))
  } catch { return false }
}

/**
 * explicitPlaceAsk for a move or a copy of `paths` (tools/file-moves.ts): the place must be the asker's word and so must
 * the files: each one attached to their message, named in it (quoted lines left out) or made by the AI in this answer
 * (shared-actions.ts fromAsker). "Move it to Company-wide" after the AI picked files the person never named keeps the
 * card. Fails closed.
 */
export function explicitPlaceFor(exec: PlaceExec, dir: string, paths: readonly string[]): boolean {
  try { return !!paths.length && explicitPlaceAsk(exec, dir) && fromAsker(exec.rt.db, exec.spec, paths) } catch { return false }
}
