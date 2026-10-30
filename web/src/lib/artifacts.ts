/// <reference path="../env.d.ts" />
// How artifacts (and HTML / SVG file previews) run (tab 5 "아티팩트 격리 규칙"): an opaque-origin iframe
// (sandbox="allow-scripts" only) that loads the team server's fixed receiver document /sandbox/frame, whose response
// CSP blocks every network request except this server's /vendor/ libraries. The document built here goes in through
// postMessage (components/SandboxFrame.tsx) — never srcdoc or a blob: URL, which would inherit the app's CSP or
// origin — and starts with a meta CSP of the same policy (a second layer). React artifacts are compiled here, outside
// the frame (sucrase), so the frame needs no 'unsafe-eval'. Ported from Saram/chat-proto sandbox.ts, with the
// sandbox tightened and the CDN imports replaced by /vendor/.
import type { ArtifactType } from '@mycel/shared/api'

export const SANDBOX = 'allow-scripts'

const BUILD = typeof __WEB_BUILD__ === 'string' ? __WEB_BUILD__ : 'dev'
/** The receiver document every sandbox frame loads (server/src/routes/web-static.ts SANDBOX_RECEIVER). */
export const SANDBOX_FRAME_URL = `/sandbox/frame?v=${encodeURIComponent(BUILD)}`

/** Libraries a React artifact may import, served by the team server (scripts/build-vendor.ts). */
export const VENDOR_MODULES = {
  react: 'react.js',
  'react/jsx-runtime': 'react-jsx-runtime.js',
  'react-dom': 'react-dom.js',
  'react-dom/client': 'react-dom-client.js',
  'lucide-react': 'lucide-react.js',
  recharts: 'recharts.js',
} as const
export const VENDOR_TAILWIND = 'tailwind.js'
export const VENDOR_MERMAID = 'mermaid.js'
/** Mermaid draws a gantt as wide as the parent of its scratch element, which this frame's flex body shrinks to the
 * content: the chart came out ~250px wide with every date label on top of the next. A fixed width, scaled down by
 * max-width:100%. */
const GANTT_WIDTH = 720

export function vendorBase(origin: string) {
  return `${origin}/vendor/`
}

/**
 * The frame's CSP (meta tag). connect-src / form-action / frame-src 'none': nothing the artifact sees can leave the
 * page. Same directives as sandboxPolicy() in server/src/routes/web-static.ts (checked by tests/unit/d-web.test.ts).
 */
export function artifactCsp(origin: string): string {
  const v = vendorBase(origin)
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' data: blob: ${v}`,
    `style-src 'unsafe-inline' ${v}`,
    'img-src data: blob:',
    `font-src ${v}`,
    "connect-src 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
    "media-src data: blob:",
    "base-uri 'none'",
  ].join('; ')
}

const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
/** JSON for inside an inline <script>: no "</script>" or "<!--" can end it early. */
export const scriptJson = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')

/**
 * Posts runtime errors to the host, and "leaving" when the document is about to be replaced (it tried to navigate
 * away); the host checks event.source.
 */
const BRIDGE = `<script>(function(){
  var report = function (m) { try { parent.postMessage({ source: "mycel-frame", type: "error", message: String(m).slice(0, 2000) }, "*"); } catch (e) {} };
  window.__report = report;
  window.addEventListener("pagehide", function () { try { parent.postMessage({ source: "mycel-frame", type: "leaving" }, "*"); } catch (e) {} });
  window.addEventListener("error", function (e) { report(e.message || e.error); });
  window.addEventListener("unhandledrejection", function (e) { report(e.reason && e.reason.message || e.reason); });
  document.addEventListener("securitypolicyviolation", function (e) { report("Blocked by the sandbox: " + e.violatedDirective + " " + (e.blockedURI || "")); });
})();</script>`

const BASE_STYLE = `<style>html{margin:0}:where(body){margin:0}body{font-family:Pretendard,-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR","Segoe UI",sans-serif;color:#1f1d1a;background:#fff}</style>`

/** Same pattern as the receiver's guard (server/src/routes/web-static.ts): what CSP does not cover. */
const DIRECT_CONNECTIONS = /^(webkit|moz)?RTC|^WebTransport/

/**
 * Second layer under the receiver's guard: the receiver already removed WebRTC / WebTransport / camera and microphone
 * from this realm (document.open keeps the realm), so this normally changes nothing. It matters only if the document
 * ever ran without that receiver.
 */
