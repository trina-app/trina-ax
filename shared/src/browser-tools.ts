// Input schemas of the in-app browser tools (design tab 5 "앱 안 브라우저 도구"). Owner: E (desktop).
//
// The engine sees these tools with exactly these names and inputs whatever client runs them (desktop app today,
// mobile shells later), so the AI drives every client's browser the same way. Names and input shapes follow the
// Claude desktop app's in-app browser (ported from Saram desktop/pane-tools.ts); descriptions are condensed.
//
//   server (B):  expose BROWSER_TOOLS[name].description + browserToolJsonSchema(name) to the engine, forward
//                the call unchanged as browser.call { tool, args }.
//   desktop (E): parseBrowserToolInput(tool, args) before running anything.
import { z } from 'zod'
import { BrowserToolName } from './api/browser'

/** Models sometimes send numeric tab ids; tab ids are strings ("tab-3"). */
const TabId = z.union([z.string().min(1).max(100), z.number().int()]).transform(String)
const tabIdField = { tabId: TabId.optional().describe('Tab to act on within the browser pane. Omit for the fronted tab.') }
const Point = z.tuple([z.number().finite(), z.number().finite()])
const Region = z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()])
const Url = z.string().min(1).max(8192)

export const COMPUTER_ACTIONS = [
  'left_click', 'right_click', 'type', 'screenshot', 'wait', 'scroll', 'key', 'left_click_drag',
  'double_click', 'triple_click', 'zoom', 'scroll_to', 'hover',
] as const
export type ComputerAction = (typeof COMPUTER_ACTIONS)[number]

export const PreviewStartInput = z.object({ url: Url.describe('URL to open in the browser pane.') })
export const NavigateInput = z.object({
  ...tabIdField,
  url: Url.describe('URL (https:// is added if missing), or "back" / "forward".'),
  force: z.boolean().optional().describe('Discard unsaved changes if the page asks "Leave site?".'),
})
export const ReadPageInput = z.object({
  ...tabIdField,
  filter: z.enum(['interactive', 'all']).optional().describe("'interactive' returns only clickable/typable elements; 'all' (default) the full tree."),
  depth: z.number().int().min(1).max(100).optional().describe('Maximum tree depth (default 15).'),
  ref_id: z.string().max(40).optional().describe('Only descendants of this ref_N.'),
  max_chars: z.number().int().min(100).max(1_000_000).optional().describe('Maximum characters of output (default 50000).'),
})
export const FindInput = z.object({ ...tabIdField, query: z.string().min(1).max(500).describe('Text to look for, e.g. "Sign in", "search", "Add to cart".') })
export const GetPageTextInput = z.object({ ...tabIdField, max_chars: z.number().int().min(100).max(1_000_000).optional().describe('Maximum characters (default 50000).') })
export const ComputerInput = z.object({
  ...tabIdField,
  action: z.enum(COMPUTER_ACTIONS).describe(
    'left_click / right_click / double_click / triple_click at coordinate or ref; type text; key: space-separated keys or combos ' +
      '(cmd+a on Mac, ctrl+a elsewhere); screenshot; zoom a region; scroll at coordinate; scroll_to a ref; left_click_drag from ' +
      'start_coordinate to coordinate; hover; wait duration seconds. Typing into password fields is refused: ask the user to type passwords.',
  ),
  coordinate: Point.optional().describe('(x, y) in viewport pixels of the latest screenshot. End position for left_click_drag.'),
  text: z.string().max(100_000).optional().describe('Text for type, keys for key. Page zoom shortcuts are not supported; use zoom.'),
  duration: z.number().min(0).max(10).optional().describe('Seconds for wait (max 10).'),
  scroll_direction: z.enum(['up', 'down', 'left', 'right']).optional(),
  scroll_amount: z.number().min(1).max(10).optional().describe('Wheel ticks, default 3.'),
  start_coordinate: Point.optional(),
  region: Region.optional().describe('(x0, y0, x1, y1) for zoom.'),
  scale: z.number().min(0.1).max(1).optional().describe('screenshot/zoom image size factor; coordinates stay in the full-size frame.'),
  repeat: z.number().int().min(1).max(100).optional().describe('Repeat the key sequence.'),
  ref: z.string().max(40).optional().describe('Element ref (ref_N). Required for scroll_to; alternative to coordinate.'),
  modifiers: z.string().max(60).optional().describe('Modifier keys held during a click: "ctrl", "shift", "alt", "cmd", joined with "+".'),
  save_to_disk: z.boolean().optional().describe('screenshot/zoom: also show the image to the user in the chat. Only when you mean to share it.'),
})
export const FormInputInput = z.object({
  ...tabIdField,
  ref: z.string().min(1).max(40).describe('Element ref, e.g. "ref_1".'),
  value: z.union([z.string().max(100_000), z.boolean(), z.number()]).describe('Checkboxes take a boolean, selects an option value or text, other inputs a string or number. Password fields are refused.'),
})
export const JavascriptToolInput = z.object({
  ...tabIdField,
  action: z.literal('javascript_exec'),
  text: z.string().min(1).max(100_000).describe('Code to run.'),
})
export const ReadConsoleInput = z.object({
  ...tabIdField,
  onlyErrors: z.boolean().optional().describe('Only error entries.'),
  pattern: z.string().max(500).optional().describe('Substring filter on message text.'),
  limit: z.number().int().min(1).max(200).optional().describe('Max entries (default 50, max 200).'),
})
export const ReadNetworkInput = z.object({
  ...tabIdField,
  urlPattern: z.string().max(500).optional().describe('Substring filter on the URL as listed (auth values show as REDACTED).'),
  requestId: z.string().max(200).optional().describe("Return this request's response body instead of listing."),
  limit: z.number().int().min(1).max(500).optional().describe('Max entries when listing (default 50).'),
})
export const ResizeWindowInput = z.object({
  ...tabIdField,
  preset: z.enum(['mobile', 'tablet', 'desktop']).optional(),
  width: z.number().int().min(100).max(4000).optional(),
  height: z.number().int().min(100).max(4000).optional(),
  colorScheme: z.enum(['light', 'dark']).optional(),
})
export const TabsContextInput = z.object({})
export const TabsCreateInput = z.object({ foreground: z.boolean().optional().describe('Front the new tab.') })
export const TabsSelectInput = z.object({ tabId: TabId.describe('Tab to front.') })
export const TabsCloseInput = z.object({ tabId: TabId.describe('Tab to close.') })
export const BatchAction = z.object({
  name: z.string().min(1).max(40).describe('Tool name, e.g. computer, navigate, find, form_input, read_page.'),
  input: z.record(z.string(), z.unknown()),
})
export const BrowserBatchInput = z.object({
  actions: z.array(BatchAction).min(1).max(50),
  save_to_disk: z.boolean().optional().describe('Show the screenshots of this batch to the user in the chat.'),
})

