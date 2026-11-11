// One shape for every refusal the AI reads back (docs/DECISIONS.md "Refusals say why, who and what next"). The owner
// (2026-11-10): "왜케 제약이 많아?? 안되는게 왜케 많은거야? 이유도 모르고?" Most limits are real, but the texts said
// neither why nor where the person could do it, and some blamed the person for a card nobody showed them ("the user did
// not allow this" in a scheduled run). Each text says:
//   1. what did not happen ("Nothing was moved.");
//   2. one reason: no permission (and who can grant it), nobody could be asked (a scheduled run), the person said no, the
//      card timed out, other people would have to agree (the room or project), a server limit (the number, when it
//      resets), or not available in this kind of chat;
//   3. one next step, with the screen's name as the person's app shows it (their language);
//   4. the folders, groups, projects and connections involved.
// Rooms and shared chats keep their rule: who cannot read what is counted, never named (DECISIONS "Never who"). "not
// found or no access" stays one answer for both (policy/authorize.ts): only a next step that says nothing about the path
// is added to it (notFoundNext).
// The texts are English (the AI's); only the screen names are in the person's language.
import type { Database } from 'bun:sqlite'
import { PRODUCT_NAMED_AFTER_AI, type Locale } from '@mycel/shared/api'

/** How a server card ended without a yes: the person's no, no answer in time, nobody to ask (a scheduled run: no card
 * was raised), or the answer stopped before anyone answered. */
export type CardEnd = 'declined' | 'timeout' | 'unattended' | 'ended'
/** How a server card ended. */
export type CardOutcome = 'yes' | CardEnd

export type RefusalReason =
  /** the person lacks the permission; `grant`: who can give it (display names), `how`: where they do it */
  | { kind: 'permission'; what?: string; grant?: readonly string[]; how?: string }
  /** nobody could be asked: no card was shown (a scheduled run, or `run`) */
  | { kind: 'unattended'; run?: string }
  /** the person said no on the card (`who`: in a shared chat, the person whose turn it is) */
  | { kind: 'declined'; who?: string }
  /** the card got no answer in time */
  | { kind: 'timeout'; who?: string }
  /** the answer stopped before the card was answered */
  | { kind: 'ended' }
  /** other people would have to agree: `where` names the room or project; `count`: how many (never who) */
  | { kind: 'others'; where: string; count?: number; what?: string }
  /** a server limit: `limit` with its number, `resets` when it resets, `setBy` who can change it */
  | { kind: 'limit'; limit: string; resets?: string; setBy?: string }
  /** not available in this kind of chat (`mode`: "a team chat room"), and why */
  | { kind: 'mode'; mode: string; why?: string }
  /** a check could not be completed: stopped to be safe, nobody refused it */
  | { kind: 'failed'; what?: string }

export interface Refusal {
  /** what did not happen: "Nothing was moved." */
  done: string
  why: RefusalReason
  /** one next step the person can take ("the user can do it on the Files screen (…)"); none when there is nothing */
  next?: string | null
  /** folders, groups, projects, connections involved (never who cannot read what in a room or a shared chat) */
  names?: readonly string[]
  /** one more instruction for the AI ("Do not try another folder.") */
  also?: string
}

const stop = (s: string) => (/[.!?]\)?$/.test(s.trim()) ? s.trim() : `${s.trim()}.`)

/** "A, B and C" (at most `max` names, then "and N more") */
export function nameList(names: readonly string[], max = 3): string {
  const n = [...new Set(names.filter(Boolean))]
  if (n.length <= 1) return n[0] ?? ''
  const shown = n.slice(0, max)
  const rest = n.length - shown.length
  if (rest > 0) return `${shown.join(', ')} and ${rest} more`
  return `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`
}

