// Icon-only controls carry the shared tooltip (docs/DESIGN-SYSTEM.md "Tooltip"). The static check that keeps it so
// (web/scripts/check-icon-tooltips.ts, run by `bun run check:docs`) on small samples, and a few of the controls
// themselves: a dialog's close button, a code block's download, a skill chip's remove, a browser site's remove, and a
// connector's "official" mark with what it means.
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import { iconOnlyProblems } from '../../scripts/check-icon-tooltips'
import { TOOLTIP_DELAY_MS } from '../../src/components/Tooltip'
import { Modal } from '../../src/components/ui'
import { CodeBlock } from '../../src/components/Markdown'
import { SkillChip } from '../../src/components/chat/SkillChip'
import { ConnectorDetail } from '../../src/components/integrations/ConnectorsView'
import { BrowserSettingsView } from '../../src/pages/BrowserSettings'
import { t } from '../../src/i18n'
import { FakeEvent, installDom, mount, removeDom, type Mounted } from './dom-host'

// ---------------- the static check ----------------
const problems = (body: string) => iconOnlyProblems('x.tsx', `import { X, Copy } from 'lucide-react'\nexport const A = () => (\n${body}\n)\n`).map((p) => p.why)

test('an icon-only button, link or Button needs a <Tooltip>', () => {
  expect(problems(`<button aria-label="닫기"><X size={14} /></button>`)).toEqual(['icon-only control without a <Tooltip>'])
  expect(problems(`<Link to="/" aria-label="뒤로"><X /></Link>`)).toEqual(['icon-only control without a <Tooltip>'])
  expect(problems(`<Button aria-label="복사">{copied ? <X /> : <Copy />}</Button>`)).toEqual(['icon-only control without a <Tooltip>'])
  // a picture handed in, words only for screen readers, words a narrow window hides: still icon-only
  expect(problems(`<button aria-label="열기">{icon}</button>`)).toHaveLength(1)
  expect(problems(`<button><X /><span className="sr-only">닫기</span></button>`)).toHaveLength(1)
  expect(problems(`<Button aria-label="업로드"><X /> <span className="@max-2xl:hidden">업로드</span></Button>`)).toHaveLength(1)
  expect(problems(`<button aria-label="AI"><X /> <span className="max-md:sr-only">AI</span></button>`)).toHaveLength(1)
})

test('wrapped, with words, an IconButton or a stated reason: fine', () => {
  expect(problems(`<Tooltip label="닫기"><button aria-label="닫기"><X /></button></Tooltip>`)).toEqual([])
  expect(problems(`<>{open && <Tooltip key={k} label="닫기"><button aria-label="닫기"><X /></button></Tooltip>}</>`)).toEqual([])
  expect(problems(`<button><X /> {t('common.close')}</button>`)).toEqual([])
  expect(problems(`<button aria-label="닫기"><X /> 닫기</button>`)).toEqual([])
  expect(problems(`<button>{label}</button>`)).toEqual([])
  expect(problems(`<IconButton label="닫기"><X /></IconButton>`)).toEqual([])
  expect(problems(`<>{/* no-tooltip: the row around it says it */}\n<button aria-label="닫기"><X /></button></>`)).toEqual([])
})

test("two tips at once, an IconButton's tip turned off outside a <Tooltip>, an icon's title: flagged", () => {
  expect(problems(`<Tooltip label="닫기"><button aria-label="닫기" title="닫기"><X /></button></Tooltip>`)).toEqual(['title= beside a <Tooltip> shows two tips'])
  expect(problems(`<Tooltip label="검색"><IconButton label="검색"><X /></IconButton></Tooltip>`)).toEqual(['IconButton in a <Tooltip> shows two tips: give it tip={false}'])
  expect(problems(`<IconButton tip={false} label="검색"><X /></IconButton>`)).toEqual(['IconButton tip={false} outside a <Tooltip>'])
  expect(problems(`<Tooltip label="⌘K"><IconButton tip={false} label="검색"><X /></IconButton></Tooltip>`)).toEqual([])
  expect(problems(`<span title="읽기 전용"><X /><span className="sr-only">읽기 전용</span></span>`)).toEqual(['title= on an icon: use <Tooltip>'])
  // a title on words (the full text of a cut-off name) is what title is for
  expect(problems(`<span className="truncate" title={path}>{path}</span>`)).toEqual([])
})

