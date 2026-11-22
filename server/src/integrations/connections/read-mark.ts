// A connection tool's read mark as a shared chat takes it (docs/decisions/20261118-shared-readonly-tools.md, QA TC-4900;
// narrowed by docs/decisions/20261122-connector-always-allow.md). The mark is the service's own hint (mcp.ts:
// readOnlyHint, and never with destructiveHint), and nobody checks it. In a shared chat other people's words can steer
// the AI, so there the mark counts only when the tool's name also does not say it changes something: an ASCII name
// (and title) with no change word anywhere. Such a tool is a read whatever its verb ("scrape_as_markdown", 11-22 owner:
// "진짜 의심이 너무 많아"). A look-up whose change words are only nouns ("get_post") asks on its own read card, which the
// person may allow for good; anything else is a change and asks on the write card. A Google app keeps Trina's own list
// (google-apps/catalog.ts: a read only when both say so). Outside a shared chat the service's mark is taken as it is.
import type { RemoteTool } from './mcp'

/** How a call of a tool counts: a read (no card of its own), a read whose name holds a change word as a noun (the read
 * card, which the person may allow for good: tool-allow.ts), or a change (the write card, every time in a shared chat). */
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
 * a Google app (Trina's own list): the mark. In a shared chat: a read when the name is plain ASCII after NFKC (a name
 * with invisible characters is a change) and neither name nor title holds a change word, whatever its verb; a look-up
 * whose change words are only nouns (nounRead) is 'unsure'; anything else is a change.
 */
export function readKind(shared: boolean, row: { google_app?: string | null }, t: Pick<RemoteTool, 'name' | 'title' | 'readOnly'> & { inputSchema?: unknown }): ReadKind {
  if (!t.readOnly) return 'change'
  if (!shared || row.google_app) return 'read'
  const name = plainName(t.name)
  // a name with characters that do not show, or that is not plain ASCII after NFKC, is not judged by its look
  if (!name || name !== t.name.normalize('NFKC') || !/^[\x21-\x7e]+$/.test(name)) return 'change'
  if (namedAsChange(name) || namedAsChange(t.title)) {
    // a look-up whose change word is only a noun ("get_post", "list_pull_requests"): the "can't tell" card, never a read
    // (security review of #1328: the write card for every such read broke "no caps after an Always")
    const title = t.title ? plainName(t.title) : ''
    if (title && namedAsChange(title) && !nounRead(nameWords(title))) return 'change'
    return nounRead(nameWords(name)) ? 'unsure' : 'change'
  }
  // a verb that can write elsewhere (export, download, check: not strict read verbs): the read card, which the person may
  // allow for good; a tool whose own schema takes a recipient ("to", "channel", "webhook"…): a change (plan and code
  // review of 20261122-connector-always-allow.md). Decided once per tool
  const w = nameWords(name)
  // a tool that takes a recipient is a change: its card keeps the recipients in view and never offers Always (code review)
  if (takesRecipient(t.inputSchema)) return 'change'
  if (ELSEWHERE_VERBS.has(w[0] ?? '') || (w.length > 2 && ELSEWHERE_VERBS.has(w[1]!))) return 'unsure'
  return 'read'
}

/** Verbs that read here but may put the result somewhere else, or change a state while they check */
const ELSEWHERE_VERBS = new Set(['export', 'download', 'check'])
/** A top-level argument that names who or where something is sent to (not an address that is read: url, link, host) */
const SEND_TO = /^(to|cc|bcc|recipients?|emails?|email_?address(es)?|channels?|channel_?(id|name)s?|chat_?id|webhooks?(_?url)?|share_?with|phones?|phone_?numbers?|send_?to|notify)$/i
/** The tool's input schema names an argument of SEND_TO. */
export function takesRecipient(schema: unknown): boolean {
  const props = schema && typeof schema === 'object' ? (schema as { properties?: unknown }).properties : null
  return !!props && typeof props === 'object' && Object.keys(props as object).some((k) => SEND_TO.test(plainName(k)))
}

