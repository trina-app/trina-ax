// The name of the thing a Google app change acts on, for the first line of its card (connections/tools.ts gate): a
// change to an event, a message or a spreadsheet that is there already names it only by its id ("e1"), which nobody
// can tell apart. Before the card shows, the library's own read tool on the same connection reads its name (an event's
// title, a message's subject, a spreadsheet's title); the name goes only onto the card, never to the AI. Nothing found,
// or any failure: the card as before, with the id. A leaf module: which tool and argument, the read, the answer's words.
import type { TextKey } from '../connections/text'

/** what to read for a change call's name: the read tool and its arguments, how its answer says the name, and what the
 * card calls the thing */
export interface NameRead { tool: string; args: Record<string, unknown>; word: TextKey; parse: (text: string) => string | null }

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() && v.length <= 1024 ? v.trim() : null)
/** the first match's group in the answer, or null for the library's own word for "none" */
const first = (re: RegExp, none?: string) => (text: string): string | null => {
  const m = re.exec(text)
  const v = m?.[1]?.trim()
  return v && v !== none ? v : null
}
/** an event in get_events' short list: `- "<title>" (Starts: …` (workspace-mcp 2.4.1 gcalendar/calendar_tools.py) */
const EVENT_TITLE = first(/^- "(.*)" \(Starts: /m, 'No Title')
/** a message's headers (format "metadata"): `Subject: <subject>` (gmail/gmail_tools.py _format_message_header_lines) */
const SUBJECT = first(/^Subject: (.*)$/m, '(no subject)')
/** get_spreadsheet_info's first line: `Spreadsheet: "<title>" (ID: …` (gsheets/sheets_tools.py) */
const SPREADSHEET_TITLE = first(/^Spreadsheet: "(.*)" \(ID: /m)

/** the Calendar tools whose `action` acts on an event that is there already */
const EVENT_TOOLS = new Set(['manage_event', 'manage_out_of_office', 'manage_focus_time'])
const ON_EXISTING = new Set(['update', 'delete', 'rsvp'])
/** the Sheets change tools that act on a spreadsheet by its id */
const SHEET_TOOLS = new Set(['create_sheet', 'modify_sheet_values', 'append_table_rows', 'format_sheet_range', 'manage_conditional_formatting',
  'manage_sheet_tab', 'resize_sheet_dimensions', 'move_sheet_rows', 'manage_named_range'])

/**
 * The read that names what a Google app change call acts on, or null: an event to change, delete or answer (by
 * `event_id`), a message whose labels change (by `message_id`), a spreadsheet a Sheets change writes to (by
 * `spreadsheet_id`). Docs has no cheap read that names a document (its reads return the whole text): none.
 */
export function nameReadOf(tool: string, args: unknown): NameRead | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null
  const a = args as Record<string, unknown>
  if (EVENT_TOOLS.has(tool)) {
    const action = str(a.action)?.toLowerCase(), id = str(a.event_id)
    if (!action || !ON_EXISTING.has(action) || !id) return null
    const calendar = str(a.calendar_id)
    return { tool: 'get_events', args: { event_id: id, ...(calendar ? { calendar_id: calendar } : {}) }, word: 'targetEvent', parse: EVENT_TITLE }
  }
  if (tool === 'modify_gmail_message_labels') {
    const id = str(a.message_id)
    return id ? { tool: 'get_gmail_message_content', args: { message_id: id, format: 'metadata' }, word: 'targetMessage', parse: SUBJECT } : null
  }
  if (SHEET_TOOLS.has(tool)) {
    const id = str(a.spreadsheet_id)
    return id ? { tool: 'get_spreadsheet_info', args: { spreadsheet_id: id }, word: 'targetSpreadsheet', parse: SPREADSHEET_TITLE } : null
  }
  return null
}

/** the text of an MCP tool answer (its text parts, at most 64 KB read), or null for an error answer */
export function answerText(r: unknown): string | null {
  if (!r || typeof r !== 'object' || (r as { isError?: unknown }).isError) return null
  const content = (r as { content?: unknown }).content
  if (!Array.isArray(content)) return null
  const text = content.filter((c) => c && typeof c === 'object' && c.type === 'text' && typeof c.text === 'string').map((c) => c.text as string).join('\n')
  return text.slice(0, 65_536)
}
