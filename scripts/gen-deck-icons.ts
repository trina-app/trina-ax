// The intro deck's Lucide icons (docs/DECISIONS.md "D2"; DESIGN §7): writes server/src/intro-deck/icons.ts and the
// notice resources/notices/lucide/ from the lucide-react the web app depends on (its installed dist/esm/icons). Dev time
// only, not part of the build; run it after changing the name list or lucide-react, and commit what it writes:
//   bun scripts/gen-deck-icons.ts
// Every element (path, circle, ellipse, rect, line, polyline, polygon) becomes absolute M, L, C and Z path data in
// Lucide's 24 × 24 grid: relative commands made absolute, H/V/S/Q/T expanded, arcs, circles, ellipses and rounded
// corners as cubic Béziers (at most 90° per curve), numbers to 3 decimals. The HTML, PDF and PowerPoint writers then
// draw an icon as plain paths. No dependency of its own; tests/unit/b-intro-deck-icons.test.ts checks the output is
// up to date.
import fs from 'node:fs'
import path from 'node:path'

const REPO = path.resolve(import.meta.dir, '..')
export const ICONS_FILE = path.join(REPO, 'server/src/intro-deck/icons.ts')
export const NOTICE_DIR = path.join(REPO, 'resources/notices/lucide')
/** the line that ends the generated part of icons.ts; the code below it is written by hand and kept */
export const GENERATED_END = '// ── end of the generated part (the code below is written by hand) ──'

/** The names the AI may pick (the tool description lists them), by DESIGN §7's categories. A name lucide-react
 * re-exports from another file (`home` → `house`) is stored under the name it points to. */
export const DECK_ICON_NAMES = [
  // industry and making
  'factory', 'cpu', 'memory-stick', 'server', 'car', 'truck', 'warehouse', 'forklift', 'container', 'boxes',
  'hard-hat', 'hammer', 'drill', 'wrench', 'cog', 'settings', 'bot', 'fuel', 'plug', 'battery-charging', 'zap', 'ship',
  'plane', 'train-front', 'bus', 'bike',
  // food and retail
  'coffee', 'bean', 'store', 'shopping-bag', 'shopping-cart', 'package', 'cup-soda', 'utensils', 'chef-hat',
  'croissant', 'wine', 'glass-water', 'apple', 'wheat', 'milk', 'fish',
  // people and service
  'users', 'user', 'headset', 'handshake', 'heart-handshake', 'graduation-cap', 'school', 'baby', 'smile',
  'briefcase-business', 'hospital', 'stethoscope', 'pill', 'heart-pulse', 'dog', 'paw-print', 'scissors', 'shirt',
  // communication and devices
  'message-circle', 'message-square', 'messages-square', 'megaphone', 'inbox', 'mail', 'phone', 'send', 'bell',
  'video', 'newspaper', 'radio', 'tv', 'languages', 'headphones', 'music', 'wifi', 'smartphone', 'monitor', 'laptop',
  // data
  'chart-column', 'chart-bar', 'chart-line', 'chart-pie', 'database', 'layers', 'layout-grid', 'percent',
  'trending-up', 'trending-down', 'gauge', 'activity', 'git-branch', 'network', 'cloud', 'code', 'qr-code',
  'scan-line',
  // quality and trust
  'shield-check', 'shield', 'badge-check', 'clipboard-check', 'circle-check', 'check-check', 'lock', 'key', 'scale',
  'eye', 'award', 'medal', 'trophy', 'star', 'thumbs-up',
  // time and process
  'calendar', 'calendar-sync', 'calendar-check', 'clock', 'timer', 'hourglass', 'refresh-cw', 'workflow', 'route',
  'list-checks', 'clipboard-list', 'milestone', 'flag',
  // nature and place
  'leaf', 'map-pin', 'mountain', 'sprout', 'tree-pine', 'recycle', 'wind', 'sun', 'droplet', 'flame', 'thermometer',
  'snowflake', 'globe', 'map', 'home', 'building', 'building-2', 'landmark',
  // general
  'search', 'play', 'target', 'lightbulb', 'rocket', 'sparkles', 'brain', 'heart', 'book-open', 'banknote', 'wallet',
  'credit-card', 'receipt', 'coins', 'file-text', 'folder', 'image', 'camera', 'palette', 'pen-tool', 'gift', 'tag',
  'ticket', 'microscope', 'flask-conical', 'atom', 'dna', 'puzzle', 'compass', 'circle-dot',
] as const
export const FALLBACK = 'circle-dot'

