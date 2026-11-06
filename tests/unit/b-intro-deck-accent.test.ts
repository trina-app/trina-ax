// The intro deck's AI accent sanitizer (docs/DECISIONS.md "D2", round 2): the AI may draw at most two decorative
// accents per deck as SVG in a small grammar; the server reads it with its own XML reader and rebuilds a new SVG from
// an allowlist (theme colour names mapped to hex, numbers re-written, ids renamed), or rejects the whole accent with a
// reason. Every input here is treated as hostile.
import { describe, expect, test } from 'bun:test'
import { DECK_ACCENT_MAX_BYTES } from '@mycel/shared/api'
import { accentDataUri, sanitizeAccent, type AccentColors, type AccentResult } from '../../server/src/intro-deck/accent'

const COLORS: AccentColors = { ink: '#14121F', ground: '#FFFFFF', line: '#e4e2ec', mark: '#5224fd', onMark: '#fafafa' }
const ROOT = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800" width="800" height="800"'
const svg = (body: string, attrs = '') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800"${attrs}>${body}</svg>`
const DOT = '<circle cx="400" cy="400" r="40" fill="mark"/>'

function ok(input: string, colors = COLORS) {
  const r = sanitizeAccent(input, colors)
  if (!r.ok) throw new Error(`rejected: ${r.reason}`)
  return r
}
function rejected(input: string, reason?: RegExp) {
  const r = sanitizeAccent(input, COLORS)
  expect(r.ok).toBe(false)
  if (!r.ok && reason) expect(r.reason).toMatch(reason)
  return r
}

/** What every accepted output must hold. */
function invariants(r: AccentResult & { ok: true }) {
  const out = r.svg
  expect(out.startsWith(`${ROOT}`)).toBe(true)
  expect(out.endsWith('</svg>')).toBe(true)
  expect(out).not.toMatch(/<script/i)
  expect(out).not.toMatch(/\son[a-z]*\s*=/i)
  expect(out).not.toMatch(/href/i)
  expect(out).not.toMatch(/style/i)
  expect(out).not.toMatch(/&/)
  for (const m of out.matchAll(/url\(([^)]*)\)/g)) expect(m[1]).toMatch(/^#a\d+$/)
  expect(out).toMatch(/^[\x20-\x7e]*$/)
  // idempotent: the output sanitizes to itself
  const again = sanitizeAccent(out, COLORS)
  expect(again).toEqual({ ok: true, svg: out, elements: r.elements })
}

// ---- the three mockup accents, written in the grammar the way the AI would ----