export interface BrowserToolSpec {
  description: string
  input: z.ZodType
  /** whether the tool reads or changes the tab it targets (the Claude app's classification) */
  kind: 'reads-tab' | 'mutates-tab' | 'no-tab-target'
}

export const BROWSER_TOOLS: Record<BrowserToolName, BrowserToolSpec> = {
  preview_start: {
    kind: 'no-tab-target',
    input: PreviewStartInput,
    description:
      'Open the browser pane at a URL (a fresh browser tab, shown next to the chat in the desktop app). Returns a tabId; pass it to ' +
      'read_page / computer / navigate / etc., or omit tabId to act on the fronted tab. The user is asked before a site is used ' +
      'for the first time, and always before office-network (private) addresses.',
  },
  navigate: {
    kind: 'mutates-tab',
    input: NavigateInput,
    description: 'Navigate the browser pane to a URL, or go "back" / "forward" in history. If the pane is not open yet, this opens it at the URL.',
  },
  read_page: {
    kind: 'reads-tab',
    input: ReadPageInput,
    description:
      'Read the current page in the browser pane as a YAML-style accessibility tree. Each interactive element is tagged [ref_N] ' +
      'for computer / form_input / find. Prefer this over screenshots for text and structure. Output is cut at max_chars ' +
      '(default 50000); use ref_id or depth to focus.',
  },
  find: {
    kind: 'reads-tab',
    input: FindInput,
    description: 'Search the page for elements whose role, name or text contains query (case-insensitive). Returns up to 20 ref_N matches.',
  },
  get_page_text: { kind: 'reads-tab', input: GetPageTextInput, description: 'Visible text of the page (article / main content first, then body).' },
  computer: {
    kind: 'mutates-tab',
    input: ComputerInput,
    description:
      "Mouse and keyboard in the browser pane. Clicks take either coordinate (pixels of the latest screenshot's coordinate frame) " +
      'or ref (ref_N from read_page / find). Look at a screenshot before clicking by coordinate, and take a new one after the tab ' +
      'loads another site. Never type passwords or payment details; ask the user to do that in the pane.',
  },
  form_input: {
    kind: 'mutates-tab',
    input: FormInputInput,
    description: 'Set the value of a form element by ref (from read_page / find). Handles input, textarea, select, checkbox and contenteditable.',
  },
  javascript_tool: {
    kind: 'mutates-tab',
    input: JavascriptToolInput,
    description:
      "Execute JavaScript in the browser pane's page. Runs in the page context with REPL semantics: top-level await works and the " +
      'last expression value is returned (write the expression, not return ...). Returns JSON. The user sees every script run.',
  },
  read_console_messages: { kind: 'reads-tab', input: ReadConsoleInput, description: 'Console output (log, info, warn, error, debug) of the browser pane tab.' },
  read_network_requests: {
    kind: 'reads-tab',
    input: ReadNetworkInput,
    description: 'List network requests of the tab, or fetch one response body by requestId. The user sees every body read.',
  },
  resize_window: {
    kind: 'mutates-tab',
    input: ResizeWindowInput,
    description:
      'Emulate a viewport size in the tab: presets mobile (375x812, also mobile user agent and touch), tablet (768x1024), or ' +
      'desktop (clears the emulation). Custom sizes need width and height. colorScheme emulates prefers-color-scheme. Reset with ' +
      '"desktop" when you are done.',
  },
  tabs_context: {
    kind: 'no-tab-target',
    input: TabsContextInput,
    description: 'List every browser pane tab (origin only). Returns {browserOpen, tabs: [{tabId, origin, isActive}]}. browserOpen is false until preview_start or navigate opens the pane.',
  },
  tabs_create: { kind: 'no-tab-target', input: TabsCreateInput, description: 'Open a fresh blank tab and return its tabId. Opens in the background unless foreground: true (the user wants to watch).' },
  tabs_select: { kind: 'mutates-tab', input: TabsSelectInput, description: 'Front the given tab (only when the user should look at it).' },
  tabs_close: { kind: 'mutates-tab', input: TabsCloseInput, description: 'Close one tab. Closing the last tab closes the browser pane.' },
  browser_batch: {
    kind: 'no-tab-target',
    input: BrowserBatchInput,
    description:
      'Run several browser pane tool calls in ONE round trip, in order, stopping at the first error. Each item is {name, input} as ' +
      'for the tool itself. Use it whenever you can predict two or more steps (click a field, type, press Return, screenshot). ' +
      'Coordinates refer to the screenshot taken before this call. Cannot be nested; preview_start is not batchable, but a batch ' +
      'whose first action is navigate with a url opens the pane.',
  },
}

