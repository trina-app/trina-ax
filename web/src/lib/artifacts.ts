// How artifacts (and HTML / SVG / XML file previews) run: an opaque-origin iframe (sandbox="allow-scripts" only)
// whose document starts with a Content-Security-Policy that blocks every network request except this team
// server's /vendor/ libraries (tab 5 "아티팩트 격리 규칙"). The document always goes in through srcdoc, never a
// blob: URL (blob: inherits the app's origin). React artifacts are compiled here, outside the frame (sucrase), so
// the frame needs no 'unsafe-eval'. Ported from Saram/chat-proto sandbox.ts, with the sandbox tightened and the CDN
// imports replaced by /vendor/.
import type { ArtifactType } from '@mycel/shared/api'

export const SANDBOX = 'allow-scripts'

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

export function vendorBase(origin: string) {
  return `${origin}/vendor/`
}

/** The frame's CSP. connect-src / form-action / frame-src 'none': nothing the artifact sees can leave the page. */
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

/** Posts runtime errors and the "loaded" signal to the host; the host checks event.source. */
const BRIDGE = `<script>(function(){
  var report = function (m) { try { parent.postMessage({ source: "mycel-frame", type: "error", message: String(m).slice(0, 2000) }, "*"); } catch (e) {} };
  window.__report = report;
  window.addEventListener("error", function (e) { report(e.message || e.error); });
  window.addEventListener("unhandledrejection", function (e) { report(e.reason && e.reason.message || e.reason); });
  document.addEventListener("securitypolicyviolation", function (e) { report("Blocked by the sandbox: " + e.violatedDirective + " " + (e.blockedURI || "")); });
})();</script>`

const BASE_STYLE = `<style>html,body{margin:0}body{font-family:Pretendard,-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR","Segoe UI",sans-serif;color:#1f1d1a;background:#fff}</style>`

function head(origin: string, extra = '') {
  return `<head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escAttr(artifactCsp(origin))}"><meta name="viewport" content="width=device-width,initial-scale=1">${BRIDGE}${BASE_STYLE}${extra}</head>`
}

/**
 * Wrap any HTML so our <head> (CSP first) comes before anything the AI or the file wrote. If the content is a full
 * document, its own <html>/<head> tags end up inside our body, where the parser ignores them (its styles and scripts
 * still work, its CSP / base meta tags do not).
 */
export function wrapHtml(content: string, origin: string): string {
  const body = content.replace(/^\s*<!doctype[^>]*>/i, '')
  return `<!doctype html><html>${head(origin)}<body>${body}</body></html>`
}

export type Srcdoc = { ok: true; html: string } | { ok: false; error: string }

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

export interface SrcdocMessages {
  unsupportedImports: (list: string) => string
  compileError: (msg: string) => string
  noDefaultExport: string
}

/** The document an artifact runs as. Markdown and code are shown by the host, not in a frame. */
export function buildArtifactSrcdoc(type: ArtifactType, content: string, origin: string, compile: CompileFn | null, msg: SrcdocMessages): Srcdoc {
  const v = vendorBase(origin)
  switch (type) {
    case 'html':
      return { ok: true, html: wrapHtml(content, origin) }
    case 'svg':
      return { ok: true, html: `<!doctype html><html>${head(origin, '<style>html,body{height:100%}body{display:grid;place-items:center}svg{max-width:100%;max-height:100vh}</style>')}<body>${content}</body></html>` }
    case 'mermaid':
      return {
        ok: true,
        html: `<!doctype html><html>${head(origin, '<style>body{padding:24px;display:flex;justify-content:center}#out svg{max-width:100%;height:auto}</style>')}<body><div id="out"></div>
<script type="module">
  import mermaid from ${scriptJson(v + VENDOR_MERMAID)};
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral" });
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
