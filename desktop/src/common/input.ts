// Pure helpers for the browser pane: key combos -> CDP key events, URL redaction. Ported from Saram desktop/src/input.ts.
// Unit-tested in tests/unit/e-desktop-common.test.ts.

export class ToolError extends Error {}

/** CDP modifier bitmask */
export const MOD_BITS: Record<string, number> = { alt: 1, option: 1, ctrl: 2, control: 2, cmd: 4, command: 4, meta: 4, win: 4, windows: 4, shift: 8 };

export interface KeyDef {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
}

const NAMED_KEYS: Record<string, KeyDef> = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  return: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  esc: { key: "Escape", code: "Escape", keyCode: 27 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  left: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
};

/** Editing shortcuts Chromium only runs from synthetic events when told the command. */
const COMMANDS: Record<string, string> = { a: "selectAll", c: "copy", v: "paste", x: "cut", z: "undo" };

/** "cmd+a" → key definition + modifier bits (+ editing command). */
export function parseKeyCombo(combo: string): { def: KeyDef; modifiers: number; command?: string } {
  const parts = combo.split("+");
  const main = parts.pop() ?? "";
  let modifiers = 0;
  for (const m of parts) modifiers |= MOD_BITS[m.toLowerCase()] ?? 0;
  const lower = main.toLowerCase();
  let def = NAMED_KEYS[lower];
  if (!def && /^f([1-9]|1[0-2])$/.test(lower)) def = { key: main.toUpperCase(), code: main.toUpperCase(), keyCode: 111 + Number(lower.slice(1)) };
  if (!def && main.length === 1) {
    const upper = main.toUpperCase();
    const isLetter = /[A-Z]/.test(upper);
    const isDigit = /[0-9]/.test(main);
    def = { key: main, code: isLetter ? `Key${upper}` : isDigit ? `Digit${main}` : "", keyCode: isLetter || isDigit ? upper.charCodeAt(0) : 0, text: main };
  }
  if (!def) throw new ToolError(`Unknown key "${main}".`);
  // with ctrl/cmd held the key types nothing
  if (modifiers & (2 | 4)) def = { ...def, text: undefined };
  const command = modifiers & (2 | 4) ? COMMANDS[lower] : undefined;
  return { def, modifiers, command };
}

const SECRET_PARAM = /^(token|access_token|id_token|key|api_key|apikey|auth|authorization|password|passwd|secret|sig|signature|session|code)$/i;
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const k of Array.from(u.searchParams.keys())) if (SECRET_PARAM.test(k)) u.searchParams.set(k, "REDACTED");
    if (u.password) u.password = "REDACTED";
    return u.toString();
  } catch {
    return url;
  }
}

