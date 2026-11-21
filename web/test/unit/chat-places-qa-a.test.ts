// Chat places QA-A (2026-11-22): the web side of TC-6935 (a chat file link that does not open), TC-6942 (a Word file
// with no page of its own) and TC-6944 (a guest whose team's AI is not for guests).
import { describe, expect, test } from 'bun:test'
import { chatFileLinkStep, chatFileName } from '../../src/lib/chatFileLink'
import { chatErrorText } from '../../src/lib/chatErrors'
import { defaultDocxPages, DOCX_DEFAULT_PAGE } from '../../src/lib/docxPage'
import { en } from '../../src/i18n/en'
import { ko } from '../../src/i18n/ko'

describe('TC-6935: a chat file link opens a viewer only for a chat and a file I can open', () => {
  const ID = '01a1fc0c-bb3a-74b5-a134-7fcbe2e1b208'
  test('a chat that does not open: no viewer (its page says why)', () => {
    expect(chatFileLinkStep({ file: ID, loading: false, loadError: new Error('not_found'), name: 'report.txt' })).toBe('none')
    expect(chatFileLinkStep({ file: ID, loading: true, loadError: new Error('not_found'), name: null })).toBe('none')
  })
  test('while the chat loads: wait; then open with the name the messages give, or ask the server', () => {
    expect(chatFileLinkStep({ file: ID, loading: true, loadError: null, name: null })).toBe('wait')
    expect(chatFileLinkStep({ file: ID, loading: false, loadError: null, name: 'report.txt' })).toBe('open')
    expect(chatFileLinkStep({ file: ID, loading: false, loadError: null, name: null })).toBe('look')
  })
  test('no link or a malformed id: nothing', () => {
    expect(chatFileLinkStep({ file: null, loading: false, loadError: null, name: null })).toBe('none')
    expect(chatFileLinkStep({ file: '../x', loading: false, loadError: null, name: null })).toBe('none')
  })
  test('the name of the newest version; none when there is nothing', () => {
    expect(chatFileName({ items: [{ name: 'a.txt' }, { name: 'b.txt', head: true }, { name: 'c.txt' }] })).toBe('b.txt')
    expect(chatFileName({ items: [{ name: 'a.txt' }, { name: 'b.txt' }] })).toBe('b.txt')
    expect(chatFileName({ items: [] })).toBeNull()
    expect(chatFileName(null)).toBeNull()
  })
})

describe('TC-6942: a Word page with no size of its own gets Word\'s default page', () => {
  const section = (style: Record<string, string> = {}) => ({ tagName: 'SECTION', style: { width: '', minHeight: '', padding: '', paddingLeft: '', paddingRight: '', paddingTop: '', paddingBottom: '', ...style } as unknown as CSSStyleDeclaration })
  test('no width, no margins: Letter with 1 inch margins', () => {
    const s = section()
    expect(defaultDocxPages({ children: [s, { tagName: 'STYLE' }] })).toBe(1)
    expect(s.style.width).toBe(DOCX_DEFAULT_PAGE.width)
    expect(s.style.minHeight).toBe(DOCX_DEFAULT_PAGE.minHeight)
    expect(s.style.padding).toBe(DOCX_DEFAULT_PAGE.margin)
  })
  test('a page the file sized keeps its own size and margins', () => {
    const s = section({ width: '595.3pt', minHeight: '841.9pt', paddingLeft: '56.7pt', paddingRight: '56.7pt', paddingTop: '56.7pt', paddingBottom: '56.7pt' })
    expect(defaultDocxPages({ children: [s] })).toBe(0)
    expect(s.style.width).toBe('595.3pt')
    expect(s.style.padding).toBe('')
    // zero margins written by the file stay zero
    const z = section({ width: '612pt', paddingLeft: '0pt', paddingRight: '0pt', paddingTop: '0pt', paddingBottom: '0pt' })
    expect(defaultDocxPages({ children: [z] })).toBe(0)
  })
})

describe('TC-6944: a guest is told AI is not for guests here, not to tell an admin', () => {
  test('the words for every reader', () => {
    expect(chatErrorText('guest_no_ai', undefined, true).key).toBe('chat.error.guest_no_ai')
    expect(chatErrorText('guest_no_ai', 'owner', true)).toEqual({ key: 'chat.error.guest_no_ai', where: null })
    expect(en['chat.error.guest_no_ai']).toBe("AI isn't available for guests in this team.")
    expect(ko['chat.error.guest_no_ai']).not.toContain('관리자')
  })
})