// ── reading lucide-react ──────────────────────────────────────────────────────────────────────────────────────────
export type IconNode = [string, Record<string, string>]

/** the installed lucide-react the web app resolves (bun links it into web/node_modules) */
export function lucideRoot(repo = REPO): string {
  for (const dir of [path.join(repo, 'web/node_modules/lucide-react'), path.join(repo, 'node_modules/lucide-react')]) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return fs.realpathSync(dir)
  }
  throw new Error('lucide-react is not installed (run bun install)')
}

/** An icon file: its own nodes, or the file it re-exports (`export { default } from './x.mjs'`), followed. */
export function readIcon(iconsDir: string, name: string, depth = 0): { name: string; nodes: IconNode[] } | null {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || depth > 4) return null
  const file = path.join(iconsDir, `${name}.mjs`)
  if (!fs.existsSync(file)) return null
  const src = fs.readFileSync(file, 'utf8')
  const alias = /export \{ default \} from '\.\/([a-z0-9-]+)\.mjs'/.exec(src)
  if (alias) return readIcon(iconsDir, alias[1], depth + 1)
  const at = src.indexOf('node: ')
  if (at < 0) throw new Error(`no icon node in ${name}.mjs`)
  let depthB = 0, end = -1
  for (let i = at + 6; i < src.length; i++) {
    if (src[i] === '[') depthB++
    else if (src[i] === ']' && --depthB === 0) { end = i + 1; break }
  }
  // the node list is a plain literal (unquoted keys, double-quoted values): read it as JSON, never run it
  const json = src.slice(at + 6, end).replace(/([{,]\s*)([A-Za-z][\w-]*)\s*:/g, '$1"$2":')
  const nodes = JSON.parse(json) as IconNode[]
  for (const [, attrs] of nodes) delete attrs.key
  return { name, nodes }
}

/** lucide-react's re-export files: other (mostly older) names → the file they point to */
export function lucideAliases(iconsDir: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const f of fs.readdirSync(iconsDir).sort()) {
    if (!f.endsWith('.mjs')) continue
    const m = /export \{ default \} from '\.\/([a-z0-9-]+)\.mjs'/.exec(fs.readFileSync(path.join(iconsDir, f), 'utf8'))
    if (m) out.set(f.slice(0, -4), m[1])
  }
  return out
}

// ── converting to M / L / C / Z ───────────────────────────────────────────────────────────────────────────────────
export type Seg = ['M', number, number] | ['L', number, number] | ['C', number, number, number, number, number, number] | ['Z']
/** 4/3·(√2 − 1): a quarter circle as one cubic */
const KAPPA = 0.5522847498307936