/** Words that join a second step ("fetch_and_post", "get_or_create", "list_users_to_notify"). */
const JOIN = new Set(['and', 'then', 'or', 'plus', 'also', 'n', 'after', 'before', 'via', 'to', 'into', 'while', 'but', 'else', 'with'])
/** Change verbs as a whole word, also with re- or un- ("resend", "unsubscribe"). */
const BARE = new Set([
  'send', 'delete', 'remove', 'erase', 'purge', 'wipe', 'destroy', 'execute', 'invoke', 'trigger', 'submit', 'revoke', 'grant',
  'approve', 'transfer', 'refund', 'publish', 'upload', 'write', 'overwrite', 'replace', 'insert', 'upsert', 'modify', 'mutate',
  'subscribe', 'kill', 'terminate', 'drop', 'forward', 'reply', 'respond', 'notify', 'broadcast', 'dispatch', 'create', 'update',
  'pay', 'run', 'merge', 'archive', 'trash', 'rename', 'invite', 'cancel', 'move', 'copy', 'post', 'share', 'commit', 'push',
  'deploy', 'schedule', 'save', 'sync', 'charge', 'order', 'set', 'put', 'add', 'edit', 'patch', 'tweet', 'vote', 'sign', 'book',
  'buy', 'sell', 'call', 'emit',
].flatMap((v) => [v, 're' + v, 'un' + v]))
/** Change verbs that are also nouns: a noun as the last word or before an ATTR word ("get_post", "get_post_comments"). */
const NOUN_VERBS = new Set(['post', 'share', 'reply', 'merge', 'schedule', 'sync', 'charge', 'order', 'commit', 'tweet', 'vote', 'book', 'call', 'draft', 'update', 'invite', 'run', 'copy', 'sign'])
const ATTR = new Set(['id', 'ids', 'url', 'urls', 'status', 'details', 'detail', 'info', 'count', 'comments', 'history', 'stats', 'metadata', 'by', 'at', 'link', 'links', 'content', 'body', 'data', 'settings', 'items', 'title', 'request', 'requests', 'code', 'date', 'time'])
/** Endings that make a change verb a noun or a state ("posts", "postal", "created", "payment") */
const INFLECTION = /^(s|es|d|ed|ing|er|ers|ment|ments|ion|ions|al|age|able)$/
const CHANGE_PARTS_SET = CHANGE_PARTS

/**
 * A look-up whose change words are only nouns (the security review's narrow rule): it starts with a strict read verb
 * (after a service prefix with no change word), has no word that joins a second step and no second read verb, and after
 * the verb no change verb (also with re- or un-) except a noun-verb as the last word or before an attribute word; no
 * change verb glued to more letters ("sendmessage") but its simple endings; no word holding two change parts.
 */
export function nounRead(w: readonly string[]): boolean {
  const at = READ_VERBS.has(w[0] ?? '') ? 0 : w.length > 2 && READ_VERBS.has(w[1]!) ? 1 : -1
  if (at < 0 || w.length < at + 2) return false
  if (at === 1 && namedAsChange(w[0])) return false
  if (w.some((x) => JOIN.has(x))) return false
  const rest = w.slice(at + 1)
  if (rest.some((x) => READ_VERBS.has(x))) return false
  for (let i = 0; i < rest.length; i++) {
    const x = rest[i]!
    if (BARE.has(x) && !(NOUN_VERBS.has(x) && (i === rest.length - 1 || ATTR.has(rest[i + 1]!)))) return false
    for (const v of BARE) if (x.length > v.length && x.startsWith(v) && !INFLECTION.test(x.slice(v.length))) return false
  }
  return !rest.some((x) => CHANGE_PARTS_SET.filter((p) => x.includes(p)).length > 1)
}

/** A call that only reads with no card of its own (readKind 'read'). */
export const readsHere = (shared: boolean, row: { google_app?: string | null }, t: Pick<RemoteTool, 'name' | 'title' | 'readOnly'> & { inputSchema?: unknown }): boolean => readKind(shared, row, t) === 'read'
