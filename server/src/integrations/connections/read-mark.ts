// A connection tool's read mark as a shared chat takes it (docs/decisions/20261118-shared-readonly-tools.md, QA TC-4900).
// The mark is the service's own hint (mcp.ts: readOnlyHint, and never with destructiveHint), and nobody checks it. In a
// shared chat other people's words can steer the AI, so there the mark counts only when the tool's name also plainly
// looks: an ASCII name whose verb is a strict read verb and that holds no change word anywhere (name or title). A
// marked tool whose verb is not known ("scrape_as_markdown") asks on its own "can't tell" card; anything else is a
// change and asks on the write card. A Google app keeps Trina's own list (google-apps/catalog.ts: a read only when
// both say so). Outside a shared chat the service's mark is taken as it is.
import type { RemoteTool } from './mcp'

/** How a call of a tool counts: a read (no card of its own), a read Trina cannot confirm by its name (the "can't tell"
 * card, which may be allowed for the rest of the chat), or a change (the write card, every time in a shared chat). */
export type ReadKind = 'read' | 'unsure' | 'change'

/** Strict read verbs: the name's first word, or the first word after a service prefix ("github_get_issue"). Not
 * export, download or check: those can write elsewhere or change state. */
const READ_VERBS = new Set(['get', 'list', 'search', 'read', 'find', 'fetch', 'query', 'view', 'describe', 'show', 'count', 'lookup', 'retrieve'])

/** Change words matched as a part of the name with its separators taken out, and of the title: so "sendmessage",
 * "resend_invoice" and "PostMessage" are caught. Some reads are caught too ("get_post", "list_shared"): they ask. */
const CHANGE_PARTS = [
  'send', 'post', 'creat', 'updat', 'delet', 'remov', 'insert', 'append', 'upload', 'publish', 'share', 'invit', 'forward',
  'reply', 'repli', 'respond', 'answer', 'merge', 'renam', 'archiv', 'trash', 'transfer', 'refund', 'charge', 'purchas',
  'payment', 'submit', 'approv', 'reject', 'revok', 'grant', 'execut', 'mutat', 'patch', 'notif', 'schedul', 'broadcast',
  'dispatch', 'invok', 'trigger', 'deploy', 'launch', 'terminat', 'destroy', 'purge', 'erase', 'wipe', 'cancel', 'revert',
  'rollback', 'restart', 'reboot', 'shutdown', 'provision', 'spawn', 'commit', 'push', 'tweet', 'vote', 'enroll', 'regist',
  'signup', 'login', 'logout', 'authoriz', 'connect', 'attach', 'detach', 'inject', 'embed', 'increment', 'decrement',
  'write', 'modif', 'toggl', 'enabl', 'disabl', 'activat', 'assign', 'escalat', 'promot', 'demot', 'convert',
  'resolv', 'restor', 'acknowledg', 'dismiss', 'snooze', 'subscri', 'compos', 'rsvp', 'checkin', 'checkout',
  'hook', 'request', 'graphql', 'sql', 'releas', 'sync', 'save', 'draft', 'upsert', 'replac', 'overwrit',
  'move', 'copy', 'clone', 'fork', 'install', 'uninstall', 'kick', 'mute', 'unmute', 'remind', 'reserv', 'confirm', 'complet',
  'reopen',
]
/** Short change words matched only as a whole word ("put_object", "s3PutObject"; not "input", "output"). */
const CHANGE_WORDS = new Set([
  'put', 'set', 'add', 'pay', 'run', 'mark', 'tag', 'pin', 'unpin', 'star', 'unstar', 'like', 'unlike', 'apply', 'sign', 'buy',
  'sell', 'call', 'dial', 'ping', 'emit', 'kill', 'drop', 'scale', 'undo', 'redo', 'ack', 'bump', 'tick',
  'pull', 'link', 'unlink', 'make', 'join', 'leave', 'ban', 'open', 'book', 'order', 'start', 'stop', 'pause', 'resume',
  'close', 'react', 'block', 'import', 'store', 'follow', 'unfollow', 'edit',
])
/** Words that are a change as the name's first word only ("email_team", "message_user"; not "get_message"). */
const CHANGE_FIRST = new Set(['text', 'sms', 'mail', 'email', 'message', 'dm', 'new', 'do', 'go'])
/** Characters that do not show: taken out before the name is judged (a zero-width space, U+200B, inside "send"). */
const INVISIBLE = /[\p{Cf}\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u3164\uFFA0]/gu

/** A name or title as it is judged: NFKC (full-width letters become ASCII) without invisible characters. */
export function plainName(s: string | null | undefined): string {
  return (s ?? '').normalize('NFKC').replace(INVISIBLE, '')
}

/** The words of a name: snake, kebab, dotted, camelCase and spaces split, lower case. */
export function nameWords(s: string): string[] {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

/** Does this name or title hold a change word anywhere? */
export function namedAsChange(s: string | null | undefined): boolean {
  const p = plainName(s)
  if (!p) return false
  const words = nameWords(p)
  if (words.some((w) => CHANGE_WORDS.has(w)) || CHANGE_FIRST.has(words[0] ?? '')) return true
  const joined = p.toLowerCase().replace(/[^a-z0-9]+/g, '')
  return CHANGE_PARTS.some((c) => joined.includes(c))
}

/** The name's verb is a strict read verb: its first word, or the first word after a service prefix. */
export function readVerb(name: string): boolean {
  const w = nameWords(plainName(name))
  return READ_VERBS.has(w[0] ?? '') || (w.length > 2 && READ_VERBS.has(w[1]!))
}

/**
 * How a call of this tool counts in this turn. Not marked read-only by the service: a change. Outside a shared chat, or
 * a Google app (Trina's own list): the mark. In a shared chat: a read only when the name is plain ASCII after NFKC
 * (a name with invisible characters is a change), its verb is a strict read verb and neither name nor title holds a change word; a
 * marked tool with no change word whose verb is not known is 'unsure'; anything else is a change.
 */
export function readKind(shared: boolean, row: { google_app?: string | null }, t: Pick<RemoteTool, 'name' | 'title' | 'readOnly'>): ReadKind {
  if (!t.readOnly) return 'change'
  if (!shared || row.google_app) return 'read'
  const name = plainName(t.name)
  // a name with characters that do not show, or that is not plain ASCII after NFKC, is not judged by its look
  if (!name || name !== t.name.normalize('NFKC') || !/^[\x21-\x7e]+$/.test(name)) return 'change'
  if (namedAsChange(name) || namedAsChange(t.title)) return 'change'
  return readVerb(name) ? 'read' : 'unsure'
}

/** A call that only reads with no card of its own (readKind 'read'). */
export const readsHere = (shared: boolean, row: { google_app?: string | null }, t: Pick<RemoteTool, 'name' | 'title' | 'readOnly'>): boolean => readKind(shared, row, t) === 'read'