/** One SVG elliptical arc (SVG 1.1 F.6.5 endpoint → centre) as cubics of at most 90° each. */
export function arcToCubics(x1: number, y1: number, rxIn: number, ryIn: number, phiDeg: number, large: boolean, sweep: boolean, x2: number, y2: number): Seg[] {
  if (x1 === x2 && y1 === y2) return []
  let rx = Math.abs(rxIn), ry = Math.abs(ryIn)
  if (rx === 0 || ry === 0) return [['L', x2, y2]]
  const phi = (phiDeg * Math.PI) / 180, cos = Math.cos(phi), sin = Math.sin(phi)
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2
  const xp = cos * dx + sin * dy, yp = -sin * dx + cos * dy
  const lambda = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry)
  if (lambda > 1) { rx *= Math.sqrt(lambda); ry *= Math.sqrt(lambda) }
  const num = rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp, den = rx * rx * yp * yp + ry * ry * xp * xp
  const coef = (large !== sweep ? 1 : -1) * Math.sqrt(Math.max(0, num / den))
  const cxp = (coef * rx * yp) / ry, cyp = (-coef * ry * xp) / rx
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2, cy = sin * cxp + cos * cyp + (y1 + y2) / 2
  const angle = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
  const t1 = angle(1, 0, (xp - cxp) / rx, (yp - cyp) / ry)
  let dt = angle((xp - cxp) / rx, (yp - cyp) / ry, (-xp - cxp) / rx, (-yp - cyp) / ry)
  if (!sweep && dt > 0) dt -= 2 * Math.PI
  else if (sweep && dt < 0) dt += 2 * Math.PI
  const n = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2) - 1e-9)), step = dt / n
  const k = (4 / 3) * Math.tan(step / 4)
  const at = (a: number): [number, number] => [cx + rx * Math.cos(a) * cos - ry * Math.sin(a) * sin, cy + rx * Math.cos(a) * sin + ry * Math.sin(a) * cos]
  const tangent = (a: number): [number, number] => [-rx * Math.sin(a) * cos - ry * Math.cos(a) * sin, -rx * Math.sin(a) * sin + ry * Math.cos(a) * cos]
  const out: Seg[] = []
  for (let i = 0; i < n; i++) {
    const a1 = t1 + i * step, a2 = a1 + step
    const [px, py] = at(a1), [qx, qy] = i === n - 1 ? [x2, y2] : at(a2)
    const [d1x, d1y] = tangent(a1), [d2x, d2y] = tangent(a2)
    out.push(['C', px + k * d1x, py + k * d1y, qx - k * d2x, qy - k * d2y, qx, qy])
  }
  return out
}

/** SVG path data (any commands, relative or absolute, implicit repeats, packed arc flags) → absolute M/L/C/Z. */
export function parsePath(d: string): Seg[] {
  const out: Seg[] = []
  let i = 0, x = 0, y = 0, sx = 0, sy = 0
  let lastC: [number, number] | null = null, lastQ: [number, number] | null = null
  const skip = () => { while (i < d.length && /[\s,]/.test(d[i])) i++ }
  const more = () => { skip(); return i < d.length && /[-+.\d]/.test(d[i]) }
  const num = () => {
    skip()
    const m = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(d.slice(i))
    if (!m) throw new Error(`bad number at ${i} in "${d}"`)
    i += m[0].length
    return parseFloat(m[0])
  }
  const flag = () => {
    skip()
    const c = d[i]
    if (c !== '0' && c !== '1') throw new Error(`bad arc flag at ${i} in "${d}"`)
    i++
    return c === '1'
  }
  const cubic = (x1: number, y1: number, x2: number, y2: number, ex: number, ey: number) => {
    out.push(['C', x1, y1, x2, y2, ex, ey]); lastC = [x2, y2]; x = ex; y = ey
  }
  const quad = (qx: number, qy: number, ex: number, ey: number) => {
    out.push(['C', x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), ex + (2 / 3) * (qx - ex), ey + (2 / 3) * (qy - ey), ex, ey])
    lastQ = [qx, qy]; x = ex; y = ey
  }
  for (skip(); i < d.length; skip()) {
    const c = d[i++]
    const rel = c === c.toLowerCase(), C = c.toUpperCase()
    const ox = () => (rel ? x : 0), oy = () => (rel ? y : 0)
    const keepC = C === 'C' || C === 'S', keepQ = C === 'Q' || C === 'T'
    if (!keepC) lastC = null
    if (!keepQ) lastQ = null
    switch (C) {
      case 'M': {
        x = num() + ox(); y = num() + oy(); sx = x; sy = y
        out.push(['M', x, y])
        while (more()) { x = num() + ox(); y = num() + oy(); out.push(['L', x, y]) }
        break
      }
      case 'L': do { x = num() + ox(); y = num() + oy(); out.push(['L', x, y]) } while (more()); break
      case 'H': do { x = num() + ox(); out.push(['L', x, y]) } while (more()); break
      case 'V': do { y = num() + oy(); out.push(['L', x, y]) } while (more()); break
      case 'C': do {
        const x1 = num() + ox(), y1 = num() + oy(), x2 = num() + ox(), y2 = num() + oy()
        cubic(x1, y1, x2, y2, num() + ox(), num() + oy())
      } while (more()); break
      case 'S': do {
        const r: [number, number] = lastC ? [2 * x - lastC[0], 2 * y - lastC[1]] : [x, y]
        const x2 = num() + ox(), y2 = num() + oy()
        cubic(r[0], r[1], x2, y2, num() + ox(), num() + oy())
      } while (more()); break
      case 'Q': do {
        const qx = num() + ox(), qy = num() + oy()
        quad(qx, qy, num() + ox(), num() + oy())
      } while (more()); break
      case 'T': do {
        const q: [number, number] = lastQ ? [2 * x - lastQ[0], 2 * y - lastQ[1]] : [x, y]
        quad(q[0], q[1], num() + ox(), num() + oy())
      } while (more()); break
      case 'A': do {
        const rx = num(), ry = num(), rot = num(), large = flag(), sweep = flag()
        const ex = num() + ox(), ey = num() + oy()
        out.push(...arcToCubics(x, y, rx, ry, rot, large, sweep, ex, ey)); x = ex; y = ey
      } while (more()); break
      case 'Z': out.push(['Z']); x = sx; y = sy; break
      default: throw new Error(`unknown path command "${c}" in "${d}"`)
    }
  }
  return out
}

