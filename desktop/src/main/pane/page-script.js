// Injected into every page the browser pane opens (plain JS, runs in the page; ported from Saram desktop).
// Gives elements stable refs ("ref_N") and builds the accessibility-style outline used by read_page / find /
// get_page_text. Password fields are refused here for form_input and at points for clicks (design tab 5).
(() => {
  if (window.__claude) return;
  const byRef = new Map();
  const refOf = new WeakMap();
  let next = 0;

  const ref = (el) => {
    let r = refOf.get(el);
    if (!r) {
      r = `ref_${++next}`;
      refOf.set(el, r);
      byRef.set(r, new WeakRef(el));
    }
    return r;
  };
  const get = (r) => {
    const el = byRef.get(r)?.deref();
    return el && el.isConnected ? el : null;
  };

  /**
   * A field the AI may not fill: "password" (type=password, or autocomplete current-password / new-password) or
   * "payment" (autocomplete cc-number / cc-csc / cc-exp*, or a name / id naming a card number, expiry or security
   * code). "" otherwise. Same rules as PW_CHECK in pane.ts (the desktop's isolated-world copy).
   */
  const isPw = (el) => {
    if (!el || el.tagName !== "INPUT") return "";
    const ac = el.getAttribute("autocomplete") ?? "";
    if ((el.getAttribute("type") ?? "").toLowerCase() === "password" || /(^|\s)(current-|new-)?password(\s|$)/i.test(ac)) return "password";
    if (/(^|\s)cc-(number|csc|exp|exp-month|exp-year)(\s|$)/i.test(ac)) return "payment";
    const id = `${el.getAttribute("name") ?? ""} ${el.id ?? ""}`;
    if (/card|cvc|cvv|\bcsc\b|cc-?num|cc-?exp|security-?_?code/i.test(id)) return "payment";
    return "";
  };
  /** the focused element, through open shadow roots */
  const deepActive = () => {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    return el;
  };
  /** the element drawn at a viewport point, through open shadow roots */
  const deepAt = (x, y) => {
    let el = document.elementFromPoint(x, y);
    while (el && el.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  };
  const passwordFocused = () => isPw(deepActive());
  const passwordAt = (x, y) => {
    const el = deepAt(x, y);
    if (isPw(el)) return isPw(el);
    // a click on the <label> of a password field focuses it too
    const label = el && el.closest ? el.closest("label") : null;
    return label ? isPw(label.control) : "";
  };
  const passwordRef = (r) => isPw(get(r));

  const clean = (s, max = 100) => {
    const t = String(s ?? "").replace(/\s+/g, " ").trim();
    return t.length > max ? `${t.slice(0, max)}…` : t;
  };

  const INPUT_ROLES = { checkbox: "checkbox", radio: "radio", button: "button", submit: "button", reset: "button", image: "button", range: "slider", number: "spinbutton", search: "searchbox", file: "button" };
  const TAG_ROLES = {
    button: "button", select: "combobox", textarea: "textbox", img: "img", nav: "navigation", main: "main", header: "banner", footer: "contentinfo",
    form: "form", ul: "list", ol: "list", li: "listitem", table: "table", tr: "row", td: "cell", th: "columnheader", dialog: "dialog", aside: "complementary",
    section: "region", article: "article", summary: "button", option: "option", label: "label", fieldset: "group", progress: "progressbar", h1: "heading",
    h2: "heading", h3: "heading", h4: "heading", h5: "heading", h6: "heading", p: "paragraph", iframe: "iframe", video: "video", audio: "audio",
  };
  const INTERACTIVE_ROLES = new Set(["button", "link", "checkbox", "radio", "tab", "menuitem", "option", "switch", "combobox", "textbox", "searchbox", "slider", "spinbutton", "treeitem"]);
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "META", "LINK", "HEAD"]);

  const roleOf = (el) => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.split(" ")[0];
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return el.hasAttribute("href") ? "link" : "generic";
    if (tag === "input") return INPUT_ROLES[(el.getAttribute("type") ?? "text").toLowerCase()] ?? "textbox";
    if (el.isContentEditable && el.getAttribute("contenteditable") !== null) return "textbox";
    return TAG_ROLES[tag] ?? "generic";
  };

  const isInteractive = (el, role) =>
    INTERACTIVE_ROLES.has(role) || el.hasAttribute("onclick") || (el.hasAttribute("tabindex") && el.tabIndex >= 0 && el !== document.body);

  const labelText = (el) => {
    if (el.labels?.length) return Array.from(el.labels).map((l) => l.innerText).join(" ");
    return "";
  };

  const nameOf = (el, role) => {
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = by.split(/\s+/).map((id) => document.getElementById(id)?.innerText ?? "").join(" ");
      if (t.trim()) return clean(t);
    }
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") {
      const type = (el.getAttribute("type") ?? "").toLowerCase();
      if (type === "submit" || type === "button" || type === "reset") return clean(el.value || type);
      return clean(labelText(el) || el.getAttribute("placeholder") || el.title || el.name || "");
    }
    if (tag === "img") return clean(el.alt || el.title || "");
    if (["link", "button", "heading", "option", "tab", "menuitem", "label", "cell", "columnheader", "listitem", "checkbox", "radio", "treeitem"].includes(role)) {
      return clean(el.innerText || el.textContent || el.title || "");
    }
    return clean(el.title || "");
  };

  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) !== 0;
  };

  const attrs = (el, role) => {
    const out = [];
    const tag = el.tagName.toLowerCase();
    if (role === "heading") out.push(`level=${tag[1] ?? el.getAttribute("aria-level") ?? ""}`);
    if (role === "link" && el.getAttribute("href")) out.push(`href="${clean(el.getAttribute("href"), 80)}"`);
    if (tag === "input" || tag === "textarea" || tag === "select") {
      const type = (el.getAttribute("type") ?? "").toLowerCase();
      if (type && !["submit", "button", "reset", "checkbox", "radio"].includes(type)) out.push(`type=${type}`);
      if (el.value && !["submit", "button", "reset"].includes(type) && !isPw(el)) out.push(`value="${clean(el.value, 60)}"`);
      if (el.getAttribute("placeholder")) out.push(`placeholder="${clean(el.getAttribute("placeholder"), 40)}"`);
    }
    if (el.checked) out.push("checked");
    if (el.disabled || el.getAttribute("aria-disabled") === "true") out.push("disabled");
    if (el.getAttribute("aria-expanded")) out.push(`expanded=${el.getAttribute("aria-expanded")}`);
    if (el.selected || el.getAttribute("aria-selected") === "true") out.push("selected");
    if (el.required) out.push("required");
    return out.length ? ` ${out.join(" ")}` : "";
  };

  const ownText = (el) => {
    let t = "";
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.textContent;
    return clean(t, 200);
  };

  const MEANINGFUL = new Set(["heading", "img", "list", "listitem", "navigation", "main", "banner", "contentinfo", "form", "table", "row", "cell", "columnheader", "dialog", "region", "complementary", "article", "paragraph", "group", "label", "progressbar", "status", "alert", "iframe", "video"]);

  /** Outline of the page. `all` includes hidden elements; `interactive` only visible controls. */
  const tree = ({ filter = "all", depth = 15, refId, maxChars = 50000 } = {}) => {
    const root = refId ? get(refId) : document.body;
    if (!root) return { text: "", error: refId ? `No element ${refId}` : "Page has no body" };
    const lines = [];
    const walk = (el, d) => {
      if (SKIP.has(el.tagName)) return;
      const role = roleOf(el);
      const interactive = isInteractive(el, role);
      const visible = isVisible(el);
      let emitted = false;
      if (filter === "interactive") {
        if (interactive && visible) {
          lines.push(`- ${role}${nameOf(el, role) ? ` "${nameOf(el, role)}"` : ""} [${ref(el)}]${attrs(el, role)}`);
        }
      } else if (d <= depth) {
        const name = nameOf(el, role);
        const text = !name && !interactive ? ownText(el) : "";
        if (interactive || MEANINGFUL.has(role) || text || el === root) {
          const hidden = visible ? "" : " (hidden)";
          lines.push(`${"  ".repeat(d)}- ${role}${name ? ` "${name}"` : ""}${text ? ` "${text}"` : ""} [${ref(el)}]${attrs(el, role)}${hidden}`);
          emitted = true;
        }
      }
      // controls with a name already say what is inside them
      if (filter !== "interactive" && interactive && nameOf(el, role) && el.tagName !== "SELECT") return;
      for (const child of el.children) walk(child, emitted ? d + 1 : d);
      if (el.shadowRoot) for (const child of el.shadowRoot.children) walk(child, emitted ? d + 1 : d);
    };
    walk(root, 0);
    let text = lines.join("\n");
    if (text.length > maxChars) {
      const cut = text.lastIndexOf("\n", maxChars);
      text = `${text.slice(0, cut > 0 ? cut : maxChars)}\n… output truncated (${text.length} chars in full); pass a larger max_chars or use depth / ref_id.`;
    }
    return { text };
  };

  const SYNONYMS = {
    search: ["search", "검색", "cari", "pencarian", "query", "q", "find"], cart: ["cart", "장바구니", "keranjang", "basket", "bag"], login: ["login", "log in", "sign in", "masuk", "로그인"],
    button: ["button", "버튼", "tombol"], link: ["link", "링크", "tautan"], input: ["input", "textbox", "field", "입력"], price: ["price", "가격", "harga", "원", "Rp", "$"],
    submit: ["submit", "제출", "확인", "send", "보내기", "kirim"], next: ["next", "다음", "berikutnya", "lanjut"], close: ["close", "닫기", "tutup", "×", "✕"],
  };
  /** the word plus synonyms; compounds count too ("검색창" → 검색, "장바구니버튼" → 장바구니) */
  const expand = (word) => {
    const forms = new Set([word]);
    for (const list of Object.values(SYNONYMS)) if (list.some((f) => f === word || (f.length > 1 && word.includes(f)))) list.forEach((f) => forms.add(f));
    const stem = word.replace(/(창|칸|란|버튼|링크|필드|입력란)$/, "");
    if (stem && stem !== word) forms.add(stem);
    return [...forms];
  };

  /** Rank visible elements by how well their role / name / text match the query. */
  const find = (query) => {
    const words = String(query).toLowerCase().split(/[\s,]+/).filter((w) => w.length > 0 && !["the", "a", "an", "of", "for", "on", "in", "with"].includes(w));
    const scored = [];
    for (const el of document.querySelectorAll("body *")) {
      if (SKIP.has(el.tagName) || !isVisible(el)) continue;
      const role = roleOf(el);
      const interactive = isInteractive(el, role);
      if (!interactive && !MEANINGFUL.has(role) && !ownText(el)) continue;
      const name = nameOf(el, role) || ownText(el);
      const hay = [name, role, el.getAttribute("placeholder"), el.id, el.getAttribute("name"), el.getAttribute("type"), el.className?.toString?.(), el.tagName.toLowerCase()]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      let score = 0;
      for (const w of words) {
        const forms = expand(w);
        if (forms.some((f) => name.toLowerCase().includes(f))) score += 3;
        else if (forms.some((f) => hay.includes(f))) score += 1.5;
      }
      if (!score) continue;
      if (interactive) score += 0.5;
      scored.push({ el, role, name, score });
    }
    scored.sort((a, b) => b.score - a.score);
    // best match per ancestor chain only (a link wins over the list item around it)
    const picked = [];
    for (const s of scored) {
      if (picked.some((p) => p.el.contains(s.el) || s.el.contains(p.el))) continue;
      picked.push(s);
      if (picked.length >= 21) break;
    }
    const more = picked.length > 20;
    return {
      matches: picked.slice(0, 20).map((s) => {
        const r = s.el.getBoundingClientRect();
        return `- ${s.role}${s.name ? ` "${s.name}"` : ""} [${ref(s.el)}]${attrs(s.el, s.role)} at (${Math.round(r.x + r.width / 2)}, ${Math.round(r.y + r.height / 2)})`;
      }),
      more,
    };
  };

  /** Main text of the page: the article or main region when there is one. */
  const text = () => {
    const candidates = [document.querySelector("article"), document.querySelector("main"), document.querySelector("[role=main]")].filter(Boolean);
    const main = candidates.find((c) => c.innerText.trim().length > 300);
    return (main ?? document.body)?.innerText ?? "";
  };

  /** Center of a ref'd element after scrolling it into view, in viewport pixels. */
  const center = (r) => {
    const el = get(r);
    if (!el) return null;
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const b = el.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2, name: nameOf(el, roleOf(el)) || ownText(el) || el.tagName.toLowerCase() };
  };

  const describe = (r) => {
    const el = get(r);
    return el ? { role: roleOf(el), name: nameOf(el, roleOf(el)), tag: el.tagName.toLowerCase(), type: (el.getAttribute("type") ?? "").toLowerCase() } : null;
  };

  /** Set a form control like a user would (native setter + input/change events). */
  const setValue = (r, value) => {
    const el = get(r);
    if (!el) return { ok: false, error: `No element ${r} on the page (it may have changed). Call read_page or find again.` };
    const secret = isPw(el);
    if (secret === "password") return { ok: false, password: "password", error: `${r} is a password field. The AI may not type passwords; ask the user to type it in the browser pane.` };
    if (secret === "payment") return { ok: false, password: "payment", error: `${r} is a payment card field. The AI may not type card numbers, expiry dates or security codes; ask the user to type it in the browser pane.` };
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") ?? "").toLowerCase();
    const fire = () => {
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    };
    el.scrollIntoView({ block: "center", behavior: "instant" });
    if (tag === "input" && (type === "checkbox" || type === "radio")) {
      const want = value === true || value === "true";
      if (el.checked !== want) el.click();
      return { ok: true, name: nameOf(el, roleOf(el)) };
    }
    if (tag === "select") {
      const v = String(value);
      const opt = Array.from(el.options).find((o) => o.value === v) ?? Array.from(el.options).find((o) => o.text.trim() === v);
      if (!opt) return { ok: false, error: `No option "${v}" in ${r}.` };
      el.value = opt.value;
      fire();
      return { ok: true, name: nameOf(el, roleOf(el)) };
    }
    if (tag === "input" || tag === "textarea") {
      el.focus();
      const proto = tag === "input" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, String(value));
      fire();
      return { ok: true, name: nameOf(el, roleOf(el)) };
    }
    if (el.isContentEditable) {
      el.focus();
      el.textContent = String(value);
      fire();
      return { ok: true, name: nameOf(el, roleOf(el)) };
    }
    return { ok: false, error: `${r} is not a form control.` };
  };

  window.__claude = { ref, get, tree, find, text, center, describe, setValue, passwordFocused, passwordAt, passwordRef };
})();