const NO_DIRECT = `<script>(function(){var k=Object.getOwnPropertyNames(window),i;for(i=0;i<k.length;i++)if(${DIRECT_CONNECTIONS}.test(k[i]))try{Object.defineProperty(window,k[i],{value:undefined,writable:false,configurable:false})}catch(e){}try{Object.defineProperty(navigator,"mediaDevices",{value:undefined,configurable:false})}catch(e){}})();</script>`
const NO_DNS_PREFETCH = '<meta http-equiv="x-dns-prefetch-control" content="off">'

function head(origin: string, extra = '') {
  return `<head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escAttr(artifactCsp(origin))}">${NO_DNS_PREFETCH}<meta name="viewport" content="width=device-width,initial-scale=1">${NO_DIRECT}${BRIDGE}${BASE_STYLE}${extra}</head>`
}

/**
 * A page's text does not touch the panel edge: 16px around the body, like a browser's own default margin but a little
 * roomier. Zero specificity (:where) and placed before the page's own styles, so any page that sets its body margin
 * (or resets everything with `* { margin: 0 }`) for a full-bleed layout still gets exactly that.
 */
const PAGE_GUTTER = `<style>:where(body){margin:16px}</style>`

/**
 * Wrap any HTML so our <head> (CSP first) comes before anything the AI or the file wrote. If the content is a full
 * document, its own <html>/<head> tags end up inside our body, where the parser ignores them (its styles and scripts
 * still work, its CSP / base meta tags do not). `gutter`: an HTML page (artifact or .html file) gets PAGE_GUTTER.
 */
export function wrapHtml(content: string, origin: string, o: { gutter?: boolean } = {}): string {
  const body = content.replace(/^\s*<!doctype[^>]*>/i, '')
  return `<!doctype html><html>${head(origin, o.gutter ? PAGE_GUTTER : '')}<body>${body}</body></html>`
}

export type FrameDoc = { ok: true; html: string } | { ok: false; error: string }

/** Bare imports used by the code that the vendor bundle doesn't have. */
export function findImports(code: string): string[] {
  const specs = new Set<string>()
  const re = /(?:^|[\s;])(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code))) specs.add(m[1]!)
  const dyn = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g
  while ((m = dyn.exec(code))) specs.add(m[1]!)
  return [...specs]
}
export const unsupportedImports = (code: string) => findImports(code).filter((s) => !(s in VENDOR_MODULES))

export interface CompileFn { (code: string): string }

/** Lazy-loaded JSX/TypeScript compiler (only React artifacts need it). */
export const sucraseCompile = async (): Promise<CompileFn> => {
  const { transform } = await import('sucrase')
  return (code) => transform(code, { transforms: ['jsx', 'typescript'], jsxRuntime: 'automatic', production: true }).code
}

export interface FrameDocMessages {
  unsupportedImports: (list: string) => string
  compileError: (msg: string) => string
  noDefaultExport: string
}

