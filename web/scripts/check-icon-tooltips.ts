// Icon-only controls carry the shared tooltip (docs/DESIGN-SYSTEM.md "Tooltip"). A static check over web/src, run by
// `bun run check:docs` (CI's "Onboarding documentation contracts" step):
//
//   bun web/scripts/check-icon-tooltips.ts
//
// An icon-only control is a <button>, <a>, <Link> or <NavLink> (or an element with role="button") whose visible content
// is only icons: Lucide icons, <svg>/<img>, and words hidden from sight (sr-only). It must be the direct child of a
// <Tooltip>, and it must not also carry the browser's `title` (two tips at once). <IconButton> brings its own tooltip;
// only `tip={false}` turns it off, and then it must sit in a <Tooltip> of its own. Anything that can show words (text,
// {t('…')}, a value, an unknown component) is not icon-only and is left alone.
//
// A control that should have no tooltip says why on the line above it: {/* no-tooltip: <reason> */}.
//
// Static rather than a test over rendered pages: it sees every file, including the dialogs, menus, admin rows and error
// states a rendered page only shows after clicks, mock data or a role, and it runs without a browser or server.
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const SRC = path.resolve(import.meta.dir, '../src')

/** Files left out, with the reason (none today). */
export const SKIP: Record<string, string> = {}

const CONTROLS = new Set(['button', 'a', 'Link', 'NavLink', 'Button'])
/** components that draw a picture, not words */
const PICTURES = /^(svg|img|picture|.*Icon|.*Thumb|Avatar|Logo|Mark|Spark)$/

export interface Problem { file: string; line: number; tag: string; label: string; why: string }

type Jsx = ts.JsxElement | ts.JsxSelfClosingElement
const opening = (n: Jsx) => (ts.isJsxElement(n) ? n.openingElement : n)
const tagOf = (n: Jsx) => opening(n).tagName.getText()
const attr = (n: Jsx, name: string) => opening(n).attributes.properties.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === name)
const attrText = (a: ts.JsxAttribute | undefined) => (!a ? '' : !a.initializer ? 'true' : ts.isStringLiteral(a.initializer) ? a.initializer.text : a.initializer.getText())

/** what the content shows: words, pictures, and the breakpoints of words a window size hides (`max-md:`, `md:`) */
interface Seen { text: boolean; icon: boolean; hidden?: string[] }
/** words at every width: plain words, or two parts that hide at opposite sides of one breakpoint (`max-md:hidden` and
 * `md:hidden`: the team's name on a computer, the AI's name on a phone) */
const words = (s: Seen) => s.text || (s.hidden ?? []).some((v) => v && !/^@?max-/.test(v) && s.hidden!.includes(v.replace(/^(@?)/, '$1max-')))