/** Semiconductors: a wafer of dies, the dies as one path, a few "hot" dies in the brand colour, the notch. */
function wafer(): string {
  const cx = 400, cy = 400, R = 330, die = 30, gap = 6, step = die + gap
  const n = Math.floor((2 * R) / step), x0 = cx - (n * step) / 2 + gap / 2, y0 = cy - (n * step) / 2 + gap / 2
  let d = '', hot = ''
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const x = x0 + i * step, y = y0 + j * step
    const far = Math.max(...[[x, y], [x + die, y], [x, y + die], [x + die, y + die]].map(([a, b]) => Math.hypot(a - cx, b - cy)))
    if (far > R - 14) continue
    const sq = `M${x} ${y}h${die}v${die}h-${die}z`
    if ((i * 7 + j * 3) % 23 === 0) hot += sq; else d += sq
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800" width="800" height="800">
  <!-- wafer edge and body -->
  <circle cx="400" cy="400" r="364" fill="none" stroke="line" stroke-width="2"/>
  <circle cx="${cx}" cy="${cy}" r="${R}" fill="ground" stroke="line" stroke-opacity="0.45" stroke-width="2"/>
  <path d="${d}" fill="mark" fill-opacity="0.2"/>
  <path d="${hot}" fill="mark"/>
  <rect x="354" y="722" width="92" height="16" fill="ground"/>
</svg>`
}

/** A café: growth rings, half circles and half slightly wobbling closed paths, one ring in the brand colour. */
function rings(): string {
  let s = ''
  for (let k = 1; k <= 15; k++) {
    const R = 20 * k + k * k * 0.6, hot = k === 9
    const stroke = hot ? 'stroke="mark" stroke-opacity="0.9" stroke-width="2.5"' : `stroke="ink" stroke-opacity="${k % 3 === 0 ? 0.18 : 0.1}" stroke-width="1.5"`
    if (k % 2) { s += `<circle cx="400" cy="400" r="${R.toFixed(1)}" fill="none" ${stroke}/>`; continue }
    let d = ''
    for (let i = 0; i <= 36; i++) {
      const a = (i / 36) * Math.PI * 2, rr = R + 3 * Math.sin(a * 3 + k) + 2 * Math.sin(a * 5 + k * 1.7)
      d += `${i ? 'L' : 'M'}${(400 + rr * Math.cos(a)).toFixed(1)} ${(400 + rr * Math.sin(a) * 0.96).toFixed(1)}`
    }
    s += `<path d="${d}Z" fill="none" ${stroke}/>`
  }
  return svg(`<g transform="translate(0 0) rotate(-8 400 400)">${s}</g>`)
}

/** A SaaS that connects customers: two orbits, small discs and spokes around a glowing centre (a radial gradient). */
function orbits(): string {
  const cx = 400, cy = 400
  let s = `<defs><radialGradient id="core" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="onMark" stop-opacity="0.35"/><stop offset="100%" stop-color="onMark" stop-opacity="0"/></radialGradient></defs>`
  s += `<circle cx="${cx}" cy="${cy}" r="300" fill="none" stroke="onMark" stroke-opacity="0.22" stroke-width="2"/>`
  s += `<circle cx="${cx}" cy="${cy}" r="190" fill="none" stroke="onMark" stroke-opacity="0.3" stroke-width="2" stroke-dasharray="2 12" stroke-linecap="round"/>`
  s += `<circle cx="${cx}" cy="${cy}" r="120" fill="url(#core)"/><circle cx="${cx}" cy="${cy}" r="56" fill="onMark"/>`
  const pts = [[300, -70, 26], [300, 15, 18], [300, 128, 30], [300, 205, 16], [190, -150, 14], [190, 60, 20], [300, 290, 22]]
  pts.forEach(([R, deg, rad], k) => {
    const a = (deg * Math.PI) / 180, x = cx + R * Math.cos(a), y = cy + R * Math.sin(a)
    s += `<line x1="${(cx + 70 * Math.cos(a)).toFixed(2)}" y1="${(cy + 70 * Math.sin(a)).toFixed(2)}" x2="${(x - (rad + 10) * Math.cos(a)).toFixed(2)}" y2="${(y - (rad + 10) * Math.sin(a)).toFixed(2)}" stroke="onMark" stroke-opacity="0.28" stroke-width="2"/>`
    s += `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${rad}" fill="${k % 3 === 0 ? 'onMark' : 'none'}" fill-opacity="0.9" stroke="onMark" stroke-opacity="0.85" stroke-width="2.5"/>`
  })
  return `<svg viewBox="0 0 800 800" xmlns="http://www.w3.org/2000/svg">\n${s}\n</svg>\n`
}

