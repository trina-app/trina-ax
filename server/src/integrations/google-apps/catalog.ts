// Gmail, Google Calendar, Google Docs and Google Sheets (docs/GOOGLE-APPS.md): which of the Google Workspace MCP
// server's tools each app gives the AI, and how they are shown. A leaf module (no server state): the connection code
// (connections/service.ts check) filters a connection's tool list through appTools, the API shows TOOLS for "Show all
// tools", and the admin page shows APIS as the checklist of Google APIs to switch on.
//
// The library serves all four apps from one process (`--tools gmail calendar docs sheets --tool-tier complete`), so a
// connection keeps only its own app's tools, by name (the library's tool_tiers.yaml, pinned version). Its Drive tools
// are never loaded (Google Drive stays Trina's own connector), nor `start_google_auth` (Trina signs people in), nor the
// two comment tools that need full Drive access (owner decision 7). A tool the library adds in a later version is not
// offered until it is listed here.
import type { Database } from 'bun:sqlite'
import type { GoogleAppId, GoogleAppTool, Locale } from '@mycel/shared/api'
import type { RemoteTool } from '../connections/mcp'

export const APP_IDS: readonly GoogleAppId[] = ['gmail', 'calendar', 'docs', 'sheets']
export const isAppId = (v: unknown): v is GoogleAppId => typeof v === 'string' && (APP_IDS as readonly string[]).includes(v)

// Members connect their own account for an app once it is set up; there is no team switch (docs/DECISIONS.md "No
// members' switch for connectors", 2026-11-12). A stored "off" (`integrations.googleApps.<app>.members`) from before is
// ignored.

/** what people and the AI call each app */
export const APP_NAMES: Record<GoogleAppId, string> = { gmail: 'Gmail', calendar: 'Google Calendar', docs: 'Google Docs', sheets: 'Google Sheets' }
/** the start of the AI's tool names for the app (connections/tools.ts connectionKey: my_<slug>__<tool>) */
export const APP_SLUGS: Record<GoogleAppId, string> = { gmail: 'gmail', calendar: 'gcal', docs: 'gdocs', sheets: 'gsheets' }
/** the placeholder address of a connection (migration 341): never resolves, never used to connect */
export const placeholderUrl = (app: GoogleAppId) => `https://google-apps.invalid/${app}`

const api = (name: string, id: string) => ({ name, url: `https://console.cloud.google.com/apis/library/${id}` })
const DRIVE_API = api('Google Drive API', 'drive.googleapis.com')
/** the Google APIs an admin switches on in Google Cloud for each card (Docs and Sheets find and open files through Drive) */
export const APIS: Record<GoogleAppId, { name: string; url: string }[]> = {
  gmail: [api('Gmail API', 'gmail.googleapis.com')],
  calendar: [api('Google Calendar API', 'calendar-json.googleapis.com')],
  docs: [api('Google Docs API', 'docs.googleapis.com'), DRIVE_API],
  sheets: [api('Google Sheets API', 'sheets.googleapis.com'), DRIVE_API],
}

type Entry = [name: string, title: string, changes: boolean, description: string]
/** Per app: the library's tool, its title, whether it changes or sends something (the library's own mark, except
 * get_gmail_attachment_content, which only reads), and what it does in plain words. */
