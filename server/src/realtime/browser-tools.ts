// Browser pane tools as the engine sees them (mcp__team__<name>): names and input shapes of the Claude desktop
// app's in-app browser, ported from Saram server/src/browser-tools.ts (d315378). The desktop app (component E)
// validates the inputs against its own schemas (shared/src/browser-tools.ts) and runs them over CDP.
import type { BrowserToolName } from '@mycel/shared/api'

const tabId = {
  tabId: { type: "string", description: "Tab to act on within the browser pane. Omit for the fronted tab." },
};

const COMPUTER_ACTIONS = ["left_click", "right_click", "type", "screenshot", "wait", "scroll", "key", "left_click_drag", "double_click", "triple_click", "zoom", "scroll_to", "hover"];

export const PANE_TOOLS = [
  {
    name: "preview_start",
    description:
      "Open the Browser pane at a URL (a fresh browser tab, shown next to the chat). Returns a tabId; pass it to read_page / computer / navigate / etc., or omit tabId to act on the fronted tab.",
    inputSchema: { type: "object", properties: { url: { type: "string", description: "URL to open in the Browser pane." } }, required: ["url"] },
  },
  {
    name: "read_page",
    description:
      "Read the current page in the Browser pane as a YAML-style accessibility tree. Each interactive element is tagged [ref_N] for computer / form_input / find. Prefer this over screenshots for text and structure. Output is cut at max_chars (default 50000); use ref_id or depth to focus.",
    inputSchema: {
      type: "object",
      properties: {
        ...tabId,
        filter: { type: "string", enum: ["interactive", "all"], description: "'interactive' returns only clickable/typable elements; 'all' (default) the full tree." },
        depth: { type: "number", description: "Maximum tree depth (default 15)." },
        ref_id: { type: "string", description: "Only descendants of this ref_N." },
        max_chars: { type: "number", description: "Maximum characters of output (default 50000)." },
      },
    },
  },
  {
    name: "computer",
    description:
      "Mouse and keyboard in the Browser pane. Clicks take either coordinate (pixels of the latest screenshot's coordinate frame) or ref (ref_N from read_page / find). Look at a screenshot before clicking by coordinate, and take a new one after the tab loads another site.",
    inputSchema: {
      type: "object",
      properties: {
        ...tabId,
        action: {
          type: "string",
          enum: COMPUTER_ACTIONS,
          description:
            "left_click / right_click / double_click / triple_click at coordinate or ref; type text; key: space-separated keys or combos (cmd+a on Mac, ctrl+a elsewhere); screenshot; zoom a region; scroll at coordinate; scroll_to a ref; left_click_drag from start_coordinate to coordinate; hover; wait duration seconds.",
        },
        coordinate: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2, description: "(x, y) in viewport pixels. End position for left_click_drag." },
        text: { type: "string", description: "Text for type, keys for key. Page zoom shortcuts are not supported; use zoom." },
        duration: { type: "number", minimum: 0, maximum: 10, description: "Seconds for wait (max 10)." },
        scroll_direction: { type: "string", enum: ["up", "down", "left", "right"] },
        scroll_amount: { type: "number", minimum: 1, maximum: 10, description: "Wheel ticks, default 3." },
        start_coordinate: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
        region: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4, description: "(x0, y0, x1, y1) for zoom." },
        scale: { type: "number", minimum: 0.1, maximum: 1, description: "screenshot/zoom image size factor; coordinates stay in the full-size frame." },
        repeat: { type: "number", minimum: 1, maximum: 100, description: "Repeat the key sequence." },
        ref: { type: "string", description: "Element ref (ref_N). Required for scroll_to; alternative to coordinate." },
        modifiers: { type: "string", description: 'Modifier keys held during a click: "ctrl", "shift", "alt", "cmd", joined with "+".' },
        save_to_disk: { type: "boolean", description: "screenshot/zoom: also show the image to the user in the chat. Only when you mean to share it." },
      },
      required: ["action"],
    },
  },
  {
    name: "form_input",
    description: "Set the value of a form element by ref (from read_page / find). Handles input, textarea, select, checkbox and contenteditable.",
    inputSchema: {
      type: "object",
      properties: {
        ...tabId,
        ref: { type: "string", description: 'Element ref, e.g. "ref_1".' },
        value: { type: ["string", "boolean", "number"], description: "Checkboxes take a boolean, selects an option value or text, other inputs a string or number." },
      },
      required: ["ref", "value"],
    },
  },
  {
    name: "navigate",
    description: 'Navigate the Browser pane to a URL, or go "back" / "forward" in history. If the pane is not open yet, this opens it at the URL.',
    inputSchema: {
      type: "object",
      properties: {
        ...tabId,
        url: { type: "string", description: 'URL (https:// is added if missing), or "back" / "forward".' },
        force: { type: "boolean", description: 'Discard unsaved changes if the page asks "Leave site?".' },
      },
      required: ["url"],
    },
  },
  {
    name: "find",
    description: "Search the page for elements whose role, name or text contains query (case-insensitive). Returns up to 20 ref_N matches.",
    inputSchema: { type: "object", properties: { ...tabId, query: { type: "string", description: 'Text to look for, e.g. "Sign in", "search", "Add to cart".' } }, required: ["query"] },
  },
  {
    name: "get_page_text",
    description: "Visible text of the page (article / main content first, then body).",
    inputSchema: { type: "object", properties: { ...tabId, max_chars: { type: "number", description: "Maximum characters (default 50000)." } } },
  },
  {
    name: "javascript_tool",
    description:
      "Execute JavaScript in the Browser pane's page. Runs in the page context with REPL semantics: top-level await works and the last expression's value is returned (write the expression, not return ...). Returns JSON.",
    inputSchema: {
      type: "object",
      properties: { ...tabId, action: { type: "string", enum: ["javascript_exec"] }, text: { type: "string", description: "Code to run." } },
      required: ["action", "text"],
    },
  },
  {
    name: "read_console_messages",
    description: "Console output (log, info, warn, error, debug) of the Browser pane tab.",
    inputSchema: {
      type: "object",
      properties: {
        ...tabId,
        onlyErrors: { type: "boolean", description: "Only error entries." },
        pattern: { type: "string", description: "Substring filter on message text." },
        limit: { type: "number", description: "Max entries (default 50, max 200)." },
      },
    },
  },
  {
    name: "read_network_requests",
    description: "List network requests of the tab, or fetch one response body by requestId.",
    inputSchema: {
      type: "object",
      properties: {
        ...tabId,
        urlPattern: { type: "string", description: "Substring filter on the URL as listed (auth values show as REDACTED)." },
        requestId: { type: "string", description: "Return this request's response body instead of listing." },
        limit: { type: "number", description: "Max entries when listing (default 50)." },
      },
    },
  },
  {
    name: "resize_window",
    description:
      'Emulate a viewport size in the tab: presets mobile (375x812, also mobile user agent and touch), tablet (768x1024), or desktop (clears the emulation). Custom sizes need width and height. colorScheme emulates prefers-color-scheme. Reset with "desktop" when you are done.',
    inputSchema: {
      type: "object",
      properties: {
        ...tabId,
        preset: { type: "string", enum: ["mobile", "tablet", "desktop"] },
        width: { type: "number" },
        height: { type: "number" },
        colorScheme: { type: "string", enum: ["light", "dark"] },
      },
    },
  },
  {
    name: "tabs_context",
    description:
      "List every Browser pane tab (origin only). Returns {browserOpen, tabs: [{tabId, origin, isActive}]}. browserOpen is false until preview_start or navigate opens the pane.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "tabs_create",
    description: "Open a fresh blank tab and return its tabId. Opens in the background unless foreground: true (the user wants to watch).",
    inputSchema: { type: "object", properties: { foreground: { type: "boolean", description: "Front the new tab." } } },
  },
  {
    name: "tabs_select",
    description: "Front the given tab (only when the user should look at it).",
    inputSchema: { type: "object", properties: { tabId: { type: "string", description: "Tab to front." } }, required: ["tabId"] },
  },
  {
    name: "tabs_close",
    description: "Close one tab. Closing the last tab closes the Browser pane.",
    inputSchema: { type: "object", properties: { tabId: { type: "string", description: "Tab to close." } }, required: ["tabId"] },
  },
  {
    name: "browser_batch",
    description:
      "Run several Browser pane tool calls in ONE round trip, in order, stopping at the first error. Each item is {name, input} as for the tool itself. Use it whenever you can predict two or more steps (click a field, type, press Return, screenshot). Coordinates refer to the screenshot taken before this call. Cannot be nested; preview_start is not batchable, but a batch whose first action is navigate with a url opens the pane.",
    inputSchema: {
      type: "object",
      properties: {
        actions: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: { name: { type: "string", description: "Tool name, e.g. computer, navigate, find, form_input, read_page." }, input: { type: "object" } },
            required: ["name", "input"],
          },
        },
        save_to_disk: { type: "boolean", description: "Show the screenshots of this batch to the user in the chat." },
      },
      required: ["actions"],
    },
  },
] as const;

