// "Discover" in External services (lib/connectors.ts): every listed service makes a connection the contract accepts,
// has its description in every language and a logo of its own that is safe to serve from this server, and shows as added
// whichever way its address was written.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'bun:test'
import { IntegrationInput } from '@mycel/shared/api'
import { AI_APPS, BUILT_IN, connectorFor, CONNECTORS, isConnected } from '../../src/lib/connectors'
import { canonicalService, emptyForm, toInput, validate } from '../../src/lib/integrations'
import { DICTS } from '../../src/i18n'

describe('Discover', () => {
  test('every service is an MCP server with sign-in that the contract accepts, listed once', () => {
    expect(new Set(CONNECTORS.map((c) => c.id)).size).toBe(CONNECTORS.length)
    expect(new Set(CONNECTORS.map((c) => canonicalService(c.url))).size).toBe(CONNECTORS.length)
    for (const c of CONNECTORS) {
      const f = { ...emptyForm('mcp'), name: c.name, url: c.url }
      expect(validate(f)).toEqual({})
      expect(toInput(f)).toMatchObject({ kind: 'mcp', auth: 'oauth', writePolicy: 'ask' })
      expect(IntegrationInput.safeParse(toInput(f)).success).toBe(true)
    }
  })

  test('every service says what it does in every language', () => {
    for (const dict of Object.values(DICTS)) {
      for (const c of CONNECTORS) expect((dict as Record<string, string>)[`integrations.catalog.${c.id}`]).toBeTruthy()
    }
  })

  test('every service has its logo, and a logo can run nothing and load nothing', () => {
    const dir = path.join(import.meta.dir, '../../public/icons/connectors')
    // the MCP servers' logos, the built-in services' (Google Drive is not an MCP server: no address, its own flow) and the
    // AI apps' that connect to this server (Claude and Claude Code share one file; "other MCP apps" has no logo)
    const apps = AI_APPS.flatMap((a) => (a.logo ? [{ id: a.id, logo: a.logo }] : []))
    const all = [...CONNECTORS, ...BUILT_IN, ...apps]
    expect(fs.readdirSync(dir).sort()).toEqual([...new Set(all.map((c) => c.logo))].sort())
    expect(new Set(all.map((c) => c.id)).size).toBe(all.length)
    for (const c of all) {
      const file = fs.readFileSync(path.join(dir, c.logo))
      if (c.logo.endsWith('.png')) {
        expect(file.subarray(1, 4).toString()).toBe('PNG')
        continue
      }
      // these are served from the team's own address, so a file opened directly must be harmless (the server also sends
      // them with a policy that runs and loads nothing, tests/unit/d-web.test.ts)
      expect({ logo: c.logo, problems: svgProblems(file.toString('utf8')) }).toEqual({ logo: c.logo, problems: [] })
    }
  })

  test('the logo check refuses what can run or load, however it is written', () => {
    const svg = (body: string, attrs = '') => `<svg xmlns="http://www.w3.org/2000/svg"${attrs}>${body}</svg>`
    const bad: Record<string, string> = {
      script: svg('<script>alert(1)</script>'),
      handler: svg('<rect width="9" height="9"/>', ' onload="alert(1)"'),
      setHrefEntity: svg('<a><set attributeName="href" to="jav&#x61;script:alert(1)"/><rect width="9" height="9"/></a>'),
      animateHref: svg('<a><animate attributeName="href" values="jav&#97;script:alert(1)"/><rect width="9" height="9"/></a>'),
      hrefEntity: svg('<a href="&#106;avascript:alert(1)"><rect width="9" height="9"/></a>'),
      unquotedHref: svg('<use href=data:image/svg+xml;base64,AAAA />'),
      localUse: svg('<defs><path id="p" d="M0 0"/></defs><use href="#p"/>'),
      xlinkHref: svg('<path d="M0 0"/>', ' xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="https://x.example/"'),
      image: svg('<image href="https://x.example/a.png"/>'),
      feImage: svg('<filter><feImage href="https://x.example/a.png"/></filter>'),
      foreignObject: svg('<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>'),
      urlNoScheme: svg('<rect fill="url(//x.example/p.svg#a)"/>'),
      urlFile: svg('<rect fill="url(p.svg#a)"/>'),
      styleImport: svg('<style>@import url(https://x.example/a.css);</style>'),
      styleUrl: svg('<style>path{fill:url(https://x.example/p.svg#a)}</style>'),
      styleEscape: svg('<style>path{fill:\\75 rl(https://x.example/p.svg#a)}</style>'),
      styleAttr: svg('<rect style="fill:url(//x.example/p.svg#a)"/>'),
      cdata: svg('<style><![CDATA[path{fill:red}]]></style>'),
      doctype: '<!DOCTYPE svg [<!ENTITY x "javascript:">]>' + svg('<a href="&x;"/>'),
      namedEntity: svg('<title>&nbsp;</title>'),
      instruction: svg('<?xml-stylesheet href="https://x.example/a.css"?>'),
      otherNamespace: svg('<h:script xmlns:h="http://www.w3.org/1999/xhtml">alert(1)</h:script>'),
      notSvg: '<html><body></body></html>',
      unclosed: svg('<g><path d="M0 0"/>'),
    }
    for (const [name, text] of Object.entries(bad)) expect({ name, refused: svgProblems(text).length > 0 }).toEqual({ name, refused: true })
    // what the logos use passes: shapes, local gradients and clip paths, their own styles, a title and an XML declaration
    expect(svgProblems('<?xml version="1.0" encoding="utf-8"?>\n<!-- made by a tool -->\n' + svg('<title>A &amp; B</title><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient><clipPath id="c"><rect width="9" height="9"/></clipPath><style type="text/css">.a{fill:#000}</style></defs><g clip-path="url(#c)"><path class="a" fill="url(#g)" d="M0 0h9v9z"/></g>', ' viewBox="0 0 9 9" role="img"'))).toEqual([])
  })

  test('a connection added by hand is matched to its service for the logo', () => {
    expect(connectorFor('https://MCP.notion.com/mcp/')?.id).toBe('notion')
    expect(connectorFor('https://mcp.notion.com/other')).toBeUndefined()
  })

  test('already added: whatever the letter case or a trailing slash, and not a similar address', () => {
    const notion = CONNECTORS.find((c) => c.id === 'notion')!
    const stripe = CONNECTORS.find((c) => c.id === 'stripe')!
    expect(isConnected(notion, ['https://MCP.notion.com/mcp/'])).toBe(true)
    expect(isConnected(stripe, ['https://mcp.stripe.com'])).toBe(true)
    expect(isConnected(notion, ['https://mcp.notion.com/other'])).toBe(false)
    expect(isConnected(notion, ['https://example.com/mcp', 'not an address'])).toBe(false)
    expect(isConnected(notion, [])).toBe(false)
  })
})

