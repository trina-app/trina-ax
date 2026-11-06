// Phone type audit (docs/DESIGN-SYSTEM.md "Typography", How to check): signs in to a running team server, opens the
// screens and overlays a phone reaches at 390×844 (or --width/--height), and records every visible text: its computed
// font size, line height, weight, the nearest data-testid and its classes. Text under the phone floor is flagged:
//   body or row text (primary colour) under 15px, a label (text-label) under 14px, meta (text-xs / text-micro, times,
//   hints, secondary colours) and control text under 13px, code under 13px, and anything under 12px except a badge
//   (a count or tag: [data-badge], or a test id ending in -unread or -badge) at 11px. An avatar's initial (aria-hidden,
//   beside the name) is not counted.
// Writes <out>/audit.csv (one row per distinct text style per view) and <out>/summary.md (counts and the flagged
// groups). Dev tool, not part of the build.
//
//   bun web/scripts/type-audit.ts --base http://127.0.0.1:19100 --user kim --password-file ./owner-pw \
//     [--member mia --member-password-file ./mia-pw] [--out type-audit] [--width 390 --height 844] [--only drawer,admin]
//     [--anon-only] [--file shared/a.txt]
//
// Passwords: --password-file / --member-password-file, or TYPE_AUDIT_PASSWORD / TYPE_AUDIT_MEMBER_PASSWORD in the
// environment (never on the command line). --out defaults to a new folder under the OS temp directory.
// Run it only against a test server: it saves the visible text of every screen to audit.csv, makes one failed sign-in
// (the login error view) and marks the rooms it opens as read.
// Content: the more the server has (rooms, a chat with an answer, files, a skill, a project, a schedule), the more
// screens have something to measure. Views whose content is missing are listed as skipped in the summary.
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const argv = process.argv.slice(2)
const opt = (name: string, d = '') => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] ? argv[i + 1]! : d }
const BASE = opt('base', 'http://127.0.0.1:19100').replace(/\/$/, '')
const OUT = path.resolve(opt('out', path.join(os.tmpdir(), `type-audit-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`)))
const W = Number(opt('width', '390')), H = Number(opt('height', '844'))
const ONLY = opt('only') ? new Set(opt('only').split(',')) : null
const read = (f: string) => (f ? fs.readFileSync(f, 'utf8').trim() : '')
const OWNER = { user: opt('user', 'kim'), password: process.env.TYPE_AUDIT_PASSWORD ?? read(opt('password-file')) }
const MEMBER = opt('member') ? { user: opt('member'), password: process.env.TYPE_AUDIT_MEMBER_PASSWORD ?? read(opt('member-password-file')) } : null

interface Text { size: number; lh: string; weight: string; family: string; tag: string; cls: string; ctx: string; testid: string; text: string; kind: string }
interface Row extends Text { view: string; route: string; count: number; flag: string }