// ---------------- the controls ----------------
const media = (fine: boolean) => {
  ;(window as unknown as { matchMedia: (q: string) => { matches: boolean } }).matchMedia = (q: string) => ({ matches: fine && q.includes('fine'), addEventListener() {}, removeEventListener() {} } as never)
}
beforeAll(() => installDom())
afterEach(() => media(false))
afterAll(() => removeDom())

const tip = () => document.body.querySelector('[role="tooltip"]')
/** a mouse resting on it for the tooltip's delay: the tip's words */
async function hover(m: Mounted, el: unknown) {
  ;(el as { dispatchEvent: (e: unknown) => void }).dispatchEvent(Object.assign(new FakeEvent('pointerover', { bubbles: true }), { pointerType: 'mouse', relatedTarget: null }))
  await m.settle(TOOLTIP_DELAY_MS + 50)
  return tip()?.textContent ?? null
}
const leave = (el: unknown) => (el as { dispatchEvent: (e: unknown) => void }).dispatchEvent(Object.assign(new FakeEvent('pointerout', { bubbles: true }), { pointerType: 'mouse', relatedTarget: null }))

test("a dialog's close button: its name as the tip, no browser title", async () => {
  media(true)
  const m = await mount(<Modal open onClose={() => {}} title="설정"><p>…</p></Modal>)
  try {
    const close = document.body.querySelector(`button[aria-label="${t('common.close')}"]`)!
    expect(close.getAttribute('title')).toBeNull()
    expect(await hover(m, close)).toBe(t('common.close'))
  } finally { await m.unmount() }
})

test("a code block's download and a skill chip's remove: the tip names what the click does", async () => {
  media(true)
  let m = await mount(<CodeBlock lang="ts" code="const a = 1" />)
  try {
    const download = document.body.querySelector(`button[aria-label="${t('md.downloadCode')}"]`)!
    expect(download.getAttribute('title')).toBeNull()
    expect(await hover(m, download)).toBe(t('md.downloadCode'))
  } finally { await m.unmount() }
  m = await mount(<SkillChip title="회의록 정리" name="meeting-notes" onRemove={() => {}} />)
  try {
    expect(await hover(m, m.get('skill-chip-remove'))).toBe(t('composer.skillRemove', { skill: '회의록 정리' }))
    leave(m.get('skill-chip-remove'))
    await m.settle(10)
    expect(tip()).toBeNull()
  } finally { await m.unmount() }
})

test("Settings › Browser: a site's trash button says which site it removes, in the tooltip instead of a title", async () => {
  media(true)
  const noop = () => {}
  const m = await mount(
    <MemoryRouter>
      <BrowserSettingsView settings={{ siteAccess: 'ask', always: ['example.com'], privateAlways: [], teamAllowsAll: true }} onAccess={noop} onRemove={noop} onClear={noop} />
    </MemoryRouter>,
  )
  try {
    const remove = m.get('browser-site-remove')
    expect(remove.getAttribute('title')).toBeNull()
    expect(await hover(m, remove)).toBe(`${t('settings.browser.remove')} example.com`)
  } finally { await m.unmount() }
})

test("a connector's official mark: the tip says what official means, and describes the mark", async () => {
  media(true)
  const m = await mount(<ConnectorDetail logo="" name="Notion" line="문서" official description="…" onBack={() => {}} testId="cd" />)
  try {
    const mark = document.body.querySelector(`svg[aria-label="${t('connectors.official')}"]`)!
    expect(await hover(m, mark)).toBe(t('connectors.officialTip'))
    expect(mark.getAttribute('aria-describedby')).toBe(tip()!.getAttribute('id'))
  } finally { await m.unmount() }
})