const TOOLS: Record<GoogleAppId, Entry[]> = {
  gmail: [
    ['search_gmail_messages', 'Search Gmail Messages', false, 'Find mail by words, sender, date or label.'],
    ['get_gmail_message_content', 'Get Gmail Message Content', false, 'Read one message, with its attachments listed.'],
    ['get_gmail_messages_content_batch', 'Get Gmail Messages Content Batch', false, 'Read several messages at once.'],
    ['get_gmail_thread_content', 'Get Gmail Thread Content', false, 'Read a whole conversation.'],
    ['get_gmail_threads_content_batch', 'Get Gmail Threads Content Batch', false, 'Read several conversations at once.'],
    ['get_gmail_attachment_content', 'Get Gmail Attachment Content', false, 'Read an attachment (PDF, Hangul, Office files, pictures).'],
    ['list_gmail_labels', 'List Gmail Labels', false, 'List your labels.'],
    ['list_gmail_filters', 'List Gmail Filters', false, 'List your filters.'],
    ['send_gmail_message', 'Send Gmail Message', true, 'Send, reply to or forward a message.'],
    ['draft_gmail_message', 'Draft Gmail Message', true, 'Write a draft for you to send later.'],
    ['modify_gmail_message_labels', 'Modify Gmail Message Labels', true, 'Label, archive or mark a message.'],
    ['batch_modify_gmail_message_labels', 'Batch Modify Gmail Message Labels', true, 'Label, archive or mark several messages.'],
    ['manage_gmail_label', 'Manage Gmail Label', true, 'Create, rename or delete a label.'],
    ['manage_gmail_filter', 'Manage Gmail Filter', true, 'Create or delete a filter.'],
  ],
  calendar: [
    ['list_calendars', 'List Calendars', false, 'List your calendars.'],
    ['get_events', 'Get Events', false, 'Read events in a time range.'],
    ['query_freebusy', 'Query Freebusy', false, 'See when people are free or busy.'],
    ['manage_event', 'Manage Event', true, 'Create, change or delete an event.'],
    ['manage_calendar', 'Manage Calendar', true, 'Create, change or delete a calendar.'],
    ['manage_out_of_office', 'Manage Out of Office', true, 'Set or remove out-of-office time.'],
    ['manage_focus_time', 'Manage Focus Time', true, 'Set or remove focus time.'],
  ],
  docs: [
    ['search_docs', 'Search Docs', false, 'Find documents by name.'],
    ['list_docs_in_folder', 'List Docs in Folder', false, 'List the documents in a folder.'],
    ['get_doc_content', 'Get Doc Content', false, 'Read a document.'],
    ['get_doc_as_markdown', 'Get Doc as Markdown', false, 'Read a document with its headings and lists.'],
    ['inspect_doc_structure', 'Inspect Doc Structure', false, 'See where paragraphs and tables are before editing.'],
    ['debug_table_structure', 'Debug Table Structure', false, 'See a table’s cells before editing it.'],
    ['list_document_comments', 'List Document Comments', false, 'Read the comments on a document.'],
    ['create_doc', 'Create Doc', true, 'Create a document.'],
    ['modify_doc_text', 'Modify Doc Text', true, 'Add, change or format text.'],
    ['find_and_replace_doc', 'Find and Replace Doc', true, 'Replace words throughout a document.'],
    ['insert_doc_elements', 'Insert Doc Elements', true, 'Add tables, lists or page breaks.'],
    ['insert_doc_image', 'Insert Doc Image', true, 'Add a picture.'],
    ['update_paragraph_style', 'Update Paragraph Style', true, 'Change headings, spacing or alignment.'],
    ['update_doc_headers_footers', 'Update Doc Headers Footers', true, 'Change headers and footers.'],
    ['create_table_with_data', 'Create Table with Data', true, 'Add a filled-in table.'],
    ['batch_update_doc', 'Batch Update Doc', true, 'Make several changes at once.'],
    ['manage_doc_tab', 'Manage Doc Tab', true, 'Add, rename or delete a tab.'],
    ['export_doc_to_pdf', 'Export Doc to PDF', true, 'Save a PDF copy in your Google Drive.'],
  ],
  sheets: [
    ['list_spreadsheets', 'List Spreadsheets', false, 'Find spreadsheets.'],
    ['get_spreadsheet_info', 'Get Spreadsheet Info', false, 'See a spreadsheet’s sheets and sizes.'],
    ['read_sheet_values', 'Read Sheet Values', false, 'Read cells.'],
    ['list_sheet_tables', 'List Sheet Tables', false, 'List the tables in a sheet.'],
    ['list_spreadsheet_comments', 'List Spreadsheet Comments', false, 'Read the comments on a spreadsheet.'],
    ['create_spreadsheet', 'Create Spreadsheet', true, 'Create a spreadsheet.'],
    ['create_sheet', 'Create Sheet', true, 'Add a sheet.'],
    ['modify_sheet_values', 'Modify Sheet Values', true, 'Write or clear cells.'],
    ['append_table_rows', 'Append Table Rows', true, 'Add rows to a table.'],
    ['format_sheet_range', 'Format Sheet Range', true, 'Change how cells look.'],
    ['manage_conditional_formatting', 'Manage Conditional Formatting', true, 'Add or remove conditional formatting.'],
    ['manage_sheet_tab', 'Manage Sheet Tab', true, 'Rename, move or delete a sheet.'],
    ['resize_sheet_dimensions', 'Resize Sheet Dimensions', true, 'Change row heights and column widths.'],
    ['move_sheet_rows', 'Move Sheet Rows', true, 'Move rows.'],
    ['manage_named_range', 'Manage Named Range', true, 'Add or remove named ranges.'],
  ],
}

