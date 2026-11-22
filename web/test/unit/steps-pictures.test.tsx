// Pictures a tool saved are shown by the chat under its step, not retyped by the AI (replay 11-22: after a banner change
// the AI's third picture linked the 1080x1080 file again instead of the story size). change_banner_text's step carries
// its three sizes (Step.images with a label each): the folded steps show each one once with its size under it, and a
// Markdown picture in the answer that repeats one of them is left out (components/chat/Messages.tsx AnswerImagesShown).
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import type { Step } from '@mycel/shared/api'
import Steps from '../../src/components/chat/Steps'
import { AnswerImagesShown } from '../../src/components/chat/Messages'
import { Markdown } from '../../src/components/Markdown'
import { stepImages } from '../../src/lib/stepImages'

const folder = 'projects/yuzu'
const sizes = ['1200x628', '1080x1080', '1080x1920']
const files = sizes.map((s) => `${folder}/banner-${s}-abc123.png`)
const banner: Step = {
  id: 'b', kind: 'tool', tool: 'change_banner_text', label: 'change_banner_text', status: 'ok', startedAt: '2026-11-22T03:00:00.000Z', endedAt: '2026-11-22T03:00:02.000Z',
  images: files.map((path, i) => ({ path, alt: `banner ${sizes[i]}`, label: sizes[i] })),
}
const read: Step = { id: 'r', kind: 'tool', tool: 'read', label: `read ${folder}/banner.json`, status: 'ok', startedAt: '2026-11-22T02:59:00.000Z', endedAt: '2026-11-22T02:59:01.000Z' }
const src = (p: string) => `/api/files/download?path=${encodeURIComponent(p)}`
/** how many <img> load this file */
const count = (html: string, p: string) => html.split(`src="${src(p).replace(/&/g, '&amp;')}`).length - 1

describe('a tool\'s saved pictures under its step', () => {
  test('the folded steps show the three sizes once each, each labelled with its size', () => {
    const html = renderToStaticMarkup(<MemoryRouter><Steps steps={[read, banner]} streaming={false} /></MemoryRouter>)
    for (const p of files) expect(count(html, p)).toBe(1)
    const labels = [...html.matchAll(/data-testid="step-picture-label">([^<]+)</g)].map((m) => m[1])
    expect(labels).toEqual(sizes)
  })

  test('the answer leaves out a Markdown repeat of a picture its steps show (the mistyped third picture of 11-22)', () => {
    // the AI retyped the 1080x1080 file where the story size belonged
    const answer = `배너를 바꿨어요.\n\n![a](${src(files[0]!)}) ![b](${src(files[1]!)}) ![c](${src(files[1]!)})\n\n![other](${src(`${folder}/photo.png`)})`
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <Steps steps={[read, banner]} streaming={false} />
        <AnswerImagesShown steps={[read, banner]}><Markdown text={answer} copyQuotes /></AnswerImagesShown>
      </MemoryRouter>,
    )
    // each size once on the page (under the steps), none twice
    for (const p of files) expect(count(html, p)).toBe(1)
    expect(html).toContain('배너를 바꿨어요.')
    // a picture no step shows stays in the answer
    expect(count(html, `${folder}/photo.png`)).toBe(1)
    // outside an answer (no steps) a Markdown picture is drawn as before
    expect(count(renderToStaticMarkup(<MemoryRouter><Markdown text={`![a](${src(files[0]!)})`} /></MemoryRouter>), files[0]!)).toBe(1)
  })

  test('a browser screenshot without a label is still shown when folded; each path once across steps', () => {
    const shot: Step = { id: 's', kind: 'browser', tool: 'browser_screenshot', label: 'screenshot', status: 'ok', startedAt: '2026-11-22T03:01:00.000Z', endedAt: null, images: [{ path: 'users/a/shot.png', alt: 'screenshot' }] }
    const html = renderToStaticMarkup(<MemoryRouter><Steps steps={[shot, banner]} streaming={false} /></MemoryRouter>)
    expect(count(html, 'users/a/shot.png')).toBe(1)
    expect(stepImages([banner, { ...banner, id: 'b2' }]).map((x) => x.path)).toEqual(files)
  })
})