export type BrowserToolInput = {
  preview_start: z.output<typeof PreviewStartInput>
  navigate: z.output<typeof NavigateInput>
  read_page: z.output<typeof ReadPageInput>
  find: z.output<typeof FindInput>
  get_page_text: z.output<typeof GetPageTextInput>
  computer: z.output<typeof ComputerInput>
  form_input: z.output<typeof FormInputInput>
  javascript_tool: z.output<typeof JavascriptToolInput>
  read_console_messages: z.output<typeof ReadConsoleInput>
  read_network_requests: z.output<typeof ReadNetworkInput>
  resize_window: z.output<typeof ResizeWindowInput>
  tabs_context: z.output<typeof TabsContextInput>
  tabs_create: z.output<typeof TabsCreateInput>
  tabs_select: z.output<typeof TabsSelectInput>
  tabs_close: z.output<typeof TabsCloseInput>
  browser_batch: z.output<typeof BrowserBatchInput>
}

export type ParsedBrowserCall = { [T in BrowserToolName]: { tool: T; input: BrowserToolInput[T] } }[BrowserToolName]

/**
 * Validate a tool call's input. Errors are short English sentences for the model (it reads them and retries).
 * Unknown keys are dropped, not rejected: models add harmless extras.
 */
export function parseBrowserToolInput(tool: string, args: unknown): { ok: true; call: ParsedBrowserCall } | { ok: false; error: string } {
  const name = BrowserToolName.safeParse(tool)
  if (!name.success) return { ok: false, error: `Unknown browser tool "${tool}".` }
  const r = BROWSER_TOOLS[name.data].input.safeParse(args ?? {})
  if (!r.success) {
    const issues = r.error.issues.slice(0, 5).map((i) => `${i.path.length ? i.path.join('.') : 'input'}: ${i.message}`)
    return { ok: false, error: `Invalid input for ${name.data}: ${issues.join('; ')}` }
  }
  return { ok: true, call: { tool: name.data, input: r.data } as ParsedBrowserCall }
}

/** JSON Schema of a tool's input, for the engine's tool list (MCP inputSchema). */
export function browserToolJsonSchema(tool: BrowserToolName): Record<string, unknown> {
  const s = z.toJSONSchema(BROWSER_TOOLS[tool].input, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>
  delete s.$schema
  return s
}
