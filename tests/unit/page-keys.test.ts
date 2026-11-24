// Keys on a web page (shared/src/page-keys.ts, docs/decisions/20261124-browser-key-guard.md): what the desktop app's
// browser reads from a service's key page is hidden before it reaches the AI, and the page counts as a key screen;
// ordinary pages (English and Korean text, ids, hashes, versions, token counts, documentation placeholders) stay as
// they are. Also the server's guard around one browser call (server/src/chat/browser-keys.ts) with a fake window.
import { describe, expect, test } from 'bun:test'
import { findPageKeys, keyish, revealsKey, scanPageText } from '@mycel/shared/page-keys'
import type { BrowserResult } from '@mycel/shared/api'
import { guardedBrowserCall, keyScreenNote, maskBrowserResult, pageCheckOf, type BrowserCall } from '../../server/src/chat/browser-keys'
import { HIDDEN } from '../../server/src/integrations/connections/hide'
import { CONNECT_RULE } from '../../server/src/chat/prompt'
import { CANARIES, keyPageOutline, middleOf } from '../lib/page-key-canaries'


describe('key shapes on a page', () => {
  test('every canary is hidden in a read_page outline, the page is a key screen, nothing of a value is left', () => {
    const s = scanPageText(keyPageOutline(), HIDDEN)
    expect(s.keyScreen).toBe(true)
    for (const [name, c] of Object.entries(CANARIES)) {
      expect({ name, full: s.text.includes(c.value), middle: s.text.includes(middleOf(c.value)) }).toEqual({ name, full: false, middle: false })
    }
    expect(s.hidden).toBeGreaterThanOrEqual(Object.keys(CANARIES).length)
    // the page's own words stay
    expect(s.text).toContain('- heading "API keys" level=1 [ref_1]')
    expect(s.text).toContain('Client Secret')
  })

  test('each shape on its own, in plain page text (get_page_text), as "label: value", and in a JSON body', () => {
    for (const [name, c] of Object.entries(CANARIES)) {
      for (const text of [
        `${c.label ?? 'Your key'}\n${c.value}\nCreated Nov 24, 2026`,
        `${c.label ?? 'API key'}: ${c.value}`,
        JSON.stringify({ id: 'key_01', name: 'trina', secret: c.value }),
      ]) {
        const s = scanPageText(text, HIDDEN)
        expect({ name, text: text.slice(0, 40), keyScreen: s.keyScreen, leaked: s.text.includes(c.value) || s.text.includes(middleOf(c.value)) }).toEqual({ name, text: text.slice(0, 40), keyScreen: true, leaked: false })
      }
    }
  })

  test('a value read_page cut at 60 characters ("…") is still hidden', () => {
    const v = CANARIES['Anthropic']!.value
    const s = scanPageText(`- textbox "API key" [ref_3] type=text value="${v.slice(0, 60)}…"`, HIDDEN)
    expect(s.text).toBe(`- textbox "API key" [ref_3] type=text value="${HIDDEN}…"`)
  })

  test('a page that says the key is shown only once is a key screen, and random-looking runs on it are hidden too', () => {
    const v = 'Lq8vT2nW5yH9cZ3pK7mR1xB4'
    for (const said of [
      'Make sure to copy your personal access token now. You won’t be able to see it again!',
      'Please save your secret key in a safe place since you won\'t be able to view it again.',
      'API 키는 지금 한 번만 표시돼요. 창을 닫으면 다시 볼 수 없어요.',
      'APIキーは一度しか表示されません。',
      '此密钥仅显示一次。',
      'Guarde esta clave de API: solo se mostrará una vez.',
      'Kunci API ini hanya ditampilkan sekali.',
    ]) {
      const s = scanPageText(`${said}\n- code "${v}" [ref_9]`, HIDDEN)
      expect({ said, keyScreen: s.keyScreen, leaked: s.text.includes(v) }).toEqual({ said, keyScreen: true, leaked: false })
    }
  })

  test('on a key screen a value without its label (find lists the field alone) and a UUID key are hidden too', () => {
    const uuidKey = '9b2d7a1f-4c8e-4f6a-8c5e-1b8d4f6a0c5e'
    const s = scanPageText(`- paragraph "Copy your API key now. You won't be able to see it again." [ref_2]\n- textbox [ref_3] type=text value="${uuidKey}" at (640, 300)\n- textbox [ref_4] type=text value="Xy3Kp9QwZe" at (640, 340)`, HIDDEN)
    expect(s.keyScreen).toBe(true)
    expect(s.text).not.toContain(uuidKey)
    expect(s.text).not.toContain('Xy3Kp9QwZe')
    // not on an ordinary page: a UUID there is an id
    expect(scanPageText(`Project\n${uuidKey}`, HIDDEN).text).toContain(uuidKey)
  })

  test('a key-like value in an address is hidden but makes no key screen (a sign-in return, a signed link)', () => {
    const s = scanPageText('Navigated tab t1 to https://app.example.test/callback?code=Ab3dEf9hIjK1mNoP&state=xyz — Example\n- link "Download" [ref_2] href="https://cdn.example.test/f.pdf?X-Amz-Signature=9f86d081884c7d659a2f"', HIDDEN)
    expect(s.keyScreen).toBe(false)
    expect(s.text).not.toContain('Ab3dEf9hIjK1mNoP')
    expect(s.text).toContain('&state=xyz')
    // the same key shape in the page's text is one
    expect(scanPageText(`Your token\n${CANARIES['GitHub classic']!.value}`, HIDDEN).keyScreen).toBe(true)
  })
})