function ellipseSegs(cx: number, cy: number, rx: number, ry: number): Seg[] {
  const kx = KAPPA * rx, ky = KAPPA * ry
  return [['M', cx + rx, cy],
    ['C', cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry], ['C', cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy],
    ['C', cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry], ['C', cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy], ['Z']]
}

function rectSegs(x: number, y: number, w: number, h: number, rxA?: string, ryA?: string): Seg[] {
  // SVG: a missing rx or ry takes the other's value; both are clamped to half the side
  let rx = rxA !== undefined ? Number(rxA) : ryA !== undefined ? Number(ryA) : 0
  let ry = ryA !== undefined ? Number(ryA) : rx
  rx = Math.min(Math.max(0, rx), w / 2); ry = Math.min(Math.max(0, ry), h / 2)
  if (!rx || !ry) return [['M', x, y], ['L', x + w, y], ['L', x + w, y + h], ['L', x, y + h], ['Z']]
  const kx = KAPPA * rx, ky = KAPPA * ry, r = x + w, b = y + h
  const segs: Seg[] = [['M', x + rx, y]]
  const line = (lx: number, ly: number) => { const p = segs[segs.length - 1]; if (p[0] === 'Z' || p[p.length - 2] !== lx || p[p.length - 1] !== ly) segs.push(['L', lx, ly]) }
  line(r - rx, y); segs.push(['C', r - rx + kx, y, r, y + ry - ky, r, y + ry])
  line(r, b - ry); segs.push(['C', r, b - ry + ky, r - rx + kx, b, r - rx, b])
  line(x + rx, b); segs.push(['C', x + rx - kx, b, x, b - ry + ky, x, b - ry])
  line(x, y + ry); segs.push(['C', x, y + ry - ky, x + rx - kx, y, x + rx, y])
  segs.push(['Z'])
  return segs
}

function points(s: string): number[] {
  return (s.match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g) ?? []).map(Number)
}

/** one Lucide element → segments */
export function elementSegs([tag, a]: IconNode): Seg[] {
  const n = (k: string) => { const v = Number(a[k] ?? 0); if (!Number.isFinite(v)) throw new Error(`bad ${tag} ${k}`); return v }
  switch (tag) {
    case 'path': return parsePath(a.d)
    case 'circle': return ellipseSegs(n('cx'), n('cy'), n('r'), n('r'))
    case 'ellipse': return ellipseSegs(n('cx'), n('cy'), n('rx'), n('ry'))
    case 'rect': return rectSegs(n('x'), n('y'), n('width'), n('height'), a.rx, a.ry)
    case 'line': return [['M', n('x1'), n('y1')], ['L', n('x2'), n('y2')]]
    case 'polyline': case 'polygon': {
      const p = points(a.points), segs: Seg[] = []
      for (let i = 0; i + 1 < p.length; i += 2) segs.push([i ? 'L' : 'M', p[i], p[i + 1]])
      if (tag === 'polygon') segs.push(['Z'])
      return segs
    }
    default: throw new Error(`unknown element <${tag}>`)
  }
}