/** In the page: every visible text node under `scope` with its computed style and a guess of what kind of text it is. */
function collect(scope: string | null): Text[] {
  const root = (scope ? document.querySelector(scope) : document.body) ?? document.body
  const probe = (cls: string) => { const s = document.createElement('span'); s.className = cls; document.body.appendChild(s); const c = getComputedStyle(s).color; s.remove(); return c }
  const ink = probe('text-ink')
  const clsOf = (el: Element) => (el.getAttribute('class') ?? '').trim()
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return false
    let op = 1
    for (let e: Element | null = el; e; e = e.parentElement) {
      const s = getComputedStyle(e)
      if (s.display === 'none' || s.visibility === 'hidden') return false
      op *= Number(s.opacity)
      if (op < 0.05) return false
      if (s.clipPath === 'inset(50%)' || s.clip === 'rect(0px, 0px, 0px, 0px)') return false
    }
    return true
  }
  const out: Text[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = (n.textContent ?? '').replace(/\s+/g, ' ').trim()
    const el = n.parentElement
    if (!text || !el || el.closest('script,style,noscript,template,head')) continue
    if (!visible(el)) continue
    const cs = getComputedStyle(el)
    // the classes that set the look: the element's own and, for context, the nearest few ancestors'
    const ctx: string[] = []
    for (let e: Element | null = el.parentElement, i = 0; e && i < 3; e = e.parentElement, i++) if (clsOf(e)) ctx.push(clsOf(e))
    const family = /mono|Menlo|Consolas|SFMono/i.test(cs.fontFamily) ? 'mono' : 'sans'
    // what kind of text: by the size token on the element or the nearest ancestor that sets one, else by its colour
    // (--c-ink is primary text; any other colour is secondary: meta, hints, times)
    let token = ''
    for (let e: Element | null = el, i = 0; e && i < 4 && !token; e = e.parentElement, i++)
      token = / text-(nano|micro|xs|label|sm|base|reading|lg|xl|2xl|code(?:-sm|-file)?)\b/.exec(` ${clsOf(e)}`)?.[1] ?? ''
    let kind = 'body'
    if (family === 'mono') kind = 'code'
    else if (el.closest('[aria-hidden="true"]') && text.length <= 2) kind = 'glyph'
    // a badge is a known kind of element, never "any text-nano": [data-badge], or a count or tag by its test id
    else if (el.closest('[data-badge], [data-testid$="-unread"], [data-testid$="-badge"], [data-testid="inbox-unread"], [data-testid="skills-pending"]')) kind = 'badge'
    else if (token === 'micro' || token === 'xs' || el.closest('time,kbd')) kind = 'meta'
    else if (token === 'label') kind = 'label'
    else if (el.closest('button,a,[role="tab"],[role="menuitem"],[role="option"],label,legend,summary,th,select')) kind = 'control'
    else if (cs.color !== ink) kind = 'meta'
    const testid = el.closest('[data-testid]')?.getAttribute('data-testid') ?? ''
    out.push({ size: Number.parseFloat(cs.fontSize), lh: cs.lineHeight, weight: cs.fontWeight, family, tag: el.tagName.toLowerCase(), cls: clsOf(el), ctx: ctx[0] ?? '', testid, text: text.slice(0, 48), kind })
  }
  return out
}

// the phone floor (docs/DESIGN-SYSTEM.md): body and rows 15, labels 14, meta (times, hints, captions, secondary text)
// and controls 13, code 13, badges 11. A glyph (an avatar's initial, aria-hidden beside the name) is not text to read.
const FLOOR: Record<string, number> = { body: 15, label: 14, meta: 13, control: 13, code: 13, badge: 11, glyph: 0 }
function flagOf(t: Text): string {
  if (t.kind === 'glyph') return ''
  if (t.size < 11) return 'under-11'
  if (t.size < 12 && t.kind !== 'badge') return 'under-12'
  if (t.size < FLOOR[t.kind]!) return `${t.kind}-under-${FLOOR[t.kind]}`
  return ''
}

const rows: Row[] = []
const skipped: string[] = []

async function signIn(ctx: BrowserContext, who: { user: string; password: string }) {
  const r = await ctx.request.post(`${BASE}/api/auth/login`, { headers: { origin: BASE, 'x-mycel-csrf': '1' }, data: { username: who.user, password: who.password } })
  if (!r.ok()) throw new Error(`sign-in ${who.user}: ${r.status()} ${await r.text()}`)
}
async function api<T>(page: Page, p: string): Promise<T | null> {
  const r = await page.request.get(`${BASE}${p}`, { headers: { 'x-mycel-csrf': '1' } })
  return r.ok() ? ((await r.json()) as T) : null
}
const settle = (page: Page, ms = 900) => page.waitForTimeout(ms)

async function view(page: Page, name: string, route: string, opts: { scope?: string; open?: (p: Page) => Promise<unknown>; wait?: string } = {}) {
  if (ONLY && !ONLY.has(name) && !ONLY.has(name.split(':')[0]!)) return
  try {
    await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector(opts.wait ?? '#root *', { timeout: 15_000 })
    await settle(page)
    if (opts.open) { await opts.open(page); await settle(page, 700) }
    if (opts.scope) await page.waitForSelector(opts.scope, { timeout: 8_000 })
    const texts = await page.evaluate(collect, opts.scope ?? null)
    const seen = new Map<string, Row>()
    for (const t of texts) {
      const key = `${t.size}|${t.lh}|${t.weight}|${t.cls}|${t.testid}|${t.kind}`
      const r = seen.get(key)
      if (r) r.count++
      else seen.set(key, { ...t, view: name, route, count: 1, flag: flagOf(t) })
    }
    rows.push(...seen.values())
    console.log(`${name.padEnd(28)} ${texts.length} texts, ${[...seen.values()].filter((r) => r.flag).length} flagged styles`)
  } catch (e) {
    skipped.push(`${name} (${route}): ${String(e).split('\n')[0]}`)
    console.log(`${name.padEnd(28)} skipped: ${String(e).split('\n')[0]}`)
  }
}
const click = (sel: string) => async (p: Page) => { await p.locator(sel).first().click({ timeout: 8_000 }) }
const longPress = (sel: string) => async (p: Page) => {
  const el = p.locator(sel).first()
  await el.dispatchEvent('pointerdown', { pointerType: 'touch', button: 0, isPrimary: true, clientX: 40, clientY: 20 })
  await p.waitForTimeout(800)
  await el.dispatchEvent('pointerup', { pointerType: 'touch', button: 0, isPrimary: true, clientX: 40, clientY: 20 })
}

