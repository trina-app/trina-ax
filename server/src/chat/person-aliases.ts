// Titles, roles and the names a person calls teammates by (docs/decisions/20261123-do-then-undo.md; the owner, 2026-11-23:
// "7번이나 묻는건 좀 그런거 아냐?"). "이거 팀장님한테 보내줘" names a person when the team's directory says who that is:
// the teammate whose profile title holds the word (user_profiles.title), else for an owner word the team's owner, else
// for a lead word the project's creator (in a project chat) or the one owner or admin. Exactly one match counts as the
// person's own naming of that teammate (rooms/reader.ts findPeople returns them, with how). Several or none: the AI asks
// once; the person's answer is kept as an alias (person_aliases, migration 445) and used before asking next time, in
// every chat, until the person deletes it in Settings › Allowed for Trina (kind person_alias).
//
// Learning the answer, without a tool of its own: the call that could not tell (notePending) and the person's own words
// of the last few messages are the server's; the next call that names exactly one teammate by name or id in that chat,
// within a short time, is the answer (learnAlias). A wrong one is one press to delete in Settings, and a send to the
// person it names still shows who it went to with its undo.
//
// Matching data, not screen text (no Korean on screen from here).
import type { Database } from 'bun:sqlite'

/** Titles that mean the team's head: the owner. */
const OWNER_WORDS = ['대표', '대표이사', '사장', '사장님', 'ceo', 'owner', 'founder', '社長', '代表', '代表取締役', '老板', '总裁', '总经理', 'presidente', 'dueño', 'dueña', 'pemilik', 'direktur utama']
/** Titles that mean someone above the person: their lead or manager. */
const LEAD_WORDS = ['팀장', '부장', '실장', '본부장', '파트장', '그룹장', '센터장', '과장', '차장', '이사', '상무', '전무', '매니저', '리더', '상사', '사수',
  'manager', 'boss', 'lead', 'teamlead', 'teamleader', 'leader', 'supervisor', 'director', 'head', 'headofteam',
  '部長', '課長', '上司', 'リーダー', 'マネージャー', '主任', '室長', '经理', '主管', '组长', '领导', '负责人',
  'jefe', 'jefa', 'gerente', 'director', 'directora', 'supervisora', 'líder', 'atasan', 'manajer', 'bos', 'kepala', 'pimpinan', 'ketua']
const TITLE_WORDS = new Set([...OWNER_WORDS, ...LEAD_WORDS].map((w) => w.normalize('NFC').toLowerCase().replace(/\s+/g, '')))
const OWNER_SET = new Set(OWNER_WORDS.map((w) => w.normalize('NFC').toLowerCase().replace(/\s+/g, '')))
/** Words around a title that do not change who it is: an honorific, "my", "our", Korean particles after it */
const BEFORE = /^(my|our|the|우리|제|내|저희|mi|nuestro|nuestra|saya|私の|我的)\s*/iu
const AFTER = /(님께서|님한테|님에게|님께|님이|님은|님을|님의|님도|님|씨|한테|에게|께|さん|様|さま|先生)$/u

/** A title or role as matched ("팀장님" → "팀장", "my manager" → "manager"), or null when `ref` is not one. */
export function titleKey(ref: string): string | null {
  let v = ref.normalize('NFC').trim().toLowerCase().replace(/^@+/, '')
  v = v.replace(BEFORE, '')
  for (let i = 0; i < 2; i++) v = v.replace(AFTER, '').trim()
  v = v.replace(/\s+/g, '')
  return TITLE_WORDS.has(v) ? v : null
}
export const isOwnerTitle = (key: string): boolean => OWNER_SET.has(key)

const MULTI: Record<string, string> = { teamlead: 'team[\\s-]*lead', teamleader: 'team[\\s-]*leader', headofteam: 'head\\s+of\\s+(the\\s+)?team' }
/** Every title the text uses ("이거 팀장님한테 보내줘" → ["팀장"]): the longest word at each place, as matched. */
export function titlesIn(text: string): string[] {
  const t = text.normalize('NFC').toLowerCase()
  const squashed = t.replace(/\s+/g, '')
  const out = new Set<string>()
  for (const w of TITLE_WORDS) {
    // a Latin word as a whole word (in the text with its spaces), any other script as a part of the words
    // (a title of two words, "team lead", with its space or hyphen)
    if (/^[a-z]+$/.test(w)) { if (new RegExp(`(?<![a-z])${MULTI[w] ?? w}(?![a-z])`).test(t)) out.add(w) }
    else if (squashed.includes(w)) out.add(w)
  }
  // a shorter word inside a longer one found ("이사" in "대표이사") is that one
  return [...out].filter((w) => ![...out].some((o) => o !== w && o.includes(w)))
}