export const fmt = (v: number) => { const r = Math.round(v * 1000) / 1000; return r === 0 ? '0' : String(r) }
/** segments → "M x y L x y C x1 y1 x2 y2 x y Z", one letter per segment, numbers to 3 decimals */
export function segsToD(segs: Seg[]): string {
  return segs.map(([c, ...v]) => (v.length ? `${c} ${v.map(fmt).join(' ')}` : c)).join(' ')
}
export const iconToPaths = (nodes: IconNode[]) => nodes.map(n => segsToD(elementSegs(n)))

// ── the output ────────────────────────────────────────────────────────────────────────────────────────────────────
export interface DeckIcons {
  version: string
  /** stored name → path data per element, sorted by name */
  icons: [string, string[]][]
  /** other names (requested ones that re-export and lucide-react's own re-export files) → a stored name */
  aliases: [string, string][]
  /** requested names that this lucide-react does not have (dropped) */
  missing: string[]
  /** stored icons that the LICENSE lists as derived from Feather (MIT) */
  feather: string[]
  /** lucide-react's LICENSE, byte for byte */
  license: Buffer
}

export function buildDeckIcons(root = lucideRoot()): DeckIcons {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version as string
  const iconsDir = path.join(root, 'dist/esm/icons')
  const license = fs.readFileSync(path.join(root, 'LICENSE'))
  const icons = new Map<string, string[]>(), aliases = new Map<string, string>(), missing: string[] = []
  for (const want of DECK_ICON_NAMES) {
    const icon = readIcon(iconsDir, want)
    if (!icon) { missing.push(want); continue }
    if (!icons.has(icon.name)) icons.set(icon.name, iconToPaths(icon.nodes))
    if (icon.name !== want) aliases.set(want, icon.name)
  }
  if (!icons.has(FALLBACK)) throw new Error(`the fallback ${FALLBACK} is missing`)
  // lucide-react's own other names for the stored icons (an AI often writes an older one: alert-triangle, bar-chart)
  const files = lucideAliases(iconsDir)
  for (const [alias] of files) {
    if (icons.has(alias) || aliases.has(alias)) continue
    let target = alias
    for (let hop = 0; hop < 5 && files.has(target); hop++) target = files.get(target)!
    if (icons.has(target)) aliases.set(alias, target)
  }
  // the LICENSE names the Feather-derived icons by their Feather names; some are lucide-react re-export names now
  const text = license.toString('utf8')
  const list = /derived from the Feather project:\s*([\s\S]*?)\n\s*\n/.exec(text)
  if (!list) throw new Error('the LICENSE no longer lists the Feather-derived icons')
  const featherNames = new Set(list[1].split(/,\s*/).map(s => s.trim()).filter(Boolean))
  const feather = [...icons.keys()].filter(n => featherNames.has(n) || [...aliases].some(([a, t]) => t === n && featherNames.has(a))).sort()
  const byName = (a: [string, unknown], b: [string, unknown]) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
  return { version, icons: [...icons].sort(byName), aliases: [...aliases].sort(byName), missing, feather, license }
}

const q = (s: string) => `'${s}'`
const wrap = (words: string[], width: number, indent: string) => {
  const lines: string[] = []
  let line = ''
  for (const w of words) {
    if (line && line.length + 1 + w.length > width) { lines.push(line); line = '' }
    line = line ? `${line} ${w}` : w
  }
  if (line) lines.push(line)
  return lines.map(l => indent + l).join('\n')
}