describe('mockup accents pass', () => {
  test('wafer of dies (one path, the notch, the XML declaration and a comment)', () => {
    const input = wafer()
    expect(Buffer.byteLength(input)).toBeLessThan(DECK_ACCENT_MAX_BYTES)
    const r = ok(input)
    expect(r.elements).toBe(6)
    expect(r.svg).toContain('fill="#5224fd" fill-opacity="0.2"')
    expect(r.svg).toContain('stroke="#e4e2ec" stroke-width="2" stroke-opacity="0.45"')
    expect(r.svg).toContain('<rect x="354" y="722" width="92" height="16" fill="#ffffff"/>')
    expect(r.svg).toMatch(/<path d="M\d+ \d+h30v30h-30zM/)
    expect(r.svg).not.toContain('<!--')
    expect(r.svg).not.toContain('<?xml')
    invariants(r)
  })

  test('growth rings (circles, paths, a group transform; 2.5 snaps to 3)', () => {
    const r = ok(rings())
    expect(r.elements).toBe(17)
    expect(r.svg).toContain('<g transform="translate(0 0) rotate(-8 400 400)">')
    expect(r.svg.match(/<circle /g)?.length).toBe(8)
    expect(r.svg.match(/<path /g)?.length).toBe(7)
    expect(r.svg).toContain('stroke="#5224fd" stroke-width="3" stroke-opacity="0.9"')
    expect(r.svg).toContain('stroke="#14121f" stroke-width="1.5" stroke-opacity="0.18"')
    invariants(r)
  })

  test('orbits (circles, lines, a dash, a radial gradient referenced by url(#id))', () => {
    const r = ok(orbits())
    expect(r.elements).toBe(1 + 4 + 4 + 14) // root; defs, gradient, 2 stops; 4 centre circles; 7 spokes and discs
    expect(r.svg).toContain('<defs><radialGradient id="a1" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#fafafa" stop-opacity="0.35"/><stop offset="1" stop-color="#fafafa" stop-opacity="0.08"/></radialGradient></defs>')
    expect(r.svg).toContain('fill="url(#a1)"')
    expect(r.svg).toContain('stroke-linecap="round" stroke-dasharray="2 12"')
    expect(r.svg).not.toContain('core')
    invariants(r)
  })

  test('the same input gives the same output', () => {
    for (const make of [wafer, rings, orbits]) expect(ok(make()).svg).toBe(ok(make()).svg)
  })
})

describe('rebuild', () => {
  test('a small accent comes out in the canonical form', () => {
    const r = ok(`<svg viewBox="0,0,800,800" fill="none"><circle  r='1e2' cy="400.00"  cx="+400" stroke="mark" stroke-width="2.5" opacity="0.01"/></svg>`)
    expect(r).toEqual({ ok: true, elements: 2, svg: `${ROOT} fill="none"><circle cx="400" cy="400" r="100" stroke="#5224fd" stroke-width="3" opacity="0.08"/></svg>` })
  })

  test('colour names map to the theme; the theme hex itself is read as that colour (so the output re-reads)', () => {
    const names = ['ink', 'ground', 'line', 'mark', 'onMark'] as const
    for (const n of names) expect(ok(svg(`<rect width="10" height="10" fill="${n}" stroke="${n}"/>`)).svg).toContain(`fill="${COLORS[n].toLowerCase()}" stroke="${COLORS[n].toLowerCase()}"`)
    expect(ok(svg('<rect width="10" height="10" fill="#5224FD"/>')).svg).toContain('fill="#5224fd"')
    // another theme: the same names, other hex values
    const other = { ink: '#000000', ground: '#111111', line: '#222222', mark: '#333333', onMark: '#444444' }
    expect(ok(svg('<circle r="5" fill="mark"/>'), other).svg).toContain('fill="#333333"')
  })

  test('stroke widths snap to 1.5, 2 or 3; opacities clamp to 0.08–1', () => {
    const w = (x: string) => ok(svg(`<line x2="10" stroke="ink" stroke-width="${x}"/>`)).svg.match(/stroke-width="([^"]+)"/)![1]
    expect([w('0'), w('1'), w('1.7'), w('1.75'), w('2'), w('2.4'), w('2.5'), w('9'), w('-4')]).toEqual(['1.5', '1.5', '1.5', '2', '2', '2', '3', '3', '1.5'])
    const o = (x: string) => ok(svg(`<circle r="5" fill="ink" fill-opacity="${x}"/>`)).svg.match(/fill-opacity="([^"]+)"/)![1]
    expect([o('0'), o('0.5'), o('7'), o('.0801')]).toEqual(['0.08', '0.5', '1', '0.08'])
  })

  test('path data is re-tokenized: compact numbers, implicit repeats, arc flags', () => {
    const r = ok(svg('<path d="m10,10 20-5.5.5 1e1 L 1 2 3 4 a10 10 0 0110 10 Q1 2 3 4 t5 6 s1 2 3 4 C1 2 3 4 5 6 H5 V6 h1 v1 z" fill="ink"/>'))
    expect(r.svg).toContain('d="m10 10 20 -5.5 0.5 10L1 2 3 4a10 10 0 0 1 10 10Q1 2 3 4t5 6s1 2 3 4C1 2 3 4 5 6H5V6h1v1z"')
    invariants(r)
  })

  test('ids are renamed in document order; forward references are fine', () => {
    const r = ok(svg('<circle r="5" fill="url(#late)" clip-path="url(#c)"/><defs><clipPath id="c"><rect width="10" height="10"/></clipPath><linearGradient id="late" x1="0" x2="1" gradientUnits="objectBoundingBox" spreadMethod="pad"><stop offset="50%" stop-color="mark"/></linearGradient></defs>'))
    expect(r.svg).toContain('<circle r="5" fill="url(#a2)" clip-path="url(#a1)"/>')
    expect(r.svg).toContain('<clipPath id="a1">')
    expect(r.svg).toContain('<linearGradient id="a2" x1="0" x2="1" gradientUnits="objectBoundingBox" spreadMethod="pad"><stop offset="0.5" stop-color="#5224fd"/></linearGradient>')
    invariants(r)
  })

  test('all allowed shapes and attributes', () => {
    const r = ok(svg(`<g opacity="0.5" fill-rule="evenodd" clip-rule="nonzero" stroke-linejoin="bevel" transform="scale(2) translate(10,20)">
      <ellipse cx="1" cy="2" rx="3" ry="4" fill="line"/><rect x="1" y="2" width="3" height="4" rx="1" ry="1" fill="ground"/>
      <polyline points="1,2 3,4 5,6" fill="none" stroke="ink" stroke-linecap="square" stroke-dasharray="none"/>
      <polygon points="1 2 3 4 5 6" fill="onMark" stroke-linejoin="miter"/></g>`, ' stroke="none"'))
    expect(r.elements).toBe(6)
    expect(r.svg).toContain('<polyline points="1 2 3 4 5 6" fill="none" stroke="#14121f" stroke-linecap="square" stroke-dasharray="none"/>')
    expect(r.svg).toContain('transform="scale(2) translate(10 20)"')
    invariants(r)
  })

  test('limits that pass: 150 elements, depth 8, an 8,000-character path, 12,000 bytes', () => {
    ok(svg(DOT.repeat(149)))
    ok(svg(`${'<g>'.repeat(6)}${DOT}${'</g>'.repeat(6)}`))
    const d = `M0 0${'L1 1'.repeat((8000 - 4) / 4)}`
    expect(d.length).toBe(8000)
    ok(svg(`<path d="${d}" stroke="ink"/>`))
    const base = svg(DOT)
    expect(ok(base + ' '.repeat(DECK_ACCENT_MAX_BYTES - base.length)).ok).toBe(true)
  })

  test('accentDataUri encodes the sanitized svg and refuses anything else', () => {
    const r = ok(svg(DOT))
    const uri = accentDataUri(r.svg)
    expect(uri.startsWith('data:image/svg+xml;base64,')).toBe(true)
    expect(Buffer.from(uri.slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf8')).toBe(r.svg)
    expect(() => accentDataUri('<svg onload="x"/>')).toThrow()
    expect(() => accentDataUri(svg(DOT))).toThrow()
  })

  test('bad theme colours fail closed', () => {
    expect(sanitizeAccent(svg(DOT), { ...COLORS, mark: 'red' }).ok).toBe(false)
  })
})

describe('hostile input is rejected with a reason', () => {
  const cases: [string, string, RegExp][] = [
    ['script', svg('<script>alert(1)</script>'), /<script> is not allowed/],
    ['script, self-closed', svg('<script href="x"/>'), /<script> is not allowed/],
    ['foreignObject', svg('<foreignObject><div/></foreignObject>'), /<foreignObject> is not allowed/],
    ['image href', svg('<image href="https://example.com/x.png" width="10" height="10"/>'), /<image> is not allowed/],
    ['use href', svg('<use href="#x"/>'), /<use> is not allowed/],
    ['xlink:href on a gradient', svg('<defs><linearGradient id="a" xlink:href="#b"/></defs>' + DOT), /namespaced attribute xlink:href/],
    ['xmlns:xlink', svg(DOT, ' xmlns:xlink="http://www.w3.org/1999/xlink"'), /namespaced attribute/],
    ['href attribute', svg('<circle r="5" fill="ink" href="javascript:alert(1)"/>'), /href is not allowed/],
    ['style element', svg('<style>circle{fill:red}</style>' + DOT), /<style> is not allowed/],
    ['style attribute', svg('<circle r="5" style="fill:red"/>'), /style attributes/],
    ['onload on the root', svg(DOT, ' onload="alert(1)"'), /event attributes \(onload\)/],
    ['onclick on a nested element', svg(`<g><g><circle r="5" fill="ink" onclick="alert(1)"/></g></g>`), /event attributes \(onclick\)/],
    ['ONMOUSEOVER', svg('<circle r="5" ONMOUSEOVER="x"/>'), /event attributes/],
    ['url outside the file', svg('<circle r="5" fill="url(http://evil/x)"/>'), /url\(#id\)/],
    ['url with a file path', svg('<circle r="5" stroke="url(other.svg#a)"/>'), /url\(#id\)/],
    ['url in clip-path outside the file', svg('<circle r="5" clip-path="url(http://evil/x#c)"/>'), /clip-path must point/],
    ['url to a missing id', svg('<circle r="5" fill="url(#missing)"/>'), /missing id "missing"/],
    ['fill pointing to a clipPath', svg('<defs><clipPath id="c"><rect width="1" height="1"/></clipPath></defs><circle r="5" fill="url(#c)"/>'), /must point to a gradient/],
    ['clip-path pointing to a gradient', svg('<defs><linearGradient id="g"/></defs><circle r="5" clip-path="url(#g)"/>'), /must point to a clipPath/],
    ['hex colour', svg('<circle r="5" fill="#ff0000"/>'), /theme colour name/],
    ['CSS colour name', svg('<circle r="5" fill="red"/>'), /theme colour name/],
    ['rgb()', svg('<circle r="5" stroke="rgb(255,0,0)"/>'), /theme colour name/],
    ['currentColor', svg('<circle r="5" fill="currentColor"/>'), /theme colour name/],
    ['stop-color none', svg('<defs><linearGradient id="g"><stop stop-color="none"/></linearGradient></defs>' + DOT), /theme colour name/],
    ['billion laughs', `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]>${svg('<circle r="5" fill="&lol2;"/>')}`, /DOCTYPE and ENTITY/],
    ['ENTITY alone', `<!ENTITY x "y">${svg(DOT)}`, /DOCTYPE and ENTITY/],
    ['custom entity in an attribute', svg('<circle r="5" fill="&custom;"/>'), /entities other than/],
    ['custom entity in text', svg(`&custom;${DOT}`), /entities and text/],
    ['bare ampersand', svg('<circle r="5" fill="mark&"/>'), /entities other than/],
    ['CDATA', svg(`<![CDATA[<script>alert(1)</script>]]>${DOT}`), /CDATA/],
    ['processing instruction', `<?xml-stylesheet href="evil.css"?>${svg(DOT)}`, /processing instructions/],
    ['processing instruction inside', svg(`<?php echo 1 ?>${DOT}`), /processing instructions/],
    ['a second XML declaration', `<?xml version="1.0"?><?xml version="1.0"?>${svg(DOT)}`, /processing instructions/],
    ['text', svg(`<text x="10" y="10">hello</text>`), /<text> is not allowed/],
    ['bare text', svg(`hello${DOT}`), /text is not allowed/],
    ['tspan', svg(`<tspan/>`), /<tspan> is not allowed/],
    ['filter', svg(`<defs><filter id="f"/></defs>${DOT}`), /<filter> is not allowed/],
    ['mask', svg(`<mask id="m"/>${DOT}`), /<mask> is not allowed/],
    ['pattern', svg(`<pattern id="p"/>${DOT}`), /<pattern> is not allowed/],
    ['a', svg(`<a href="https://example.com">${DOT}</a>`), /<a> is not allowed/],
    ['animate', svg(`<circle r="5"><animate attributeName="r" to="9"/></circle>`), /<animate> is not allowed/],
    ['set', svg(`<set attributeName="fill" to="red"/>${DOT}`), /<set> is not allowed/],
    ['symbol', svg(`<symbol id="s"/>${DOT}`), /<symbol> is not allowed/],
    ['iframe', svg(`<iframe src="x"/>`), /<iframe> is not allowed/],
    ['svg:script', svg('<svg:script>alert(1)</svg:script>'), /namespaced element <svg:script>/],
    ['namespaced root', '<svg:svg xmlns:svg="http://www.w3.org/2000/svg"><svg:circle r="5"/></svg:svg>', /namespaced element/],
    ['SCRIPT', svg('<SCRIPT>alert(1)</SCRIPT>'), /<SCRIPT> is not allowed/],
    ['Svg root', '<Svg viewBox="0 0 800 800"><circle r="5"/></Svg>', /<Svg> is not allowed/],
    ['Circle', svg('<Circle r="5"/>'), /<Circle> is not allowed/],
    ['nested svg', svg(`<svg>${DOT}</svg>`), /<svg> is not allowed inside <svg>/],
    ['root is not svg', `<g>${DOT}</g>`, /root element must be <svg>/],
    ['two roots', svg(DOT) + svg(DOT), /more than one root/],
    ['a gradient stop outside a gradient', svg('<stop offset="0" stop-color="ink"/>'), /<stop> is not allowed inside <svg>/],
    ['a group inside a clipPath', svg('<defs><clipPath id="c"><g/></clipPath></defs>' + DOT), /<g> is not allowed inside <clipPath>/],
    ['clip-path inside a clipPath (a cycle)', svg('<defs><clipPath id="c"><rect width="1" height="1" clip-path="url(#c)"/></clipPath></defs>' + DOT), /not allowed inside a clipPath/],
    ['151 elements', svg(DOT.repeat(150)), /at most 150 elements/],
    ['depth 9', svg(`${'<g>'.repeat(7)}${DOT}${'</g>'.repeat(7)}`), /nested deeper than 8/],
    ['12,001 bytes', (() => { const b = svg(DOT); return b + ' '.repeat(DECK_ACCENT_MAX_BYTES + 1 - b.length) })(), /12001 bytes; at most 12000/],
    ['d with NaN', svg('<path d="M0 0L NaN 10" stroke="ink"/>'), /path data/],
    ['d with 1e309', svg('<path d="M0 0L1e309 10" stroke="ink"/>'), /outside ±10000/],
    ['d with 0x10', svg('<path d="M0 0L0x10 10" stroke="ink"/>'), /path data/],
    ['d with Infinity', svg('<path d="M0 0LInfinity 10" stroke="ink"/>'), /path data/],
    ['d out of range', svg('<path d="M0 0L10001 10" stroke="ink"/>'), /outside ±10000/],
    ['d not starting with M', svg('<path d="L0 0" stroke="ink"/>'), /must start with M/],
    ['d with a wrong count', svg('<path d="M0 0L1" stroke="ink"/>'), /wrong number of values/],
    ['d with an unknown command', svg('<path d="M0 0B1 2" stroke="ink"/>'), /unknown command/],
    ['d with a bad arc flag', svg('<path d="M0 0A1 1 0 2 0 5 5" stroke="ink"/>'), /arc flags/],
    ['d longer than 8,000', svg(`<path d="M0 0${'L1 1'.repeat(2000)}" stroke="ink"/>`), /longer than 8000/],
    ['r with NaN', svg('<circle r="NaN"/>'), /plain number/],
    ['cx with 1e309', svg('<circle cx="1e309" r="5"/>'), /outside ±10000/],
    ['cx with a unit', svg('<circle cx="10px" r="5"/>'), /plain number/],
    ['negative radius', svg('<circle r="-5"/>'), /must not be negative/],
    ['points with an odd count', svg('<polygon points="1 2 3" fill="ink"/>'), /pairs/],
    ['points with letters', svg('<polygon points="1 2 3 x" fill="ink"/>'), /numbers only/],
    ['matrix transform', svg(`<g transform="matrix(1 0 0 1 0 0)">${DOT}</g>`), /transform matrix is not allowed/],
    ['skewX transform', svg(`<g transform="skewX(30)">${DOT}</g>`), /transform skewX is not allowed/],
    ['translate(expression)', svg(`<g transform="translate(calc(10px))">${DOT}</g>`), /transform/],
    ['translate with a unit', svg(`<g transform="translate(10px 20px)">${DOT}</g>`), /numbers only/],
    ['transform on the root', svg(DOT, ' transform="scale(2)"'), /attribute transform is not allowed on <svg>/],
    ['unknown viewBox', '<svg viewBox="0 0 100 100"><circle r="5" fill="ink"/></svg>', /viewBox must be "0 0 800 800"/],
    ['wrong xmlns', '<svg xmlns="http://www.w3.org/1999/xhtml"><circle r="5" fill="ink"/></svg>', /xmlns must be/],
    ['entity-encoded javascript: in fill', svg('<circle r="5" fill="&#106;avascript:alert(1)"/>'), /theme colour name/],
    ['entity-encoded url in fill', svg('<circle r="5" fill="&#117;rl(http://evil/x)"/>'), /url\(#id\)/],
    ['entity-encoded javascript: in href', svg('<circle r="5" fill="ink" href="&#x6A;avascript:alert(1)"/>'), /href is not allowed/],
    ['a NUL character reference', svg('<circle r="5" fill="mark&#0;"/>'), /character XML does not allow/],
    ['unclosed tag inside the root', svg('<g>'), /<\/svg> does not match <g>/],
    ['unclosed tag at the end', `${svg(DOT)}`.replace('</svg>', '<g>'), /<g> is not closed/],
    ['unclosed root', `<svg viewBox="0 0 800 800">${DOT}`, /<svg> is not closed/],
    ['mismatched tags', svg('<g></defs>'), /does not match <g>/],
    ['closing nothing', `${svg(DOT)}</g>`, /closes nothing/],
    ['unclosed start tag', '<svg viewBox="0 0 800 800"><circle r="5"', /not closed/],
    ['unclosed attribute', '<svg viewBox="0 0 800 800><circle r="5"/></svg>', /"<" is not allowed in an attribute value|not closed/],
    ['unquoted attribute', svg('<circle r=5/>'), /must be quoted/],
    ['attribute without a value', svg('<circle r/>'), /has no value/],
    ['attributes without whitespace', svg('<circle r="5"fill="ink"/>'), /malformed/],
    ['duplicate attribute', svg('<circle r="5" r="6"/>'), /appears twice/],
    ['a huge number of attributes', svg(`<circle ${Array.from({ length: 1000 }, (_, i) => `a${i}="1"`).join(' ')}/>`), /more than 24 attributes/],
    ['unknown attribute', svg('<circle r="5" fill="ink" filter="url(#f)"/>'), /attribute filter is not allowed on <circle>/],
    ['mask attribute', svg('<circle r="5" mask="url(#m)"/>'), /attribute mask is not allowed/],
    ['id on a shape', svg('<circle id="c" r="5" fill="ink"/>'), /attribute id is not allowed on <circle>/],
    ['bad id', svg('<defs><linearGradient id="1;x"/></defs>' + DOT), /the id "1;x"/],
    ['duplicate id', svg('<defs><linearGradient id="g"/><radialGradient id="g"/></defs>' + DOT), /used twice/],
    ['gradient without an id', svg('<defs><linearGradient/></defs>' + DOT), /needs an id/],
    ['gradientTransform', svg('<defs><linearGradient id="g" gradientTransform="rotate(9)"/></defs>' + DOT), /gradientTransform is not allowed/],
    ['spreadMethod reflect', svg('<defs><linearGradient id="g" spreadMethod="reflect"/></defs>' + DOT), /spreadMethod/],
    ['bad linecap', svg('<line x2="5" stroke="ink" stroke-linecap="javascript"/>'), /stroke-linecap/],
    ['negative dash', svg('<line x2="5" stroke="ink" stroke-dasharray="2 -1"/>'), /must not be negative/],
    ['an empty accent', svg(''), /draws nothing/],
    ['only definitions', svg('<defs><linearGradient id="g"/></defs>'), /draws nothing/],
    ['empty input', '', /no <svg> element/],
    ['not XML', 'hello', /text is not allowed/],
    ['an unclosed comment', svg('<!-- ' + DOT), /comment is not closed/],
    ['a malformed tag', svg('< circle r="5"/>'), /tag is malformed/],
  ]
  for (const [name, input, reason] of cases) test(name, () => { rejected(input, reason) })

  test('non-string input fails closed', () => {
    expect(sanitizeAccent(undefined as unknown as string, COLORS).ok).toBe(false)
    expect(sanitizeAccent({ length: 5 } as unknown as string, COLORS).ok).toBe(false)
  })

  test('a comment hiding markup is dropped, not passed through', () => {
    const r = ok(svg(`<!-- <script>alert(1)</script> -->${DOT}`))
    expect(r.svg).toBe(`${ROOT}><circle cx="400" cy="400" r="40" fill="#5224fd"/></svg>`)
  })
})

describe('mutations of a valid accent never break the output rules', () => {
  test('3,000 seeded mutations: each is rejected, or its output holds every invariant', () => {
    let seed = 1234567
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32)
    const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]
    const bits = ['<script>', '</g>', '<g>', '"', "'", '&', '&#60;', '&lt;', 'onload="x" ', ' href="#a"', 'url(', ')', '#', ':', '<!--', '-->', '<![CDATA[', ']]>',
      '<?x?>', 'e309', 'NaN', '-', '.', '1e3', ' ', '/>', '>', '<', '\u0000', ' ', 'é', 'xlink:', 'style="', 'fill="url(#core)" ', 'Z', 'M']
    const bases = [wafer(), rings(), orbits()]
    let accepted = 0
    for (let n = 0; n < 3000; n++) {
      let s = pick(bases)
      for (let k = 1 + Math.floor(rnd() * 3); k > 0; k--) {
        const at = Math.floor(rnd() * s.length)
        const op = rnd()
        if (op < 0.5) s = s.slice(0, at) + pick(bits) + s.slice(at)
        else if (op < 0.75) s = s.slice(0, at) + s.slice(at + 1 + Math.floor(rnd() * 20))
        else s = s.slice(0, at) + s.slice(at, at + 1 + Math.floor(rnd() * 30)) + s.slice(at)
      }
      const r = sanitizeAccent(s, COLORS)
      if (r.ok) { accepted++; invariants(r) }
      else expect(r.reason.length).toBeGreaterThan(0)
    }
    expect(accepted).toBeGreaterThan(0)
  })
})