/** The reason as one sentence (no "Why:" in front). */
export function reasonText(r: RefusalReason): string {
  switch (r.kind) {
    case 'permission': {
      const grant = r.grant?.length ? `; ${nameList(r.grant)} can give it${r.how ? ` (${r.how})` : ''}` : r.how ? `; ${r.how}` : ''
      return `the user does not have permission for this${r.what ? ` (${r.what})` : ''}${grant}`
    }
    case 'unattended':
      return `nobody could be asked: this is ${r.run ?? 'a scheduled run'} with nobody watching, so no confirmation card was shown and nobody can confirm it here. The user did not refuse anything; never say they did`
    case 'declined':
      return `${r.who ?? 'the user'} did not allow it: they said no on the confirmation card`
    case 'timeout':
      return `${r.who ?? 'the user'} did not answer the confirmation card in time, so it closed without a yes. This is not a no; never say they refused`
    case 'ended':
      return 'the answer stopped before the confirmation card was answered'
    case 'others':
      return `other people would have to agree: ${r.where}${r.count !== undefined ? ` (${r.count} ${r.count === 1 ? 'person' : 'people'})` : ''}${r.what ? `, ${r.what}` : ''}`
    case 'limit':
      return `a limit of this server: ${r.limit}${r.resets ? `; it resets ${r.resets}` : ''}${r.setBy ? `; ${r.setBy} can change it` : ''}`
    case 'mode':
      return `not available in ${r.mode}${r.why ? `: ${r.why}` : ''}`
    case 'failed':
      return `the server could not complete its check${r.what ? ` (${r.what})` : ''}, so it stopped to be safe. Nobody refused it`
  }
}

/** The text the AI reads back after a refusal: what did not happen, why, the next step, the names involved. */
export function refusal(r: Refusal): string {
  return [
    stop(r.done),
    `Why: ${stop(reasonText(r.why))}`,
    r.also ? stop(r.also) : '',
    r.next ? `Next step: ${stop(r.next)}` : '',
    r.names?.length ? `Involved: ${[...new Set(r.names)].join(', ')}.` : '',
  ].filter(Boolean).join(' ')
}

/** The reason for a card that ended without a yes. `who`: who was asked (a shared chat names its asker); `run`: how an
 * unattended run is named. */
export function cardReason(end: CardEnd, o: { who?: string; run?: string } = {}): RefusalReason {
  switch (end) {
    case 'declined': return { kind: 'declined', ...(o.who ? { who: o.who } : {}) }
    case 'timeout': return { kind: 'timeout', ...(o.who ? { who: o.who } : {}) }
    case 'unattended': return { kind: 'unattended', ...(o.run ? { run: o.run } : {}) }
    case 'ended': return { kind: 'ended' }
  }
}

/** A short form for audit summaries: "not allowed by the user", "no answer in time", "nobody to ask", … */
export function cardEndShort(end: CardEnd): string {
  return end === 'declined' ? 'not allowed by the user' : end === 'timeout' ? 'no answer in time' : end === 'unattended' ? 'nobody to ask (scheduled run)' : 'the answer stopped'
}

/** The next step for a card that ended without a yes: ask again (a no or no answer), or do it in a chat (nobody to ask). */
export function cardNext(end: CardEnd, where = 'in a chat'): string {
  return end === 'unattended' ? `the user can ask for it ${where}, where they can answer the card` : end === 'declined'
    ? 'ask the user what they want instead; do not try another way that needs the same yes'
    : 'the user can ask again and answer the card'
}

