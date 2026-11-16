// The phone app's photo picker leaves out what is too big and says so in one line (components/chat/AttachSheet.tsx).
// Korean names the kind in that line ("이 사진은"); a video or a file of another kind must not be called a photo there.
import { expect, test } from 'bun:test'
import { TOO_BIG_WORDS } from '../../src/components/chat/AttachSheet'
import { DICTS, translate } from '../../src/i18n'
import { mediaKindOf } from '../../src/lib/preview'

test('what the left-out files are: photos, videos, or files when mixed or not told by the name', () => {
  expect(mediaKindOf(['IMG_0001.HEIC', 'IMG_0002.jpg'])).toBe('photo')
  expect(mediaKindOf(['IMG_0003.MOV'])).toBe('video')
  expect(mediaKindOf(['long-video.mov', 'clip.mp4'])).toBe('video')
  expect(mediaKindOf(['IMG_0001.png', 'IMG_0003.mov'])).toBe('file')
  expect(mediaKindOf(['scan'])).toBe('file')
  expect(mediaKindOf(['report.pdf'])).toBe('file')
  expect(mediaKindOf([])).toBe('file')
})

test('the Korean line names the kind: 사진, 동영상, or 파일', () => {
  const max = '50 MB', total = '200 MB'
  const says = (kind: keyof typeof TOO_BIG_WORDS) => [
    translate('ko', TOO_BIG_WORDS[kind].limit, { names: 'a', max, total }),
    translate('ko', TOO_BIG_WORDS[kind].other, { names: 'a' }),
  ]
  for (const line of says('photo')) expect(line.startsWith('이 사진은 ')).toBe(true)
  for (const line of says('video')) expect(line.startsWith('이 동영상은 ')).toBe(true)
  for (const line of says('file')) expect(line.startsWith('이 파일은 ')).toBe(true)
  expect(translate('ko', TOO_BIG_WORDS.video.other, { names: 'long-video.mov' })).toBe('이 동영상은 커서 여기서는 넣을 수 없어요: long-video.mov. 다른 방법으로 골라 주세요.')
})

test('no language calls a video a photo: the others start with the names, the same line for every kind', () => {
  for (const [locale, dict] of Object.entries(DICTS)) {
    if (locale === 'ko') continue
    for (const which of ['limit', 'other'] as const) {
      expect(dict[TOO_BIG_WORDS.video[which]], `${locale} ${which}`).toBe(dict[TOO_BIG_WORDS.photo[which]])
      expect(dict[TOO_BIG_WORDS.file[which]], `${locale} ${which}`).toBe(dict[TOO_BIG_WORDS.photo[which]])
    }
  }
})