/** The document an artifact runs as. Markdown and code are shown by the host, not in a frame. */
export function buildArtifactDocument(type: ArtifactType, content: string, origin: string, compile: CompileFn | null, msg: FrameDocMessages): FrameDoc {
  const v = vendorBase(origin)
  switch (type) {
    case 'html':
      return { ok: true, html: wrapHtml(content, origin, { gutter: true }) }
    case 'svg':
      return { ok: true, html: `<!doctype html><html>${head(origin, '<style>html,body{height:100%}body{display:grid;place-items:center}svg{max-width:100%;max-height:100vh}</style>')}<body>${content}</body></html>` }
    case 'mermaid':
      return {
        ok: true,
        html: `<!doctype html><html>${head(origin, '<style>body{padding:24px;display:flex;justify-content:center}#out{width:100%;text-align:center}#out svg{max-width:100%;height:auto}</style>')}<body><div id="out"></div>
<script type="module">
  import mermaid from ${scriptJson(v + VENDOR_MERMAID)};
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral", gantt: { useWidth: ${GANTT_WIDTH} } });
  const src = ${scriptJson(content)};
  const visible = () => document.visibilityState === "visible" ? Promise.resolve() : new Promise((r) => document.addEventListener("visibilitychange", r, { once: true }));
  const draw = async () => { await visible(); await document.fonts.ready; const { svg } = await mermaid.render("d" + Math.random().toString(36).slice(2), src); document.getElementById("out").innerHTML = svg; };
  try { await draw(); } catch (e) { await new Promise((r) => setTimeout(r, 700)); try { await draw(); } catch (e2) { window.__report(e2 && e2.message || e2); } }
</script></body></html>`,
      }
    case 'react': {
      const bad = unsupportedImports(content)
      if (bad.length) return { ok: false, error: msg.unsupportedImports(bad.join(', ')) }
      if (!compile) return { ok: false, error: msg.compileError('compiler not loaded') }
      let compiled: string
      try {
        compiled = compile(content)
      } catch (e) {
        return { ok: false, error: msg.compileError((e as Error).message) }
      }
      const imports = Object.fromEntries(Object.entries(VENDOR_MODULES).map(([k, f]) => [k, v + f]))
      const moduleUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(compiled)}`
      return {
        ok: true,
        html: `<!doctype html><html>${head(origin, `<script type="importmap">${scriptJson({ imports })}</script><script src="${escAttr(v + VENDOR_TAILWIND)}"></script>`)}<body><div id="root"></div>
<script type="module">
  import { createRoot } from "react-dom/client";
  import { createElement, Component } from "react";
  class Boundary extends Component {
    constructor(p) { super(p); this.state = { error: null }; }
    static getDerivedStateFromError(error) { return { error }; }
    componentDidCatch(error) { window.__report(error && error.message || error); }
    render() { return this.state.error ? createElement("pre", { style: { color: "#b42318", padding: 16, whiteSpace: "pre-wrap" } }, String(this.state.error.message || this.state.error)) : this.props.children; }
  }
  try {
    const mod = await import(${scriptJson(moduleUrl)});
    if (typeof mod.default !== "function") throw new Error(${scriptJson(msg.noDefaultExport)});
    createRoot(document.getElementById("root")).render(createElement(Boundary, null, createElement(mod.default)));
  } catch (e) { window.__report(e && e.message || e); }
</script></body></html>`,
      }
    }
    default:
      return { ok: false, error: type }
  }
}

export const FRAME_TYPES: ArtifactType[] = ['html', 'svg', 'react', 'mermaid']

// ---------------- confidential chats: no scripts outside the desktop app ----------------
/**
 * Whether an artifact or an HTML / SVG preview may run its scripts here (docs/DECISIONS.md "Artifact frames: no direct
 * connections"). The frame blocks WebRTC and every request CSP covers, but a script can still make the browser open a
 * connection to a host name it chose, and the name itself carries data (DNS, TLS SNI): WebKit (Safari, every iPhone
 * browser, the iPhone app) for <link rel=preconnect> and target=_blank clicks, Chrome and Edge when the frame navigates
 * itself (a speculative connection before the app's frame-src refuses the page). Nothing in a page can stop those, so
 * in a confidential chat (Safe operations 1A) scripts run only in the desktop app, whose Electron shell opens none of
 * them; everywhere else the page is shown without scripts (StaticFrame). Other chats run scripts as before.
 */
export function frameRunsScripts(o: { confidential: boolean; desktop: boolean }): boolean {
  return !o.confidential || o.desktop
}

/** Policy of a static view (on top of the app page's own, which the srcdoc document inherits). */
export const STATIC_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; media-src data:; frame-src 'none'; form-action 'none'; base-uri 'none'"

/** The empty document a static view starts as; StaticFrame copies the cleaned page into it (never as markup again). */
export function staticShell(o: { gutter?: boolean } = {}): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escAttr(STATIC_CSP)}">${NO_DNS_PREFETCH}<meta name="viewport" content="width=device-width,initial-scale=1">${BASE_STYLE}${o.gutter ? PAGE_GUTTER : ''}</head><body></body></html>`
}

/** The markup a static view shows for an artifact type; null when it has nothing without scripts (React) or the host
 * draws it itself (Mermaid: the answer's own diagram renderer). */
export function staticSource(type: ArtifactType, content: string): string | null {
  if (type === 'html') return content
  if (type === 'svg') return `<style>html,body{height:100%}body{display:grid;place-items:center}svg{max-width:100%;max-height:100vh}</style>${content}`
  return null
}

/** Elements a static view never shows: they run, load, or open a document or connection of their own. */
const STATIC_DROP = 'script,link,meta,base,iframe,frame,frameset,object,embed,applet,portal,fencedframe,template'
/** Attributes that can only start a request, a navigation or a new window. */
const STATIC_URL_ATTRS = new Set(['href', 'src', 'srcset', 'poster', 'background', 'action', 'formaction', 'ping', 'target', 'attributionsrc', 'srcdoc', 'lowsrc', 'dynsrc', 'longdesc', 'cite', 'manifest', 'codebase', 'archive', 'data', 'usemap'])

/**
 * Cleans a parsed page (DOMParser) for a static view, in place: no scripts, no link hints (WebKit connects for
 * <link rel=preconnect> whatever CSP says), no meta refresh or base, no frames or plugins, no templates (declarative
 * shadow roots), no event handler attributes, no link targets or addresses (a click must not navigate or open a window)
 * and no animation that would set one. Inline images (data:) and in-page SVG references (#id) stay. The result is
 * copied node by node into a frame without scripts (StaticFrame), so what is shown is exactly this tree.
 */
export function cleanStatic(doc: Document): Document {
  for (const el of Array.from(doc.querySelectorAll(STATIC_DROP))) el.remove()
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    const tag = el.localName
    const name = el.getAttribute('attributeName')?.trim().toLowerCase().replace(/^xlink:/, '')
    if ((tag === 'set' || tag.startsWith('animate')) && name && (name === 'href' || STATIC_URL_ATTRS.has(name))) {
      el.remove()
      continue
    }
    const svg = el.namespaceURI === 'http://www.w3.org/2000/svg'
    for (const a of Array.from(el.attributes)) {
      const n = a.localName.toLowerCase()
      const v = a.value.trim()
      const keep =
        !n.startsWith('on') &&
        (!STATIC_URL_ATTRS.has(n) ||
          ((n === 'src' || n === 'poster') && /^data:/i.test(v)) ||
          (n === 'href' && svg && tag !== 'a' && v.startsWith('#')))
      if (!keep) el.removeAttributeNode(a)
    }
  }
  return doc
}