// ---------------- screen names, as the person's app shows them ----------------
type L5 = Record<Locale, string>
const t = (ko: string, en: string, id: string, ja: string, es: string): L5 => ({ ko, en, id, ja, es })
// the web app's own labels (web/src/i18n: sidebar.files, files.trash, sidebar.settings, admin.title, admin.folders,
// admin.groups, rooms.title, sideChat.open, integrations.title)
const LABEL = {
  files: t('파일', 'Files', 'File', 'ファイル', 'Archivos'),
  trash: t('휴지통', 'Trash', 'Sampah', 'ゴミ箱', 'Papelera'),
  settings: t('설정', 'Settings', 'Pengaturan', '設定', 'Configuración'),
  admin: t('관리자', 'Admin', 'Admin', '管理', 'Administración'),
  folders: t('폴더 권한', 'Folder permissions', 'Izin folder', 'フォルダーの権限', 'Permisos de carpetas'),
  groups: t('부서', 'Groups', 'Grup', 'グループ', 'Grupos'),
  rooms: t('대화', 'Conversations', 'Percakapan', 'トーク', 'Conversaciones'),
  sideChat: t('✦ {name}에게 따로 묻기', '✦ Ask {name} privately', '✦ Tanya {name} secara pribadi', '✦ {name}に個別に質問', '✦ Preguntar a {name} en privado'),
  connected: t('연결한 서비스', 'Connected apps', 'Aplikasi terhubung', '連携サービス', 'Apps conectadas'),
} satisfies Record<string, L5>
// the AI's name in the side panel's button (web sideChat.open {name}; chat/i18n.ts aiCalled)
const AI_NAME = PRODUCT_NAMED_AFTER_AI ? t('트리나', 'Trina', 'Trina', 'トリナ', 'Trina') : t('AI', 'AI', 'AI', 'AI', 'IA')

/** Where a person does something themselves, by the names their app shows (`L`). */
export const SCREEN = {
  files: (L: Locale) => `the Files screen ("${LABEL.files[L]}")`,
  trash: (L: Locale) => `the Files screen's trash ("${LABEL.files[L]} › ${LABEL.trash[L]}")`,
  // the connections pages ("MCP" before #289; one name in Settings and Admin since the plain-words change)
  settingsMcp: (L: Locale) => `Settings › Connected apps ("${LABEL.settings[L]} › ${LABEL.connected[L]}")`,
  adminMcp: (L: Locale) => `Admin › Connected apps ("${LABEL.admin[L]} › ${LABEL.connected[L]}")`,
  adminFolders: (L: Locale) => `Admin › Folder permissions ("${LABEL.admin[L]} › ${LABEL.folders[L]}")`,
  adminGroups: (L: Locale) => `Admin › Groups ("${LABEL.admin[L]} › ${LABEL.groups[L]}")`,
  adminSettings: (L: Locale) => `Admin ("${LABEL.admin[L]}")`,
  rooms: (L: Locale) => `Conversations ("${LABEL.rooms[L]}")`,
  sideChat: (L: Locale) => `the room's side panel ("${LABEL.sideChat[L].replace('{name}', AI_NAME[L])}")`,
  ownChat: (_L: Locale) => 'a chat of their own (a new AI chat)',
} as const satisfies Record<string, (L: Locale) => string>

// ---------------- who can give access ----------------
// Admins are never named: the people directory shows no roles (shared/src/api/people.ts, DECISIONS "people
// directory"), so a refusal that listed them would tell a member who the admins are, and in a room or a shared chat the
// AI could repeat the names to everyone (review of #273). "An admin" and the screen where they do it are enough.

/**
 * Who can give write access at `rel` (the path as a read-only refusal named it): a team project's folder by its creator
 * (who chooses the project's people) or an admin, any other folder by an admin (Admin › Folder permissions, or Admin ›
 * Groups for a group's folder). `sees`: may the person read this folder (exact names, as the rules match them)? Only
 * then is the creator mentioned at all: "read-only folder: you cannot create files in 'projects/<x>'" is also what a
 * hidden project answers (policy/authorize.ts hiddenWrite), so a lookup by that name alone would tell a hidden project
 * from a missing one (independent review). `nameable`: may the creator's name go into this answer (in a room or a shared
 * chat, only when everyone there may read that project folder); otherwise "the project's creator" without a name.
 */
