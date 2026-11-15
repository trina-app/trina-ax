// "Discover" in External services (lib/connectors.ts): every listed service makes a connection the contract accepts,
// has its description in every language and a logo of its own that is safe to serve from this server, and shows as added
// whichever way its address was written.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'bun:test'
import { catalogAt, catalogNamed, mixedScript, nameSkeleton, officialService, officialUrls, posesAsListed, sameListedService, SERVICE_CATALOG, trustedServiceName } from '@mycel/shared'
import { IntegrationInput } from '@mycel/shared/api'
import { AI_APPS, BUILT_IN, connectorFor, CONNECTORS, isConnected, SLACK_APP } from '../../src/lib/connectors'
import { canonicalService, emptyForm, toInput, validate } from '../../src/lib/integrations'
import { DICTS } from '../../src/i18n'
import { APP_LOGOS } from '../../src/components/rooms/apps/AppParts'

describe('the shared list of services (shared/src/service-catalog.ts)', () => {
  test('Discover is the shared list, with a logo for each', () => {
    expect(CONNECTORS.map(({ id, name, url }) => ({ id, name, url }))).toEqual(SERVICE_CATALOG.map(({ id, name, url }) => ({ id, name, url })))
    for (const c of CONNECTORS) expect(c.logo).toMatch(/^[a-z0-9-]+\.(svg|png)$/)
  })
  test('a name means a listed service exactly, holds one among other words, or names none', () => {
    for (const n of ['Notion', 'notion', 'NOTION', 'Notion MCP', 'the Notion app', 'Ｎｏｔｉｏｎ']) expect(catalogNamed(n), n).toMatchObject({ exact: true, service: { id: 'notion' } })
    for (const [n, id] of [['ClickUp', 'clickup'], ['Click Up', 'clickup'], ['WordPress', 'wordpress'], ['WordPress.com', 'wordpress'], ['Mermaid', 'mermaid'], ['Mermaid Chart', 'mermaid'], ['Monday.com', 'monday']] as const) expect(catalogNamed(n), n).toMatchObject({ exact: true, service: { id } })
    for (const [n, id] of [['Notion workspace', 'notion'], ['Acme GitLab', 'gitlab'], ['My Click Up tasks', 'clickup']] as const) expect(catalogNamed(n), n).toMatchObject({ exact: false, service: { id } })
    for (const n of ['Higgs Studio', 'Notes', 'Lineup', 'GitHub']) expect(catalogNamed(n), n).toBeUndefined()
  })
  test('look-alikes and local names count as the service: other scripts, accents, digits, Korean and Japanese', () => {
    for (const n of ['N\u043etion', 'N\u03bftion', 'Not\u00edon', 'Notio\u0301n', 'N0tion', '노션', 'ノーション', '노션 MCP']) expect(catalogNamed(n), n).toMatchObject({ exact: true, service: { id: 'notion' } })
    for (const [n, id] of [['피그마', 'figma'], ['フィグマ', 'figma'], ['리니어', 'linear'], ['Jira', 'atlassian'], ['지라', 'atlassian'], ['깃랩', 'gitlab'], ['\u0421anva', 'canva']] as const) expect(catalogNamed(n), n).toMatchObject({ exact: true, service: { id } })
    expect(catalogNamed('Acme N\u043etion wiki')).toMatchObject({ exact: false, service: { id: 'notion' } })
  })
  test('capitals and more look-alikes: Greek capitals read before lower case, Armenian, dotless i, small capitals, Greek sigma', () => {
    // ΝΟΤΙΟΝ in Greek capitals: lowered first it would read "votiov"
    for (const n of ['\u039d\u039f\u03a4\u0399\u039f\u039d', '\u039dotion', 'NOT\u0399ON', 'N\u0585tion', 'Not\u0131on', '\u0274\u1d0f\u1d1b\u026a\u1d0f\u0274', 'N\u03c3tion'])
      expect(catalogNamed(n), n).toMatchObject({ exact: true, service: { id: 'notion' } })
    expect(nameSkeleton('\u039c\u0399\u03a7')).toBe('mix')
    for (const [n, id] of [['\u0392rex', 'brex'], ['\u03a3', undefined], ['\u0396apier', undefined]] as const) expect(catalogNamed(n)?.service.id, n).toBe(id)
  })
  test('a word that mixes Latin with Cyrillic, Greek, Armenian or Cherokee letters is mixed; one script per word is not', () => {
    for (const n of ['N\u043etion', 'Acme N\u043etion', '\u039dotion', 'N\u0585tion', 'Sl\u13aack']) expect(mixedScript(n), n).toBe(true)
    for (const n of ['Notion', 'Нотион', 'Acme Нотион', '노션 MCP', '노션MCP', 'Notíon', '\u0274\u1d0f\u1d1b\u026a\u1d0f\u0274']) expect(mixedScript(n), n).toBe(false)
    expect(posesAsListed('Notion', 'https://mcp.notion.com/mcp')).toBe(false)
    expect(posesAsListed('Notion', 'https://notion-mcp.example.com/mcp')).toBe(true)
    expect(posesAsListed('Acme Tools', 'https://x.example.com/mcp')).toBe(false)
    expect(posesAsListed('Ac\u043ce Tools', 'https://x.example.com/mcp')).toBe(true)
  })
  test('a service named by an ordinary word matches only its exact name', () => {
    for (const n of ['Square Feet API', 'Linear Regression API', 'Monday Reports', 'Neon Signs', 'Sanity Check', 'Railway Timetable', 'Resend Mail Queue', 'Indeed Jobs Mirror', 'Stripe Pattern Maker'])
      expect(catalogNamed(n), n).toBeUndefined()
    for (const [n, id] of [['Square', 'square'], ['Linear', 'linear'], ['Monday', 'monday'], ['Neon MCP', 'neon']] as const) expect(catalogNamed(n), n).toMatchObject({ exact: true, service: { id } })
  })
  test('"official" only for the exact official address: https, host and path; no query, port, user or other scheme', () => {
    expect(officialService('https://mcp.notion.com/mcp')?.id).toBe('notion')
    expect(officialService('https://mcp.notion.com/mcp/')?.id).toBe('notion')
    expect(officialService('https://MCP.NOTION.COM/mcp')?.id).toBe('notion')
    for (const u of ['http://mcp.notion.com/mcp', 'https://mcp.notion.com/mcp?x=1', 'https://mcp.notion.com/mcp#a', 'https://mcp.notion.com:8443/mcp', 'https://u:p@mcp.notion.com/mcp', 'https://mcp.notion.com/other', 'https://mcp.notion.com/MCP', 'https://notion-mcp.example.com/mcp'])
      expect(officialService(u), u).toBeUndefined()
  })
  test('an address is a listed service\'s official one however it is written, and nothing else is', () => {
    expect(catalogAt('https://mcp.notion.com/mcp')?.id).toBe('notion')
    expect(catalogAt('https://MCP.NOTION.COM/mcp/')?.id).toBe('notion')
    expect(catalogAt('https://notion-mcp.example.com/mcp')).toBeUndefined()
    expect(catalogAt('https://mcp.notion.com.example.com/mcp')).toBeUndefined()
    expect(catalogAt('https://mcp.notion.com/other')).toBeUndefined()
  })
  // 2026-11-12: Atlassian's listed address is v2 (its v1 still works); Canva's documented address needs an app of one's
  // own, so the list keeps the one that does not and counts both as Canva's
  test('every official address of a service is that service: Atlassian v1 and v2, Canva\'s two', () => {
    expect(SERVICE_CATALOG.find((c) => c.id === 'atlassian')?.url).toBe('https://mcp.atlassian.com/v2/mcp')
    for (const [u, id] of [['https://mcp.atlassian.com/v2/mcp', 'atlassian'], ['https://mcp.atlassian.com/v1/mcp', 'atlassian'], ['https://mcp.canva.com/mcp', 'canva'], ['https://api.canva.com/connect/v1/mcp', 'canva']] as const) {
      expect(officialService(u)?.id, u).toBe(id)
      expect(catalogAt(u)?.id, u).toBe(id)
      expect(connectorFor(u)?.id, u).toBe(id)
    }
    // the same service, never a second connection; another service is not
    expect(sameListedService('https://mcp.atlassian.com/v1/mcp', 'https://mcp.atlassian.com/v2/mcp')).toBe(true)
    expect(sameListedService('https://api.canva.com/connect/v1/mcp', 'https://mcp.canva.com/mcp')).toBe(true)
    expect(sameListedService('https://mcp.atlassian.com/v1/mcp', 'https://mcp.notion.com/mcp')).toBe(false)
    expect(sameListedService('https://mcp.atlassian.com/v1/sse', 'https://mcp.atlassian.com/v2/mcp')).toBe(false)
    // Discover: a connection saved at v1 counts as Atlassian connected
    expect(isConnected(CONNECTORS.find((c) => c.id === 'atlassian')!, ['https://mcp.atlassian.com/v1/mcp'])).toBe(true)
    // a name at a documented host is the service; anything else at Canva's name is not
    expect(trustedServiceName('Canva', 'https://api.canva.com/connect/v1/mcp')).toMatchObject({ name: 'Canva', listed: { id: 'canva' } })
    expect(trustedServiceName('Atlassian', 'https://mcp.atlassian.com/v1/mcp')).toMatchObject({ name: 'Atlassian', listed: { id: 'atlassian' } })
    expect(trustedServiceName('Canva', 'https://canva-mcp.example.com/mcp')).toMatchObject({ name: 'canva-mcp.example.com', claimed: { id: 'canva' } })
    for (const c of SERVICE_CATALOG) for (const u of officialUrls(c)) expect(new URL(u).protocol).toBe('https:')
  })
})

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
    // AI apps' that connect to this server (Claude and Claude Code share one file; "other MCP apps" has no logo) and
    // Slack's (Admin › Connected apps › Slack)
    const apps = AI_APPS.flatMap((a) => (a.logo ? [{ id: a.id, logo: a.logo }] : []))
    const all = [...CONNECTORS, ...BUILT_IN, ...apps, SLACK_APP]
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

  test('the marks of apps posting in rooms (web/public/icons/room-apps) are the listed ones, and run and load nothing', () => {
    const dir = path.join(import.meta.dir, '../../public/icons/room-apps')
    const files = Object.values(APP_LOGOS).map((u) => path.basename(u!))
    expect(fs.readdirSync(dir).sort()).toEqual([...files].sort())
    for (const f of files) expect({ f, problems: svgProblems(fs.readFileSync(path.join(dir, f), 'utf8')) }).toEqual({ f, problems: [] })
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