/** The teammate the person calls `ref` by (their alias), or null. Only an active person of this team. */
export function aliasOf(db: Database, userId: string, ref: string): string | null {
  const key = titleKey(ref)
  if (!key) return null
  try {
    const r = db.query("SELECT a.target_id AS id FROM person_aliases a JOIN users u ON u.id = a.target_id WHERE a.user_id = ? AND a.ref = ? AND u.status = 'active' AND u.deleted_at IS NULL").get(userId, key) as { id: string } | null
    return r?.id ?? null
  } catch { return null }
}

export function setAlias(db: Database, userId: string, key: string, targetId: string): void {
  if (targetId === userId || !TITLE_WORDS.has(key)) return
  try {
    db.query('INSERT INTO person_aliases (user_id, ref, target_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, ref) DO UPDATE SET target_id = excluded.target_id, created_at = excluded.created_at').run(userId, key, targetId, new Date().toISOString())
  } catch { /* the table is missing on an older database: nothing kept, the AI asks next time */ }
}

/** Settings › Allowed for Trina: the person's aliases (id `alias:<ref>`), newest first. */
export function listAliases(db: Database, userId: string): { kind: 'person_alias'; id: string; ref: string; person: { id: string; name: string }; createdAt: string }[] {
  try {
    return (db.query("SELECT a.ref, a.target_id, a.created_at, u.name FROM person_aliases a JOIN users u ON u.id = a.target_id WHERE a.user_id = ? AND u.deleted_at IS NULL ORDER BY a.created_at DESC").all(userId) as { ref: string; target_id: string; created_at: string; name: string }[])
      .map((r) => ({ kind: 'person_alias' as const, id: `alias:${r.ref}`, ref: r.ref, person: { id: r.target_id, name: r.name }, createdAt: r.created_at }))
  } catch { return [] }
}

export function dropAlias(db: Database, userId: string, id: string): boolean {
  if (!id.startsWith('alias:')) return false
  try { return db.query('DELETE FROM person_aliases WHERE user_id = ? AND ref = ?').run(userId, id.slice('alias:'.length)).changes > 0 } catch { return false }
}

/** A title the server could not tell (none or several matched), kept for a short time per person: the next call that
 * names exactly one of the candidates (any teammate when none matched) is the person's answer. In memory: a restart
 * forgets it, and the AI then asks once more. */
const PENDING_MS = 30 * 60_000
const pending = new Map<string, { key: string; candidates: string[]; at: number }>()
export function notePending(userId: string, key: string, candidates: readonly string[]): void {
  pending.set(userId, { key, candidates: [...candidates], at: Date.now() })
}

/**
 * Exactly one teammate was named by name or id (not by a title): if that answers a title the server could not tell for
 * this person a moment ago (notePending), or a title in the person's own last few messages of this chat that does not
 * resolve to one teammate, keep it as their alias. Returns the title kept, or null. `unique(key)`: does the title resolve
 * to exactly one teammate now (then nothing is learned: the directory already says who).
 */