export function writeGranters(db: Database, rel: string, L: Locale, sees: (segs: string[]) => boolean, nameable: (segs: string[]) => boolean = () => true): { who: string; how: string } {
  const segs = rel.split('/').filter(Boolean)
  const top = segs[0]
  if (top === 'projects' && segs.length >= 2 && sees(segs.slice(0, 2))) {
    // the exact folder name (no case folding: a name typed in another case is not the folder the rules were read for)
    const p = db.query("SELECT p.name, u.name AS creator FROM projects p LEFT JOIN users u ON u.id = p.created_by AND u.status = 'active' AND u.deleted_at IS NULL WHERE p.trashed_with IS NULL AND p.folder_path = ? LIMIT 1").get(segs.slice(0, 2).join('/')) as { name: string; creator: string | null } | null
    if (p?.creator) {
      const creator = nameable(segs.slice(0, 2)) ? `${oneLine(p.creator)} (the project's creator)` : "the project's creator"
      return { who: `${creator} or an admin`, how: `the creator adds people to the project; an admin can also change ${SCREEN.adminFolders(L)}` }
    }
  }
  if (top === 'groups' && segs.length >= 2) return { who: 'an admin', how: `an admin adds them to the group in ${SCREEN.adminGroups(L)} or changes ${SCREEN.adminFolders(L)}` }
  return { who: 'an admin', how: `in ${SCREEN.adminFolders(L)}` }
}

/** The next step after "not found or no access": the same for a missing file and a hidden one (it names nothing about
 * the path). */
export function notFoundNext(): string {
  return 'if it should be there, check the name and folder with the user (list the folder they mean); if it still is not found, whoever manages that folder or an admin can check whether the user should have access'
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').replace(/[<>]/g, ' ').trim().slice(0, 80)

/**
 * B2: after a "read-only" refusal (policy/authorize.ts), who can give write access there and what the person can do
 * now; null for any other text (never for "not found or no access"). `sees` and `nameable` as for writeGranters.
 * `button`: the answer gets the "save in my folder" button (a person's own chat; not a room or a shared chat).
 */
export function readOnlyNote(db: Database, text: string, L: Locale, o: { userId: string; sees: (segs: string[]) => boolean; nameable?: (segs: string[]) => boolean; button: boolean }): string | null {
  const m = /read-only(?: folder)?: you cannot (?:change|create files in) '([^']*)'/.exec(text)
  if (!m || text.includes(`Write access to '${m[1]}'`)) return null
  const g = writeGranters(db, m[1]!, L, o.sees, o.nameable)
  const own = o.button ? `they also get a button under your answer to save it in their own folder (users/${o.userId}), and you may save it there if they ask` : `you may save it in their own folder (users/${o.userId}) if they ask`
  return `Write access to '${m[1]}': ${g.who} can give it (${g.how}). Next step: tell the user so; ${own}.`
}

/** B7: the per-answer write limits (files/service.ts limits, tools/make-file.ts), with their numbers and what to do. */
export function writeLimitText(kind: 'bytes' | 'files', max: number, path: string): string {
  const limit = kind === 'bytes' ? `at most ${Math.round(max / 1048576)} MB written in one answer` : `at most ${max} files written in one answer`
  return refusal({
    done: `Not saved: '${path}'.`,
    why: { kind: 'limit', limit, resets: 'with the user\'s next message' },
    next: 'stop saving in this answer, say what was saved and what is left, and ask the user to say "continue" in the next message to save the rest',
  })
}

/** How the card behind a refusal text ended (for an audit summary written where only the text is at hand): the
 * reason line refusal() wrote, else the person's no. 'failed': a check that could not be completed. */
export function endOfText(text: string): CardEnd | 'failed' {
  if (text.includes('Why: nobody could be asked')) return 'unattended'
  if (/Why: [^\n]*?did not answer the confirmation card in time/.test(text)) return 'timeout'
  if (text.includes('Why: the answer stopped before')) return 'ended'
  if (text.includes('Why: the server could not complete its check')) return 'failed'
  return 'declined'
}