async function ownerViews(browser: Browser) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, hasTouch: true, isMobile: true, locale: 'ko-KR' })
  await signIn(ctx, OWNER)
  const page = await ctx.newPage()
  await page.goto(`${BASE}/`)
  type List<T> = { items: T[] }
  const chats = (await api<List<{ id: string }>>(page, '/api/chats'))?.items ?? []
  const rooms = (await api<List<{ id: string; kind: string }>>(page, '/api/rooms'))?.items ?? []
  const projects = (await api<List<{ id: string }>>(page, '/api/projects'))?.items ?? []
  const schedules = (await api<List<{ id: string }>>(page, '/api/schedules'))?.items ?? []
  const file = opt('file', 'shared/budget-2027.txt')

  // the shell
  await view(page, 'home', '/')
  // the goal row under the box, opened (its next step and button); closed it is part of "home"
  await view(page, 'home:goal-open', '/', { open: click('[data-testid="team-goal-toggle"]'), scope: '[data-testid="team-goal"]' })
  await view(page, 'drawer', '/', { open: click('[data-testid="menu-open"]'), scope: '[data-drawer]' })
  await view(page, 'search', '/', { open: async (p) => { await p.keyboard.press('Control+k') }, scope: '[data-testid="search-palette"]' })
  // a team file attached to the message box: its chip with the folder line
  await view(page, 'home:team-attachment', '/', {
    open: async (p) => {
      await click('[data-testid="attach-button"]')(p)
      await click('[data-testid="attach-team"]')(p)
      await p.locator('[data-testid="picker-folder"]', { hasText: 'shared' }).first().click({ timeout: 8_000 })
      await click('[data-testid="picker-file"]')(p)
      await click('[data-testid="picker-attach"]')(p)
    },
  })
  await view(page, 'rooms', '/rooms')
  await view(page, 'rooms:new-dm', '/rooms?new=1', { scope: '[role="dialog"]' })
  for (const r of rooms) {
    await view(page, `room:${r.kind}`, `/rooms/${r.id}`)
    await view(page, `room:${r.kind}:sheet`, `/rooms/${r.id}`, { open: longPress('[data-testid="room-message"]'), scope: '[role="menu"]' })
    if (r.kind !== 'dm') await view(page, `room:${r.kind}:members`, `/rooms/${r.id}`, { open: click('[data-testid="room-members-button"]'), scope: '[role="dialog"]' })
  }
  await view(page, 'room:not-found', '/rooms/01a1abcb-0000-7000-8000-000000000000')
  for (const [i, c] of chats.entries()) {
    await view(page, `chat:${i}`, `/c/${c.id}`, { wait: '[data-testid="messages"]', open: async (p) => { await p.locator('[data-testid="messages"]').evaluate((e) => (e.scrollTop = 0)) } })
    if (i === 0) {
      await view(page, 'chat:steps-open', `/c/${c.id}`, { open: click('[data-testid="steps"] button'), wait: '[data-testid="messages"]' })
      await view(page, 'chat:title-menu', `/c/${c.id}`, { open: click('[data-testid="chat-title"], [data-testid="chat-menu"]'), scope: '[role="menu"]' })
      await view(page, 'chat:attach-menu', `/c/${c.id}`, { open: click('[data-testid="attach-button"]'), scope: '[role="menu"]' })
      await view(page, 'chat:engine-menu', `/c/${c.id}`, { open: click('[data-testid="engine-picker"]'), scope: '[role="listbox"]' })
      await view(page, 'chat:sources', `/c/${c.id}`, { open: click('[data-testid="answer-sources"] > button'), wait: '[data-testid="messages"]' })
      await view(page, 'chat:file-panel', `/c/${c.id}`, { open: click('[data-testid="team-file-chip"]'), scope: '[data-testid="file-panel"]' })
    }
  }
  await view(page, 'chat:not-found', '/c/01a1abcb-0000-7000-8000-000000000000')
  // files
  await view(page, 'files', '/files')
  await view(page, 'files:shared', '/files?path=shared')
  await view(page, 'files:selected', '/files?path=shared', { open: longPress('[data-testid="file-row"] button') })
  await view(page, 'files:row-menu', '/files?path=shared', { open: click('[data-testid="file-row"] [aria-haspopup="menu"], [data-testid="file-row"] button[aria-expanded]'), scope: '[role="menu"]' })
  await view(page, 'files:trash', '/files?tab=trash')
  await view(page, 'file-view', `/files/view?path=${encodeURIComponent(file)}`)
  // the file panel's ⋯ (add to chat, open in Files, download): a sheet from the bottom on phones
  await view(page, 'file-view:more', `/files/view?path=${encodeURIComponent(file)}`, { open: click('[data-testid="file-panel-more"]'), scope: '[role="menu"]' })
  // projects, schedules, skills, trash, inbox
  await view(page, 'projects', '/projects')
  if (projects[0]) await view(page, 'project', `/projects/${projects[0].id}`)
  await view(page, 'scheduled', '/scheduled')
  if (schedules[0]) await view(page, 'schedule', `/scheduled/${schedules[0].id}`)
  await view(page, 'skills', '/skills')
  await view(page, 'skills:review', '/skills?review=1')
  await view(page, 'skills:form', '/skills?run=skills/weekly-report/SKILL.md')
  await view(page, 'trash', '/trash')
  await view(page, 'welcome', '/welcome')
  // settings: the 나 tab, every section and the pages under them
  await view(page, 'settings', '/settings')
  for (const s of ['profile', 'security', 'usage', 'memory', 'credentials', 'drive', 'integrations', 'connectors', 'notifications', 'apps', 'about'])
    await view(page, `settings:${s}`, `/settings/${s}`)
  // another device's sign-out asks first (보안·기기; needs a second session of the owner)
  await view(page, 'settings:security:sign-out', '/settings/security', { open: click('[data-testid="device-sign-out"]'), scope: '[role="dialog"]:has([data-testid="dialog-confirm"])' })
  await view(page, 'settings:schedules', '/settings/schedules')
  await view(page, 'settings:account-delete', '/settings/account/delete')
  // admin: every section
  for (const s of ['', 'members', 'groups', 'folders', 'engines', 'credentials', 'integrations', 'plugins', 'slack', 'usage', 'audit', 'settings', 'system'])
    await view(page, `admin:${s || 'home'}`, `/admin${s ? `/${s}` : ''}`)
  await view(page, 'admin:add-member', '/admin/members', { open: async (p) => p.getByRole('button', { name: /직접 추가|Add directly/ }).first().click({ timeout: 8_000 }), scope: '[role="dialog"]' })
  await view(page, 'admin:invite', '/admin/members', { open: click('[data-testid="invite-new"]'), scope: '[role="dialog"]' })
  // Slack pages, a confirm dialog, the connectors consent page without a request
  await view(page, 'slack:link', '/slack/link?token=nothing')
  await view(page, 'slack:done-ok', '/slack/done?slack=linked')
  await view(page, 'slack:done-fail', '/slack/done?slack=signin_expired')
  await view(page, 'connectors:authorize', '/connectors/authorize')
  if (chats[0])
    await view(page, 'confirm-dialog', `/c/${chats[0].id}`, {
      open: async (p) => { await click('[data-testid="chat-title"], [data-testid="chat-menu"]')(p); await p.getByRole('menuitem').last().click({ timeout: 8_000 }) },
      scope: '[role="dialog"], [role="alertdialog"]',
    })
  await ctx.close()
}

