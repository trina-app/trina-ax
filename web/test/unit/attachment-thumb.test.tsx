// An image attached to a chat message (components/chat/Messages.tsx AttachmentView): a soft box holds its place while
// the thumbnail loads, and nothing is painted behind it once it is there, so a picture with transparency (a seal
// stamp; its thumbnail is a PNG, uploads/image.ts) sits on the page itself, in light and dark mode alike.
import { expect, test } from 'bun:test'
import { act } from 'react'
import { uuidv7 } from '@mycel/shared/api'
import { AttachmentView } from '../../src/components/chat/Messages'
import { FakeEvent, installDom, mount, removeDom } from './dom-host'

test('an image attachment has a soft box only while its thumbnail loads', async () => {
  installDom()
  const id = uuidv7()
  const m = await mount(<AttachmentView a={{ id, name: 'seal.png', path: `users/alex/.attachments/c/seal.png`, size: 1000, mime: 'image/png', kind: 'image' }} />)
  try {
    const img = m.container.querySelector('img')!
    expect(img.getAttribute('src')).toBe(`/api/uploads/${id}/thumbnail`)
    const box = img.parentElement!
    expect(box.className).not.toContain('bg-')
    expect(img.className).toContain('bg-subtle')
    await act(async () => { img.dispatchEvent(new FakeEvent('load')) })
    expect(img.className).not.toContain('bg-')
    expect(box.className).not.toContain('bg-')
  } finally {
    await m.unmount()
    removeDom()
  }
})
