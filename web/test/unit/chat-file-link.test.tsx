// A chat file's link in an answer (docs/AGENTS/plan/20261121-0652-places-outputs.md): the produce tools give
// /c/<chat>?file=<id>, and the AI may write the file by its own name, chat:files/<id>/<name>. Both are a file chip that
// opens the chat file's viewer, never a link with an unknown scheme or the chat page itself.
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { Markdown, urlTransform } from '../../src/components/Markdown'
import { classifyLink } from '../../src/lib/markdown'

const id = '01a1fc0c-bb3a-74b5-a134-7fcbe2e1b208'
const inChat = (text: string) => renderToStaticMarkup(
  <MemoryRouter initialEntries={['/c/chat-1']}><Routes><Route path="/c/:chatId" element={<Markdown text={text} copyQuotes />} /></Routes></MemoryRouter>,
)

describe('chat file links', () => {
  test('classifyLink: /c/<chat>?file=<id> and chat:files/<id>/<name> are chat files; a chat link alone stays an app link', () => {
    expect(classifyLink(`/c/chat-1?file=${id}`, 'http://localhost')).toEqual({ kind: 'chat-file', chatId: 'chat-1', fileId: id, name: null })
    expect(classifyLink(`chat:files/${id}/deck.pptx`, 'http://localhost')).toEqual({ kind: 'chat-file', chatId: null, fileId: id, name: 'deck.pptx' })
    expect(classifyLink('chat:files/deck.pptx', 'http://localhost')).toEqual({ kind: 'blocked' })
    expect(classifyLink('/c/chat-1', 'http://localhost')).toEqual({ kind: 'app', href: '/c/chat-1' })
  })

  test('urlTransform keeps chat:files/ (a chip), still empties javascript:', () => {
    expect(urlTransform(`chat:files/${id}/a.pptx`)).toBe(`chat:files/${id}/a.pptx`)
    expect(urlTransform('javascript:alert(1)')).toBe('')
  })

  test('both render as a file chip in the chat on screen', () => {
    const a = inChat(`Attached: [deck.pptx](/c/chat-1?file=${id})`)
    expect(a).toContain('data-testid="chat-file-chip"')
    const b = inChat(`Attached: [deck.pptx](chat:files/${id}/deck.pptx)`)
    expect(b).toContain('data-testid="chat-file-chip"')
    expect(b).not.toContain('href="chat:')
  })
})