describe('ordinary pages are left alone', () => {
  const NORMAL: Record<string, string> = {
    'English article': 'https://news.example.test/a — News\n- heading "Q3 results beat expectations" level=1 [ref_1]\n- paragraph "Revenue rose 12% to $4.2 billion. The board meets on Nov 28, 2026 at 10:00." [ref_2]',
    'Korean text': '3분기 매출 보고서를 요약해 주세요. 비밀번호 변경은 설정 › 보안에서 할 수 있어요. 인증키 발급 안내는 아래 링크를 참고하세요.',
    'Korean address and phone': '부산광역시 해운대구 센텀중앙로 97, 1203호 · 051-123-4567 · help@example.test',
    'UUIDs and order ids': 'Order 123e4567-e89b-12d3-a456-426614174000 shipped. Request ID: 9b2d7a1f-4c8e-4f6a-8c5e-1b8d4f6a0c5e. Invoice INV-2026-11-0042.',
    'token counts and model names': 'Input tokens: 12,345 · Output tokens: 2,048 · max_tokens 4096 · gpt-4o-mini-2024-07-18 · claude-opus-4-5-20251101',
    'documentation placeholders': 'export OPENAI_API_KEY=your-api-key-here\nAuthorization: Bearer $TOKEN\nSet the API key in the X-API-Key header. Your key looks like sk-... (keep it secret).\napi_key = os.environ["API_KEY"]',
    'commit page': 'Fix API key loading in the settings page\ncommit 3f2a9c1e5b4d7a8c9e0f1a2b3c4d5e6f7a8b9c0d\n- link "3f2a9c1" [ref_4] href="/org/repo/commit/3f2a9c1e5b4d7a8c9e0f1a2b3c4d5e6f7a8b9c0d"',
    'versions and dates': 'Version v1.2.3-beta.4+build.567 released 2026-11-24T09:30:00Z (SHA256 checksum below). Key features: faster sync.',
    'database table': '- columnheader "id (Primary key)" [ref_1]\n- cell "Xk9mQ2vL7pR4tN8wB3cZ" [ref_2]\n- cell "Yh3nP8sK2mV6xQ9rT4bW" [ref_3]',
    'wallet address next to token': 'Token USDT · Contract 0xdAC17F958D2ee523a2206206994597C13D831ec7 · Holders 6,123,456',
    'a "do not show again" box': '- checkbox "Do not show this again" [ref_7]\n- link "Manage API keys" [ref_8]',
    'public key': 'Public key\nssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq8vT2nW5yH9cZ3pK7mR1xB4 dion@laptop',
    'key list with masked keys': '- row "trina-prod sk-...aB3d Created Nov 24, 2026 Never used" [ref_5]\n- button "Create new secret key" [ref_6]',
    'token name field (the AI typed it)': '- textbox "Token name" [ref_3] type=text value="trina-ax-laptop-2026"\n- textbox "Note" [ref_4] value="for Trina AX"',
  }
  for (const [name, text] of Object.entries(NORMAL)) {
    test(name, () => {
      const s = scanPageText(text, HIDDEN)
      expect({ text: s.text, keyScreen: s.keyScreen }).toEqual({ text, keyScreen: false })
    })
  }

  test('keyish: generated values yes; words, names, numbers, dates, UUIDs, wallets no', () => {
    for (const v of ['7f3a9c2e1b8d4f6a0c5e9b2d7a1f4c8e', 'Xy3Kp9QwZe', 'JBSWY3DPEHPK3PXP7Q2M', 'wJa9rXUtnF3MI/K7MDENG/bPxRfiCY4zQ2mN8kLp', 'Lq8vT2nW5yH9cZ3pK7mR1xB4']) expect({ v, keyish: keyish(v) }).toEqual({ v, keyish: true })
    for (const v of ['Authentication', 'getApiKeyFromEnvironment', 'Version2Final', '2026-11-24T09:30:00Z', '123e4567-e89b-12d3-a456-426614174000', '0xdAC17F958D2ee523a2206206994597C13D831ec7', 'your-api-key-here', 'trina-ax-laptop-2026', '12345678901234', 'v1.2.3-beta.4']) expect({ v, keyish: keyish(v) }).toEqual({ v, keyish: false })
  })

  test('a reveal sentence needs a key word near it (a banner that will not come back is not one)', () => {
    expect(revealsKey('This offer won\'t be shown again. Shop now!')).toBe(false)
    expect(revealsKey('Copy it now: you won\'t be able to see this token again.')).toBe(true)
  })

  test('2 MB of text is scanned in reasonable time', () => {
    const big = ('Lorem ipsum dolor sit amet token key secret 1234 abcdefghij ' + 'x'.repeat(40) + '\n').repeat(20_000)
    const t = performance.now()
    findPageKeys(big)
    expect(performance.now() - t).toBeLessThan(6_000)
  })
})