type Words = Record<Locale, string>
const w = (en: string, ko: string, id: string, ja: string, es: string, zh: string): Words => ({ en, ko, id, ja, es, zh })
/** What the step under an answer and the card before a change call a library tool, in the person's language
 * (connections/card-lines.ts toolTitle), in place of the library's English title ("Search Gmail Messages"). Gmail only
 * for now: Calendar, Docs and Sheets keep the library's title. tests/unit/google-tool-titles.test.ts: every Gmail tool
 * in every language. */
export const TOOL_WORDS: Record<string, Words> = {
  search_gmail_messages: w('Search mail', '메일 찾기', 'Cari email', 'メールを検索', 'Buscar correo', '搜索邮件'),
  get_gmail_message_content: w('Read a message', '메일 읽기', 'Baca email', 'メールを読む', 'Leer un mensaje', '阅读邮件'),
  get_gmail_messages_content_batch: w('Read messages', '메일 여러 통 읽기', 'Baca beberapa email', '複数のメールを読む', 'Leer varios mensajes', '阅读多封邮件'),
  get_gmail_thread_content: w('Read a conversation', '메일 대화 읽기', 'Baca percakapan', 'メールのやり取りを読む', 'Leer una conversación', '阅读邮件会话'),
  get_gmail_threads_content_batch: w('Read conversations', '메일 대화 여러 개 읽기', 'Baca beberapa percakapan', '複数のやり取りを読む', 'Leer varias conversaciones', '阅读多个邮件会话'),
  get_gmail_attachment_content: w('Read an attachment', '첨부 파일 읽기', 'Baca lampiran', '添付ファイルを読む', 'Leer un adjunto', '阅读附件'),
  list_gmail_labels: w('List labels', '라벨 보기', 'Lihat label', 'ラベルを見る', 'Ver etiquetas', '查看标签'),
  list_gmail_filters: w('List filters', '필터 보기', 'Lihat filter', 'フィルタを見る', 'Ver filtros', '查看过滤器'),
  send_gmail_message: w('Send email', '메일 보내기', 'Kirim email', 'メールを送信', 'Enviar correo', '发送邮件'),
  draft_gmail_message: w('Save a draft', '임시 보관함에 저장', 'Simpan draf', '下書きを保存', 'Guardar un borrador', '保存草稿'),
  modify_gmail_message_labels: w('Change labels', '라벨 바꾸기', 'Ubah label', 'ラベルを変更', 'Cambiar etiquetas', '更改标签'),
  batch_modify_gmail_message_labels: w('Change labels on several messages', '여러 메일 라벨 바꾸기', 'Ubah label beberapa email', '複数のメールのラベルを変更', 'Cambiar etiquetas de varios mensajes', '更改多封邮件的标签'),
  manage_gmail_label: w('Manage a label', '라벨 관리', 'Kelola label', 'ラベルを管理', 'Gestionar una etiqueta', '管理标签'),
  manage_gmail_filter: w('Manage a filter', '필터 관리', 'Kelola filter', 'フィルタを管理', 'Gestionar un filtro', '管理过滤器'),
}
/** a library tool's own words in `L` (TOOL_WORDS), or null for a tool not listed there */
export const googleToolWord = (name: string, L: Locale): string | null =>
  Object.hasOwn(TOOL_WORDS, name) ? TOOL_WORDS[name]![L] ?? TOOL_WORDS[name]!.en : null

/** "Show all tools": what the AI gets from the app (also before anyone connects) */
export function catalog(app: GoogleAppId): GoogleAppTool[] {
  return TOOLS[app].map(([name, title, changes, description]) => ({ name, title, description, changes }))
}