async function anonViews(browser: Browser) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, hasTouch: true, isMobile: true, locale: 'ko-KR' })
  const page = await ctx.newPage()
  await view(page, 'login', '/login', { wait: 'input' })
  await view(page, 'login:error', '/login', { wait: 'input', open: async (p) => { await p.locator('input').first().fill('nobody'); await p.locator('input[type="password"]').first().fill('wrong password 1'); await p.keyboard.press('Enter'); await p.waitForTimeout(800) } })
  await view(page, 'invite:bad', '/invite/not-a-token')
  await view(page, 'join', '/join')
  await view(page, 'reset:bad', '/reset-password/not-a-token')
  await view(page, 'setup', '/setup')
  await view(page, 'slack:done-anon', '/slack/done?slack=linked')
  for (const extra of (opt('anon-routes') || '').split(',').filter(Boolean)) await view(page, `anon:${extra}`, extra)
  await ctx.close()
}

async function memberViews(browser: Browser) {
  if (!MEMBER) return
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, hasTouch: true, isMobile: true, locale: 'ko-KR' })
  await signIn(ctx, MEMBER)
  const page = await ctx.newPage()
  await view(page, 'member:home', '/')
  // a first-time member's Home: the folders row opens the list in a sheet (the row and the example rows are in "home")
  await view(page, 'member:home:folders', '/', { open: click('[data-testid="first-time-folders-open"]'), scope: '[role="dialog"]' })
  await view(page, 'member:drawer', '/', { open: click('[data-testid="menu-open"]'), scope: '[data-drawer]' })
  await view(page, 'member:rooms', '/rooms')
  await view(page, 'member:settings', '/settings')
  await view(page, 'member:files', '/files')
  await ctx.close()
}