export type PaneToolName = (typeof PANE_TOOLS)[number]["name"];

/** Whether a tool reads or changes the tab it targets (the app's own classification). */
export const TOOL_KIND: Record<string, "reads-tab" | "mutates-tab" | "no-tab-target"> = {
  read_page: "reads-tab",
  computer: "mutates-tab",
  form_input: "mutates-tab",
  navigate: "mutates-tab",
  find: "reads-tab",
  get_page_text: "reads-tab",
  javascript_tool: "mutates-tab",
  read_console_messages: "reads-tab",
  read_network_requests: "reads-tab",
  resize_window: "mutates-tab",
  tabs_context: "no-tab-target",
  tabs_create: "no-tab-target",
  tabs_select: "mutates-tab",
  tabs_close: "mutates-tab",
  browser_batch: "no-tab-target",
  preview_start: "no-tab-target",
};

/** Every pane tool is a contract BrowserToolName (compile-time check). */
const _names: readonly BrowserToolName[] = PANE_TOOLS.map((t) => t.name)
void _names
export const BROWSER_TOOL_NAMES: ReadonlySet<string> = new Set(PANE_TOOLS.map((t) => t.name))

/** URLs a call would open (navigate / preview_start, and navigate steps inside browser_batch). */
export function urlsOf(tool: string, args: Record<string, unknown>): string[] {
  const out: string[] = []
  if ((tool === 'navigate' || tool === 'preview_start') && typeof args.url === 'string' && args.url !== 'back' && args.url !== 'forward') out.push(args.url)
  if (tool === 'browser_batch' && Array.isArray(args.actions)) {
    for (const a of args.actions as { name?: unknown; input?: Record<string, unknown> }[]) {
      if (a && typeof a.name === 'string' && a.input && typeof a.input === 'object') out.push(...urlsOf(a.name, a.input))
    }
  }
  return out
}