const EXT: Record<ArtifactType, string> = { html: 'html', react: 'jsx', svg: 'svg', mermaid: 'mmd', markdown: 'md', code: 'txt' }
const LANG_EXT: Record<string, string> = {
  python: 'py', py: 'py', javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts', jsx: 'jsx', tsx: 'tsx', shell: 'sh', bash: 'sh', sh: 'sh', zsh: 'sh',
  sql: 'sql', json: 'json', yaml: 'yml', yml: 'yml', html: 'html', css: 'css', go: 'go', rust: 'rs', java: 'java', kotlin: 'kt', swift: 'swift',
  c: 'c', cpp: 'cpp', 'c++': 'cpp', csharp: 'cs', 'c#': 'cs', ruby: 'rb', php: 'php', markdown: 'md', xml: 'xml', toml: 'toml', r: 'r',
}

/** File name for download / "save to the team folder": html→.html, react→.jsx, svg→.svg, mermaid→.mmd, markdown→.md, code→language ext. */
export function artifactFileName(a: { key: string; title: string | null; type: ArtifactType; language: string | null }): string {
  const base = (a.title || a.key).replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 100) || 'artifact'
  if (a.type === 'code') {
    const l = (a.language ?? '').toLowerCase()
    return `${base}.${LANG_EXT[l] ?? (/^[a-z0-9]{1,8}$/.test(l) ? l : 'txt')}`
  }
  return `${base}.${EXT[a.type]}`
}

/** Why an artifact cannot be shown, for the error bar with "ask the AI to fix it" (R2-GEN-09): 'build' when it could
 * not be made into a page (unsupported import, compile error, no default export), 'run' when it failed in the frame. */
export type ArtifactFailure = { kind: 'build' | 'run'; error: string }
export function artifactFailure(frameDoc: FrameDoc | null, runtimeError: string | null): ArtifactFailure | null {
  if (frameDoc && !frameDoc.ok) return { kind: 'build', error: frameDoc.error }
  return runtimeError ? { kind: 'run', error: runtimeError } : null
}

/**
 * The error text (runtime or build) that goes into "ask the AI to fix it". The artifact chose this text (an error message can
 * say anything), and the message is sent as the person's own words, where the server lets web_fetch open URLs without
 * asking (design tab 7 "프롬프트 주입" ①). So URLs in it are defanged ("https[:]//…") and it is cut to 1,000 characters.
 */
export function fixPromptError(message: string): string {
  return fixPromptWords(message, 1000)
}

/** The other AI-chosen words in that message (the artifact's title and key): defanged the same way, so they cannot
 * carry an address into the person's own words either (docs/DECISIONS.md "Outbound web channels"). */
export function fixPromptWords(text: string, max: number): string {
  // every "://", wherever it is: the server finds an address at any "http(s)://", even inside a word (_https://…)
  const s = text.replace(/:\/\//g, '[:]//')
  return s.length > max ? s.slice(0, max) + '…' : s
}