const browser = await chromium.launch()
try {
  await anonViews(browser)
  // --anon-only: the signed-out pages alone (a server before its first account shows /setup)
  if (!argv.includes('--anon-only')) {
    await ownerViews(browser)
    await memberViews(browser)
  }
} finally {
  await browser.close()
}

fs.mkdirSync(OUT, { recursive: true })
const esc = (v: unknown) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
const cols: (keyof Row)[] = ['view', 'route', 'flag', 'kind', 'size', 'lh', 'weight', 'family', 'tag', 'testid', 'cls', 'ctx', 'count', 'text']
fs.writeFileSync(path.join(OUT, 'audit.csv'), [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n')

const flagged = rows.filter((r) => r.flag)
const byFlag = new Map<string, number>()
for (const r of flagged) byFlag.set(r.flag, (byFlag.get(r.flag) ?? 0) + r.count)
const groups = new Map<string, { n: number; views: Set<string>; r: Row }>()
for (const r of flagged) {
  const k = `${r.flag}|${r.size}|${r.cls}`
  const g = groups.get(k) ?? { n: 0, views: new Set<string>(), r }
  g.n += r.count; g.views.add(r.view); groups.set(k, g)
}
const sizes = new Map<number, number>()
for (const r of rows) sizes.set(r.size, (sizes.get(r.size) ?? 0) + r.count)
const md = [
  `# Phone type audit (${W}×${H}) — ${BASE}`, '',
  `Views: ${new Set(rows.map((r) => r.view)).size}, text nodes: ${rows.reduce((a, r) => a + r.count, 0)}, distinct styles: ${rows.length}.`,
  `Flagged text nodes: ${flagged.reduce((a, r) => a + r.count, 0)} (${flagged.length} styles).`, '',
  '| Rule | Text nodes |', '| --- | --- |', ...[...byFlag].sort((a, b) => b[1] - a[1]).map(([f, n]) => `| ${f} | ${n} |`), '',
  '| Size (px) | Text nodes |', '| --- | --- |', ...[...sizes].sort((a, b) => a[0] - b[0]).map(([s, n]) => `| ${s} | ${n} |`), '',
  '## Flagged, grouped by rule, size and classes', '',
  '| Rule | px | Nodes | Views | Classes | Example |', '| --- | --- | --- | --- | --- | --- |',
  ...[...groups.values()].sort((a, b) => b.n - a.n).map((g) => `| ${g.r.flag} | ${g.r.size} | ${g.n} | ${[...g.views].slice(0, 4).join(' ')}${g.views.size > 4 ? ` +${g.views.size - 4}` : ''} | \`${(g.r.cls || g.r.ctx).slice(0, 90)}\` | ${g.r.testid ? `[${g.r.testid}] ` : ''}${g.r.text.replace(/\|/g, '/')} |`),
  '', '## Skipped views', '', ...(skipped.length ? skipped.map((s) => `- ${s}`) : ['none']), '',
]
fs.writeFileSync(path.join(OUT, 'summary.md'), md.join('\n'))
console.log(`\n${rows.length} styles, ${flagged.length} flagged; ${skipped.length} views skipped → ${OUT}`)