/** the part of icons.ts above GENERATED_END */
export function renderGenerated(b: DeckIcons): string {
  return [
    `// Generated by scripts/gen-deck-icons.ts (bun scripts/gen-deck-icons.ts) from lucide-react ${b.version}: do not edit above`,
    '// the "end of the generated part" line.',
    '// Lucide (https://lucide.dev), ISC License, Copyright (c) 2026 Lucide Icons and Contributors. The Feather-derived',
    '// icons among these are MIT, Copyright (c) 2013-present Cole Bemis:',
    wrap(b.feather.map((n, i) => n + (i < b.feather.length - 1 ? ',' : '.')), 116, '//   '),
    '// Both licence texts: resources/notices/lucide/ (every server bundle carries them in licenses/lucide/).',
    "// Each icon is its elements in Lucide's 24 × 24 grid as absolute M, L, C and Z path data (relative commands made",
    '// absolute, H/V/S/Q/T expanded, arcs, circles, ellipses and rounded corners as cubic Béziers), numbers to 3 decimals.',
    "import type { PathItem } from './layout'",
    '',
    `export const LUCIDE_VERSION = '${b.version}'`,
    '/** name → path data, one string per element (24 grid) */',
    'const ICONS: Record<string, readonly string[]> = {',
    ...b.icons.map(([n, paths]) => `  ${q(n)}: [${paths.map(q).join(', ')}],`),
    '}',
    "/** other names lucide-react gives these icons (older names, re-exports) → the name in ICONS */",
    'const ALIASES: Record<string, string> = {',
    wrap(b.aliases.map(([a, t]) => `${q(a)}: ${q(t)},`), 116, '  '),
    '}',
    GENERATED_END,
    '',
  ].join('\n')
}

export function renderNotice(b: DeckIcons): string {
  return [
    'Lucide icons',
    '',
    'The Trina AX server draws a subset of the Lucide icons in the intro decks it makes (company introduction slides: HTML',
    `preview, PDF and PowerPoint). The subset comes from lucide-react ${b.version} (https://github.com/lucide-icons/lucide,`,
    'package lucide-react), the same icon set the web app uses. scripts/gen-deck-icons.ts converts the icons\' shapes into',
    'path data (Bézier curves, the same geometry) in server/src/intro-deck/icons.ts; nothing else is changed.',
    '',
    'Lucide is licensed under the ISC License, Copyright (c) 2026 Lucide Icons and Contributors. The icons Lucide lists as',
    'derived from the Feather project are under the MIT License, Copyright (c) 2013-present Cole Bemis. Both texts are in',
    'LICENSE.txt next to this file, as lucide-react ships it (its LICENSE).',
    '',
    `Icons in the subset (${b.icons.length}):`,
    wrap(b.icons.map(([n], i) => n + (i < b.icons.length - 1 ? ',' : '')), 116, '  '),
    '',
    `Of these, derived from Feather (MIT) (${b.feather.length}):`,
    wrap(b.feather.map((n, i) => n + (i < b.feather.length - 1 ? ',' : '')), 116, '  '),
    '',
    'Source: https://github.com/lucide-icons/lucide',
    '',
  ].join('\n')
}

/** icons.ts with its generated part replaced (the hand-written code below GENERATED_END is kept) */
export function renderIconsFile(b: DeckIcons, current: string): string {
  const at = current.indexOf(GENERATED_END)
  if (at < 0) throw new Error(`icons.ts has no "${GENERATED_END}" line`)
  return renderGenerated(b) + current.slice(at + GENERATED_END.length + 1)
}

if (import.meta.main) {
  const b = buildDeckIcons()
  fs.writeFileSync(ICONS_FILE, renderIconsFile(b, fs.readFileSync(ICONS_FILE, 'utf8')))
  fs.mkdirSync(NOTICE_DIR, { recursive: true })
  fs.writeFileSync(path.join(NOTICE_DIR, 'NOTICE.txt'), renderNotice(b))
  fs.writeFileSync(path.join(NOTICE_DIR, 'LICENSE.txt'), b.license)
  console.log(`icons.ts: ${b.icons.length} icons, ${b.aliases.length} other names, lucide-react ${b.version}` +
    (b.missing.length ? `; not in this version (dropped): ${b.missing.join(', ')}` : ''))
}