describe('the server guard around one browser call', () => {
  const ok = (text: string, image = false): BrowserResult => ({ callId: 'c', ok: true, content: [{ type: 'text', text }, ...(image ? [{ type: 'image' as const, mime: 'image/jpeg' as const, data: 'AAAA' }] : [])] })
  /** a window whose page is `page()`; records the calls it got */
  const windowOf = (page: () => string, answer?: (tool: string, args: Record<string, unknown>) => BrowserResult | null) => {
    const calls: { tool: string; args: Record<string, unknown> }[] = []
    const call: BrowserCall = async (tool, args) => {
      calls.push({ tool, args })
      const own = answer?.(tool, args)
      if (own) return own
      if (tool === 'read_page' || tool === 'get_page_text' || tool === 'find') return ok(page())
      return ok(`${tool} done`, tool === 'computer' && (args.action === 'screenshot' || args.action === 'zoom'))
    }
    return { call, calls }
  }

  test('which calls are checked against the page', () => {
    expect(pageCheckOf('computer', { action: 'screenshot', tabId: 't2' })).toEqual({ tabs: ['t2'], after: false, script: false })
    expect(pageCheckOf('computer', { action: 'left_click', ref: 'ref_1' })).toBeNull()
    expect(pageCheckOf('javascript_tool', { action: 'javascript_exec', text: '1' })).toEqual({ tabs: [undefined], after: true, script: true })
    expect(pageCheckOf('browser_batch', { actions: [{ name: 'computer', input: { action: 'left_click', ref: 'ref_1' } }, { name: 'computer', input: { action: 'zoom', region: [0, 0, 9, 9], tabId: 3 } }] })).toEqual({ tabs: [undefined, '3'], after: true, script: false })
    expect(pageCheckOf('browser_batch', { actions: [{ name: 'read_page', input: {} }] })).toBeNull()
    expect(pageCheckOf('read_page', {})).toBeNull()
  })

  test('a screenshot of a key page is refused before the window takes it; the AI is told to hand over', async () => {
    const w = windowOf(keyPageOutline)
    const g = await guardedBrowserCall('computer', { action: 'screenshot' }, w.call, 'ko')
    expect(g.refused).toBe(true)
    expect(w.calls.map((c) => c.tool)).toEqual(['read_page'])
    expect(w.calls[0]!.args).toMatchObject({ filter: 'all', depth: 100 })
    if (g.refused) {
      expect(g.text).toContain('Not run: the page shows a key')
      expect(g.text).toContain('여기서부터는 직접 해 주세요. 키를 복사해서 연결 카드에 붙여 넣으면 돼요.')
      expect(g.summary).toBe('computer -> refused: the page shows a key (handed over)')
    }
  })

  test('a script on a key page is not run either', async () => {
    const w = windowOf(keyPageOutline)
    const g = await guardedBrowserCall('javascript_tool', { action: 'javascript_exec', text: 'document.querySelector("input").value.split("").reverse().join("")' }, w.call, 'en')
    expect(g.refused).toBe(true)
    expect(w.calls.map((c) => c.tool)).toEqual(['read_page'])
  })

  test('a screenshot of an ordinary page goes through, checked first', async () => {
    const w = windowOf(() => 'https://example.test — Example\n- heading "Hello" [ref_1]')
    const g = await guardedBrowserCall('computer', { action: 'screenshot' }, w.call, 'en')
    expect(g.refused).toBe(false)
    if (!g.refused) expect(g.result.content.filter((c) => c.type === 'image')).toHaveLength(1)
    expect(w.calls.map((c) => c.tool)).toEqual(['read_page', 'computer'])
  })

  test('a batch that opens the key screen and photographs it: the pictures and output are left out', async () => {
    let page = 'https://console.example.test — Console\n- button "Create key" [ref_1]'
    const w = windowOf(() => page, (tool) => {
      if (tool !== 'browser_batch') return null
      page = keyPageOutline()
      return ok('[1/2] computer:\nleft click on "Create key"\n[2/2] computer:\nScreenshot · viewport 1280x800', true)
    })
    const g = await guardedBrowserCall('browser_batch', { actions: [{ name: 'computer', input: { action: 'left_click', ref: 'ref_1' } }, { name: 'computer', input: { action: 'screenshot' } }] }, w.call, 'en')
    expect(g.refused).toBe(false)
    if (!g.refused) {
      expect(g.withheld).toBe(true)
      expect(g.keyScreen).toBe(true)
      expect(g.result.content).toEqual([])
      expect(g.notes.join('\n')).toContain('left out')
      expect(g.notes.join('\n')).toContain('Please take it from here. Copy the key and paste it into the connection card.')
    }
    expect(w.calls.map((c) => c.tool)).toEqual(['read_page', 'browser_batch', 'read_page'])
  })

  test('a single screenshot whose page cannot be read first is not taken (fails closed); a batch goes on and is checked after', async () => {
    const closed = (tool: string): BrowserResult | null => (tool === 'read_page' ? { callId: 'c', ok: false, content: [{ type: 'text', text: "The browser pane isn't open." }], error: "The browser pane isn't open." } : null)
    const single = windowOf(() => '', closed)
    const g = await guardedBrowserCall('computer', { action: 'screenshot' }, single.call, 'en')
    expect(g.refused).toBe(true)
    if (g.refused) expect(g.text).toContain("that read failed (The browser pane isn't open.)")
    expect(single.calls.map((c) => c.tool)).toEqual(['read_page'])
    let open = false
    const batch = windowOf(() => 'https://example.test — Example', (tool) => (tool === 'browser_batch' ? ((open = true), ok('navigated; Screenshot', true)) : !open ? closed(tool) : null))
    const b = await guardedBrowserCall('browser_batch', { actions: [{ name: 'navigate', input: { url: 'https://example.test' } }, { name: 'computer', input: { action: 'screenshot' } }] }, batch.call, 'en')
    expect(b.refused).toBe(false)
    if (!b.refused) expect(b.result.content.filter((c) => c.type === 'image')).toHaveLength(1)
    expect(batch.calls.map((c) => c.tool)).toEqual(['read_page', 'browser_batch', 'read_page'])
  })

  test('maskBrowserResult hides the error too and drops pictures only on a key screen', () => {
    const v = CANARIES['GitHub classic']!.value
    const m = maskBrowserResult({ callId: 'c', ok: false, content: [{ type: 'text', text: `Your token\n${v}` }, { type: 'image', mime: 'image/png', data: 'AAAA' }], error: `Your token\n${v}` })
    expect(m.keyScreen).toBe(true)
    expect(JSON.stringify(m.result)).not.toContain(v)
    expect(m.result.content.map((c) => c.type)).toEqual(['text'])
    const plain = maskBrowserResult(ok('hello', true))
    expect(plain).toEqual({ result: ok('hello', true), hidden: 0, keyScreen: false })
  })

  test('the hand-over sentence in every app language, and the connect rule for the web and the phone', () => {
    expect(keyScreenNote('en')).toContain('"Please take it from here. Copy the key and paste it into the connection card."')
    for (const l of ['ko', 'id', 'ja', 'es', 'zh'] as const) expect(keyScreenNote(l)).not.toContain('Please take it from here')
    expect(keyScreenNote('id')).toContain('Silakan lanjutkan sendiri dari sini.')
    expect(CONNECT_RULE).toContain("give the steps and the link to the service's key page")
  })
})
