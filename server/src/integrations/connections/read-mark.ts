// A connection tool's read mark as a shared chat takes it (docs/decisions/20261118-shared-readonly-tools.md, QA TC-4900).
// The mark is the service's own readOnlyHint (mcp.ts), not checked by anyone; a read runs with no write card. In a
// shared chat other people's words can steer the AI, so there a mark the tool's own name or title contradicts
// ("send_message" marked read-only) is not taken: the call asks on its own write card like any change. A Google app's
// tools are Trina's own list as well (google-apps/catalog.ts appTools: a read only when both say so), so they keep it.
import type { RemoteTool } from './mcp'

/** Verbs that say a change wherever they stand in a name ("slack_send_message", "notion_create_page"). */
const CHANGE_ANYWHERE = new Set([
  'send', 'create', 'insert', 'append', 'update', 'upsert', 'modify', 'patch', 'upload', 'delete', 'remove', 'destroy',
  'trash', 'purge', 'erase', 'rename', 'submit', 'publish', 'unpublish', 'revoke', 'grant', 'approve', 'reject',
  'subscribe', 'unsubscribe', 'execute', 'overwrite', 'replace', 'unshare',
])
/** Verbs that are also nouns ("get_post", "list_merge_requests", "retrieve_charge"): a change only as the name's verb,
 * the first word or the word after a service prefix ("github_add_comment"; not after a read verb: "get_post_comments"). */
const CHANGE_AS_VERB = new Set([
  'post', 'share', 'add', 'set', 'put', 'write', 'edit', 'move', 'copy', 'comment', 'reply', 'forward', 'invite', 'merge',
  'archive', 'unarchive', 'cancel', 'close', 'reopen', 'assign', 'unassign', 'schedule', 'reschedule', 'notify', 'email',
  'mail', 'message', 'dm', 'tweet', 'pay', 'refund', 'charge', 'transfer', 'deploy', 'like', 'unlike', 'star', 'unstar',
  'follow', 'unfollow', 'react', 'pin', 'unpin', 'mark', 'tag', 'label', 'clear', 'reset', 'restore', 'enable', 'disable',
  'start', 'stop', 'run', 'trigger', 'book', 'buy', 'sell', 'sign', 'draft', 'save', 'store', 'make', 'new', 'import',
  'sync', 'join', 'leave', 'kick', 'ban', 'mute', 'block', 'accept', 'decline', 'confirm', 'complete', 'resolve',
])
/** Verbs that only look: a CHANGE_AS_VERB word after one of these is a noun ("get_post", "search_messages"). */
const READ_VERB = new Set([
  'get', 'list', 'search', 'find', 'read', 'fetch', 'query', 'describe', 'count', 'lookup', 'look', 'show', 'view',
  'check', 'download', 'export', 'scrape', 'browse', 'retrieve', 'inspect', 'preview', 'summarize', 'analyze', 'is', 'has',
])

/** The words of a tool's name or title: snake, kebab, dotted, camelCase and spaces split, lower case. */
export function nameWords(s: string): string[] {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

/** Does this name (or title) say the tool changes something? */
export function namedAsChange(s: string | null | undefined): boolean {
  const w = nameWords(s ?? '')
  if (!w.length) return false
  if (w.some((x) => CHANGE_ANYWHERE.has(x))) return true
  if (CHANGE_AS_VERB.has(w[0]!)) return true
  return w.length > 1 && !READ_VERB.has(w[0]!) && CHANGE_AS_VERB.has(w[1]!)
}

/**
 * Does a call of this tool only read, as this turn takes it? Outside a shared chat: the service's mark, as before. In a
 * shared chat: the mark only when the tool's name and title do not say a change, or Trina's own list confirms it (a
 * Google app's tools).
 */
export function readsHere(shared: boolean, row: { google_app?: string | null }, t: Pick<RemoteTool, 'name' | 'title' | 'readOnly'>): boolean {
  if (!t.readOnly) return false
  if (!shared || row.google_app) return true
  return !namedAsChange(t.name) && !namedAsChange(t.title)
}