// ---------------- the logo check ----------------
// A logo is read as XML, strictly: what this reader does not take (a DOCTYPE or entity, CDATA, a processing instruction
// other than the leading XML declaration, an unquoted attribute, a character reference such as &#x61;) is a problem, not
// something to read around. Then only the elements and attributes listed here may appear, a url() may only point inside
// the file (#id), and a style may not import, escape or load anything.
const SVG_NS = 'http://www.w3.org/2000/svg'
const XLINK_NS = 'http://www.w3.org/1999/xlink'
const ELEMENTS = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'defs', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'title', 'desc', 'style'])
const ATTRIBUTES = new Set([
  'version', 'id', 'class', 'role', 'aria-hidden', 'aria-label', 'aria-labelledby', 'xml:space',
  'width', 'height', 'x', 'y', 'viewBox', 'preserveAspectRatio', 'transform',
  'd', 'cx', 'cy', 'r', 'rx', 'ry', 'x1', 'y1', 'x2', 'y2', 'fx', 'fy', 'points', 'offset',
  'fill', 'fill-rule', 'fill-opacity', 'clip-rule', 'clip-path', 'clipPathUnits', 'mask', 'opacity',
  'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-opacity',
  'stop-color', 'stop-opacity', 'gradientUnits', 'gradientTransform', 'style', 'type',
])
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const TAG = /^<([A-Za-z_][\w.:-]*)((?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/
const END_TAG = /^<\/([A-Za-z_][\w.:-]*)\s*>/
/** url(#id) is the only url() allowed: it points inside the same file */
const foreignUrl = (v: string) => /url\(/i.test(v.replace(/url\(\s*(['"]?)#[\w.:-]+\1\s*\)/gi, ''))
/** an escape could spell url() or @import another way */
const badStyle = (v: string) => /[@\\]|expression|behavior|binding|javascript/i.test(v) || foreignUrl(v)

/** What makes an SVG unsafe to serve as a logo; none for one that is plain shapes, local paint and its own styles. */
function svgProblems(src: string): string[] {
  const problems: string[] = []
  if (src.includes('&#')) problems.push('a character reference (&#)')
  const decode = (s: string) => s.replace(/&([^;&<]*)(;?)/g, (m, name: string, semi: string) => {
    if (semi && name in ENTITIES) return ENTITIES[name]!
    problems.push(`an entity: ${m}`)
    return ''
  })
  const checkElement = (name: string, attrText: string, root: boolean) => {
    if (root && name !== 'svg') problems.push(`the root is <${name}>, not <svg>`)
    if (!ELEMENTS.has(name)) problems.push(`<${name}>`)
    const seen = new Set<string>()
    for (const a of attrText.matchAll(/([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      const key = a[1]!
      const value = decode(a[2] ?? a[3] ?? '')
      if (seen.has(key)) problems.push(`${key} twice on <${name}>`)
      seen.add(key)
      if (key === 'xmlns') {
        if (value !== SVG_NS) problems.push(`<${name}> in another namespace: ${value}`)
      } else if (key === 'xmlns:xlink') {
        if (value !== XLINK_NS) problems.push(`xmlns:xlink is ${value}`)
      } else if (!ATTRIBUTES.has(key)) problems.push(`${key} on <${name}>`)
      else if (key === 'style' ? badStyle(value) : foreignUrl(value)) problems.push(`${key} on <${name}> loads something: ${value.slice(0, 60)}`)
      else if (key === 'type' && (name !== 'style' || value !== 'text/css')) problems.push(`type="${value}" on <${name}>`)
    }
    if (root && !seen.has('xmlns')) problems.push('the svg element has no SVG namespace')
  }

  const stack: string[] = []
  let roots = 0
  let i = /^<\?xml\s[^?<>]*\?>/.exec(src)?.[0].length ?? 0
  while (i < src.length && !problems.length) {
    const rest = src.slice(i)
    if (rest.startsWith('<!--')) {
      const end = src.indexOf('-->', i + 4)
      if (end < 0) problems.push('a comment that is not closed')
      i = end < 0 ? src.length : end + 3
    } else if (rest.startsWith('<!') || rest.startsWith('<?')) {
      problems.push(`markup this check does not take: ${rest.slice(0, 24)}`)
    } else if (rest.startsWith('</')) {
      const m = END_TAG.exec(rest)
      if (!m || stack.pop() !== m[1]) problems.push(`a closing tag that does not match: ${rest.slice(0, 24)}`)
      else i += m[0].length
    } else if (rest.startsWith('<')) {
      const m = TAG.exec(rest)
      if (!m) {
        problems.push(`a tag that is not plain XML: ${rest.slice(0, 32)}`)
        break
      }
      if (!stack.length && roots++) problems.push('more than one root element')
      checkElement(m[1]!, m[2]!, !stack.length)
      if (!m[3]) stack.push(m[1]!)
      i += m[0].length
    } else {
      const next = src.indexOf('<', i)
      const text = src.slice(i, next < 0 ? src.length : next)
      if (!stack.length) {
        if (text.trim()) problems.push('text outside the svg element')
      } else {
        const value = decode(text)
        if (stack.at(-1) === 'style' && badStyle(value)) problems.push(`a style that imports, escapes or loads: ${value.trim().slice(0, 60)}`)
      }
      i = next < 0 ? src.length : next
    }
  }
  if (!problems.length && stack.length) problems.push(`<${stack.at(-1)}> is not closed`)
  if (!problems.length && !roots) problems.push('no svg element')
  return problems
}