export function learnAlias(db: Database, userId: string, target: { id: string; name: string }, o: { chatId?: string | null; unique: (key: string) => boolean }): string | null {
  if (target.id === userId) return null
  const p = pending.get(userId)
  if (p && Date.now() - p.at < PENDING_MS && (!p.candidates.length || p.candidates.includes(target.id))) {
    pending.delete(userId)
    if (aliasOf(db, userId, p.key) !== target.id) setAlias(db, userId, p.key, target.id)
    return p.key
  }
  if (!o.chatId) return null
  let rows: { content: string }[] = []
  try {
    const since = new Date(Date.now() - PENDING_MS).toISOString()
    rows = db.query("SELECT content FROM messages WHERE chat_id = ? AND role = 'user' AND auto_sent = 0 AND (author_id IS NULL OR author_id = ?) AND created_at >= ? ORDER BY created_at DESC LIMIT 2").all(o.chatId, userId, since) as { content: string }[]
  } catch { return null }
  // (quoted lines are someone else's words)
  const own = (t: string) => t.split('\n').filter((l) => !/^\s*>/.test(l)).join('\n')
  const open = (t: string) => titlesIn(own(t)).filter((k) => !o.unique(k) && !aliasOf(db, userId, k))
  const names = (t: string) => { const n = target.name.normalize('NFC').toLowerCase().replace(/\s+/g, ''); return n.length >= 2 && own(t).normalize('NFC').toLowerCase().replace(/\s+/g, '').includes(n) }
  const latest = rows[0]?.content ?? ''
  const here = open(latest)
  // the title is in this turn's message and the teammate is not: the person answered the AI's question on a card
  if (here.length === 1 && titlesIn(own(latest)).length === 1 && !names(latest)) { setAlias(db, userId, here[0]!, target.id); return here[0]! }
  // this message only names the teammate (an answer: no title, no ask to send), the one before used the title
  const before = rows[1] ? open(rows[1].content) : []
  if (!titlesIn(own(latest)).length && !SENDS.test(own(latest)) && names(latest) && before.length === 1) { setAlias(db, userId, before[0]!, target.id); return before[0]! }
  return null
}
/** an ask to send or share in a message (then it is a new request, not an answer to "who is that?") */
const SENDS = /보내|올려|전달|공유|send|post|share|forward|kirim|bagikan|送って|共有|发给|分享|env[ií]a|compart/iu

/** "팀원들", "team members", "우리 팀": everyone on the person's team here, resolved by the caller (the project's
 * people, the one group, or the shared chat's people: chat/share-folder.ts teamPeople). */
const TEAM_WORDS = new Set(['팀원', '팀원들', '팀원분들', '우리팀', '팀사람들', '팀전체', '동료', '동료들', '팀', 'teammates', 'teammembers', 'myteam', 'theteam', 'ourteam', 'team', 'everyoneontheteam',
  'チームメンバー', 'チームのみんな', 'メンバー', '团队成员', '同事', '团队', 'compañeros', 'miequipo', 'elequipo', 'equipo', 'anggotatim', 'timsaya', 'tim'].map((w) => w.normalize('NFC').toLowerCase()))
export function isTeamRef(ref: string): boolean {
  let v = ref.normalize('NFC').trim().toLowerCase().replace(BEFORE, '')
  for (let i = 0; i < 2; i++) v = v.replace(AFTER, '').trim()
  v = v.replace(/\s+/g, '')
  return TEAM_WORDS.has(v)
}

/** The person's own words use the title a teammate was found by (Teammate.via): that counts as naming them, as a name in
 * full does (the explicit-ask rules of the tools that send or share). */
export function saysTitle(said: string, via: { ref: string } | undefined): boolean {
  if (!via) return false
  const own = said.split('\n').filter((l) => !/^\s*>/.test(l)).join('\n')
  return titlesIn(own).includes(via.ref)
}

/** A pick card answered for a title (several could be meant): kept as the person's alias, so it is not asked again. */
export function keepPick(db: Database, userId: string, ref: string, pickedId: string): string | null {
  const key = titleKey(ref)
  if (!key) return null
  setAlias(db, userId, key, pickedId)
  pending.delete(userId)
  return key
}

/** The person's own words say "팀원들", "my team" …: a word of TEAM_WORDS as a word of the text (a Korean particle after
 * it left out), never a part of another word ("팀" in "팀장"). */
export function saysTeam(said: string): boolean {
  const own = said.split('\n').filter((l) => !/^\s*>/.test(l)).join('\n').normalize('NFC').toLowerCase()
  const words = own.split(/[\s,.!?;:·()"'“”‘’「」]+/u).filter(Boolean)
  for (let i = 0; i < words.length; i++) {
    if (isTeamRef(words[i]!) || isTeamRef(words[i]!.replace(/(한테|에게|께|들한테|들에게|이랑|하고|과|와|을|를|은|는|이|가)$/u, ''))) return true
    if (i + 1 < words.length && isTeamRef(`${words[i]}${words[i + 1]}`)) return true
  }
  return false
}