export function iconOnlyProblems(file: string, source: string): Problem[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  // names imported from lucide-react (X, or X as CloseIcon)
  const lucide = new Set<string>()
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier) || s.moduleSpecifier.text !== 'lucide-react') continue
    const b = s.importClause?.namedBindings
    if (b && ts.isNamedImports(b)) for (const e of b.elements) lucide.add(e.name.text)
  }
  const isPicture = (tag: string) => lucide.has(tag) || PICTURES.test(tag)

  const expr = (e: ts.Expression, seen: Seen): void => {
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) return expr(e.expression, seen)
    if (ts.isConditionalExpression(e)) { expr(e.whenTrue, seen); expr(e.whenFalse, seen); return }
    if (ts.isBinaryExpression(e)) {
      if (e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return expr(e.right, seen)
      expr(e.left, seen); expr(e.right, seen); return
    }
    if (ts.isJsxElement(e) || ts.isJsxSelfClosingElement(e) || ts.isJsxFragment(e)) return node(e, seen)
    if (e.kind === ts.SyntaxKind.NullKeyword || e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword) return
    if (ts.isIdentifier(e) && e.text === 'undefined') return
    // a picture handed in as a value: {icon}, {props.icon}, {img}, {thumb}
    if ((ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) && /(icon|img|image|thumb|picture)$/i.test(e.getText().split('.').pop()!)) { seen.icon = true; return }
    seen.text = true // a string, t('…'), a value, children: words
  }
  const children = (list: ts.NodeArray<ts.JsxChild>, seen: Seen) => {
    for (const c of list) {
      if (ts.isJsxText(c)) { if (/\S/.test(c.text)) seen.text = true }
      else if (ts.isJsxExpression(c)) { if (c.expression) expr(c.expression, seen) }
      else node(c, seen)
    }
  }
  const node = (n: ts.JsxChild | ts.JsxFragment, seen: Seen): void => {
    if (ts.isJsxFragment(n)) return children(n.children, seen)
    if (!ts.isJsxElement(n) && !ts.isJsxSelfClosingElement(n)) return
    const tag = tagOf(n)
    if (isPicture(tag)) { seen.icon = true; return }
    if (/^[a-z]/.test(tag)) {
      const cls = attrText(attr(n, 'className'))
      if (/(^|[\s'"`])([\w@[\]-]+:)*sr-only([\s'"`]|$)/.test(cls)) return // words for screen readers only (at some widths)
      // words a narrow window hides (`@max-2xl:hidden`, `max-sm:hidden`): then it is icon-only
      const hid = /(?:^|[\s'"`])((?:[\w@[\]-]+:)*)hidden(?=[\s'"`]|$)/.exec(cls)
      if (hid) {
        const inner: Seen = { text: false, icon: false }
        if (ts.isJsxElement(n)) children(n.children, inner)
        if (inner.icon) seen.icon = true
        if (inner.text) (seen.hidden ??= []).push(hid[1]!)
        return
      }
      if (ts.isJsxElement(n)) children(n.children, seen)
      return
    }
    seen.text = true // a component of ours: it may show words (a Badge, a Spinner with its text)
  }

  const problems: Problem[] = []
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
  const exempt = (n: ts.Node) => {
    const line = lineOf(n)
    const lines = source.split('\n').slice(Math.max(0, line - 3), line)
    return lines.some((l) => l.includes('no-tooltip:'))
  }
  const inTooltip = (n: Jsx) => !!n.parent && ts.isJsxElement(n.parent) && n.parent.openingElement.tagName.getText() === 'Tooltip'
  /** a title of its own, not the empty one that keeps an ancestor's away */
  const titled = (n: Jsx) => { const a = attr(n, 'title'); return !!a && !(a.initializer && ts.isStringLiteral(a.initializer) && a.initializer.text === '') }
  /** an element around it (in the same component; through .map callbacks) whose title the browser would show too */
  const titledAncestor = (n: Jsx) => {
    if (attr(n, 'title')) return false // its own title="" (or one flagged already)
    for (let p: ts.Node | undefined = n.parent; p && !ts.isSourceFile(p); p = p.parent) {
      if (ts.isFunctionDeclaration(p) || ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && !ts.isCallExpression(p.parent))) return false
      if (ts.isJsxElement(p) && /^[a-z]/.test(tagOf(p)) && titled(p)) return true
    }
    return false
  }
  const ANCESTOR = 'an element around it has a title the browser shows beside the tooltip: give it title=""'
  const visit = (n: ts.Node) => {
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) {
      const tag = tagOf(n)
      const label = attrText(attr(n, 'aria-label') ?? attr(n, 'label') ?? attr(n, 'title'))
      if (tag === 'IconButton') {
        const tip = attrText(attr(n, 'tip'))
        if (tip === '{false}' && !inTooltip(n) && !exempt(n)) problems.push({ file, line: lineOf(n), tag, label, why: 'IconButton tip={false} outside a <Tooltip>' })
        if (tip !== '{false}' && inTooltip(n)) problems.push({ file, line: lineOf(n), tag, label, why: 'IconButton in a <Tooltip> shows two tips: give it tip={false}' })
        else if (tip !== '{false}' && titledAncestor(n) && !exempt(n)) problems.push({ file, line: lineOf(n), tag, label, why: ANCESTOR })
      } else if (CONTROLS.has(tag) || attrText(attr(n, 'role')) === 'button') {
        const seen: Seen = { text: false, icon: false }
        if (ts.isJsxElement(n)) children(n.children, seen)
        if (seen.icon && !words(seen) && !exempt(n)) {
          if (!inTooltip(n)) problems.push({ file, line: lineOf(n), tag, label, why: 'icon-only control without a <Tooltip>' })
          else if (titled(n)) problems.push({ file, line: lineOf(n), tag, label, why: 'title= beside a <Tooltip> shows two tips' })
          else if (titledAncestor(n)) problems.push({ file, line: lineOf(n), tag, label, why: ANCESTOR })
        }
      } else if (titled(n) && (isPicture(tag) || /^[a-z]/.test(tag)) && !exempt(n)) {
        // an icon that means something (read-only, connected, restricted) says so with the tooltip, not with the
        // browser's slow title
        const seen: Seen = { text: false, icon: isPicture(tag) }
        if (ts.isJsxElement(n)) children(n.children, seen)
        if (seen.icon && !words(seen)) problems.push({ file, line: lineOf(n), tag, label, why: inTooltip(n) ? 'title= beside a <Tooltip> shows two tips' : 'title= on an icon: use <Tooltip>' })
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return problems
}

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : d.name.endsWith('.tsx') ? [path.join(dir, d.name)] : []))

export function checkIconTooltips(root = SRC): Problem[] {
  return walk(root)
    .map((f) => path.relative(root, f).split(path.sep).join('/'))
    .filter((f) => !SKIP[f])
    .sort()
    .flatMap((f) => iconOnlyProblems(f, fs.readFileSync(path.join(root, f), 'utf8')))
}

if (import.meta.main) {
  const problems = checkIconTooltips()
  for (const p of problems) console.error(`web/src/${p.file}:${p.line}: <${p.tag}${p.label ? ` "${p.label}"` : ''}> ${p.why}`)
  if (problems.length) {
    console.error(`\n${problems.length} icon-only control(s) without the shared tooltip. Wrap each in <Tooltip label={…}> (components/Tooltip.tsx), or say why not with {/* no-tooltip: <reason> */} on the line above.`)
    process.exit(1)
  }
  console.log('icon tooltips: every icon-only control has one')
}