/** the attachment tool reads, though the library does not mark it so (it saves a copy on its own disk in other modes) */
export const ATTACHMENT_TOOL = 'get_gmail_attachment_content'
/** the two Gmail tools that take attachments; one given by a web address would be fetched by the library */
export const SENDING_TOOLS = new Set(['send_gmail_message', 'draft_gmail_message'])
/** read tools of Docs and Sheets: plain "what does this file say" goes to drive_read (owner decision 4) */
const STRUCTURE_READS = new Set(['get_doc_content', 'get_doc_as_markdown', 'inspect_doc_structure', 'debug_table_structure', 'get_spreadsheet_info', 'read_sheet_values', 'list_sheet_tables'])
/** how a Gmail send or draft attaches a team file (the handle's prefix is connections/team-attach.ts TEAM_FILE_PREFIX;
 * tests/unit/c-integrations-attach.test.ts holds the two together) */
const ATTACH_LINE = 'To attach a team file: attachments [{"filename": "<name>", "content": "team-file:<the file\'s path in the team folder>"}]; the file itself is put there after the user\'s OK. Never a "path" or a "url".'
const DRIVE_READ_LINE = 'For a plain "what does this file say" question, use drive_read instead; use this tool to read the structure (cells, ranges, paragraphs) before you change the file.'

/** the attachment tool's own argument: the file's name as the message listed it, so it is read with the right reader;
 * never sent to the library */
export const ATTACHMENT_NAME_ARG = 'file_name'
/** the attachment tool's other own argument: its size in bytes as the message listed it, so one too large to come back
 * in one answer is not fetched (google-apps/attachments.ts ATTACHMENT_MAX_BYTES); never sent to the library */
export const ATTACHMENT_SIZE_ARG = 'file_size'

/**
 * The library's tools for one app: only the ones listed for it, read or change by the library's own mark
 * (readOnlyHint), the attachment tool counted as a read, Docs' and Sheets' read tools pointing plain questions to
 * drive_read. The attachment tool's schema loses `return_base64` (always on: Trina turns the bytes into text or a
 * picture, tools.ts) and gains `file_name` and `file_size`.
 */
export function appTools(app: GoogleAppId, tools: readonly RemoteTool[]): RemoteTool[] {
  const listed = new Map(TOOLS[app].map((e) => [e[0], e]))
  const out: RemoteTool[] = []
  for (const t of tools) {
    const e = listed.get(t.name)
    if (!e) continue
    // a read only when both say so: a tool listed here as a change asks even if the library marks it read-only
    let tool: RemoteTool = { ...t, title: t.title ?? e[1], readOnly: !e[2] && (t.readOnly || t.name === ATTACHMENT_TOOL) }
    if (t.name === ATTACHMENT_TOOL) {
      const schema = structuredClone(t.inputSchema) as { properties?: Record<string, unknown>; required?: unknown }
      const props = { ...(schema.properties ?? {}) }
      delete props.return_base64
      props[ATTACHMENT_NAME_ARG] = { type: 'string', maxLength: 300, description: 'the attachment\'s file name as the message listed it (e.g. "invoice.pdf"), so it is read as the right kind of file' }
      props[ATTACHMENT_SIZE_ARG] = { type: 'integer', minimum: 0, description: 'the attachment\'s size in bytes as the message listed it, when it gave one' }
      tool = { ...tool, inputSchema: { ...schema, properties: props }, description: `${t.description} The attachment is read for you as text (PDF, Hangul, Word, Excel, PowerPoint) or shown as a picture; to keep the original file in the team files when the user asks, save it with save_connector_file (the handle in the result) into the user's own folder unless they name another one.`.slice(0, 1000) }
    }
    // a team file as an attachment: by its handle, which the server swaps for the file after the card
    // (connections/team-attach.ts); first, so a long description of the library's does not cut it off
    if (SENDING_TOOLS.has(t.name)) tool = { ...tool, description: `${ATTACH_LINE} ${t.description}`.slice(0, 1000) }
    if (STRUCTURE_READS.has(t.name)) tool = { ...tool, description: `${DRIVE_READ_LINE} ${t.description}`.slice(0, 1000) }
    out.push(tool)
  }
  return out
}
