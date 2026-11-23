// The picture card's No (tools/own-picture.ts, QA TC-8340): the AI said "허용하지 않음이 선택돼서" while the button read
// "넣지 않기". What it is told names the button the person pressed, in each of the six languages.
import { describe, expect, test } from 'bun:test'
import { Locale } from '@mycel/shared/api'
import type { AppContext } from '../../server/src/context'
import type { ToolCtx } from '../../server/src/files/service'
import { confirmNotOwnPictures, PICTURE_TEXT } from '../../server/src/tools/own-picture'

const said = async (locale: Locale): Promise<{ text: string; no: string }> => {
  let no = ''
  const person = { locale, confirm: async (_q: string, _yes: string, deny: string) => { no = deny; return false } }
  try {
    await confirmNotOwnPictures({} as AppContext, { person } as unknown as ToolCtx, [{ name: 'shared/seal.png', key: 'picture:t:shared/seal.png' }], 'users/a/form.docx')
  } catch (e) { return { text: String((e as Error).message), no } }
  throw new Error('the card\'s No did not refuse')
}

describe('the picture card\'s No, as the AI is told it', () => {
  for (const L of Locale.options) test(L, async () => {
    const { text, no } = await said(L)
    expect(no).toBe(PICTURE_TEXT.no[L])
    expect(text).toContain(`pressed "${no}"`)
    expect(text).toContain(`call it exactly "${no}"`)
    expect(text).toContain('Nothing was saved')
    expect(text).not.toContain('did not allow')
  })
})
