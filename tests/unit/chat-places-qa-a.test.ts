// Chat places QA-A findings (2026-11-22, TC-6935..6944): the words people and the AI get, one test per finding where the
// fix is in shared or server code without a running chat (the turn-level cases are in the area tests).
import { describe, expect, test } from 'bun:test'
import { localizeStep, placeName, READ_SLIDES_VERB, shellWorkWords, slidesStep, stepLabel, stepPlace } from '@mycel/shared'
import { CHAT_ERROR_MESSAGES } from '@mycel/shared/api'
import type { Locale } from '@mycel/shared/api'
import { tr } from '../../server/src/chat/i18n'
import { copyCardFiles } from '../../server/src/chat/turn'
import { NO_WORK_WORDS, noWorkText, workAliasRel, WORK_WRITE_WORDS } from '../../server/src/devenv/work-files'
import { CHAT_FILES_NONE, PLACE_WORDS } from '../../server/src/files/places'
import { NO_CHAT_PLACE, placeWriteRefusal } from '../../server/src/files/service'
import { parsePages } from '../../server/src/files/vision'

const LOCALES: Locale[] = ['en', 'ko', 'id', 'ja', 'es', 'zh']
const none = new Set<string>()

describe('TC-6937: the work folder in words in every step line', () => {
  test('$TRINA_WORK, ${TRINA_WORK} and chat:work/ read the same', () => {
    for (const p of ['$TRINA_WORK/frame1.png', '${TRINA_WORK}/frame1.png', 'chat:work/frame1.png']) expect(placeName(p, 'en')).toBe('Work folder › frame1.png')
    expect(placeName('$TRINA_WORK', 'ko')).toBe('작업 폴더')
    expect(placeName('$TRINA_WORK/in/images', 'en')).toBe('Work folder › in › images')
    // a read and a video, as the step list shows them
    expect(stepPlace({ tool: 'read' }, stepLabel('read', { file_path: '$TRINA_WORK/frame1.png' }, 'en', none), 'en').label).toBe('Read · Work folder › frame1.png')
    expect(stepPlace({ tool: 'read' }, stepLabel('read', { file_path: '$TRINA_WORK/video.mp4' }, 'en', none), 'en').label).toBe('Watch video · Work folder › video.mp4')
    expect(stepPlace({ tool: 'list' }, stepLabel('list', { path: '$TRINA_WORK/in/images' }, 'en', none), 'en').label).toBe('List · Work folder › in › images')
    // a variable that only looks like it stays as written
    expect(placeName('$TRINA_WORKS/a', 'en')).toBeNull()
  })
  test('a command line: no leading cd into the work folder, the folder in words', () => {
    expect(shellWorkWords('cd "$TRINA_WORK" && ffmpeg -i "$TRINA_WORK/video.mp4" -frames:v 1 frame1.png', 'en')).toBe('ffmpeg -i "Work folder › video.mp4" -frames:v 1 frame1.png')
    expect(shellWorkWords('cd $TRINA_WORK; ls', 'en')).toBe('ls')
    expect(shellWorkWords('cp a.png ${TRINA_WORK}/out/', 'ko')).toBe('cp a.png 작업 폴더 › out')
    expect(shellWorkWords('ls -la', 'en')).toBe('ls -la')
    // another variable that starts the same, or a brace left open, stays as written
    expect(shellWorkWords('echo $TRINA_WORKSPACE $TRINA_WORK_DIR ${TRINA_WORK', 'en')).toBe('echo $TRINA_WORKSPACE $TRINA_WORK_DIR ${TRINA_WORK')
    const label = stepLabel('box_shell', { command: 'cd "$TRINA_WORK" && python3 make.py' }, 'en', none)
    expect(label).toBe('Dev environment command · python3 make.py')
    // a line saved before (the raw variable) reads the same on screen
    expect(stepPlace({ tool: 'box_shell' }, 'Dev environment command · cd "$TRINA_WORK" && ls "$TRINA_WORK/in"', 'en').label).toBe('Dev environment command · ls "Work folder › in"')
  })
})

describe('TC-6943: a look at slides says which slides', () => {
  test('pages or as_images of a .pptx: "View slides 3–5"', () => {
    expect(stepLabel('read', { file_path: 'users/u/launch.pptx', pages: '3-5' }, 'en', none)).toBe('View slides 3–5 · users/u/launch.pptx')
    expect(stepLabel('read', { file_path: 'users/u/launch.pptx', pages: '1-3,7' }, 'en', none)).toBe('View slides 1–3, 7 · users/u/launch.pptx')
    expect(stepLabel('read', { file_path: 'launch.pptx', as_images: true }, 'en', none)).toBe('View slides · launch.pptx')
    // a plain read of a deck is its text: the Read line; a PDF's pages keep the Read line
    expect(stepLabel('read', { file_path: 'launch.pptx' }, 'en', none)).toBe('Read · launch.pptx')
    expect(stepLabel('read', { file_path: 'a.pdf', pages: '2' }, 'en', none)).toBe('Read · a.pdf')
    // in the language on screen, the numbers kept; the icon knows it in any language
    const ko = stepLabel('read', { file_path: 'launch.pptx', pages: '2' }, 'ko', none)
    expect(ko).toBe(`${READ_SLIDES_VERB.ko} 2 · launch.pptx`)
    expect(localizeStep({ kind: 'tool', tool: 'read', label: ko }, 'en').label).toBe('View slides 2 · launch.pptx')
    for (const l of LOCALES) expect(slidesStep({ tool: 'read', label: stepLabel('read', { file_path: 'x.pptx', pages: '1' }, l, none) })).toBe(true)
    expect(slidesStep({ tool: 'read', label: 'Read · x.pptx' })).toBe(false)
  })
})

describe('TC-6936: one reason for every spelling of the work folder', () => {
  test('the aliases name the same path', () => {
    expect(workAliasRel('$TRINA_WORK/in/proposal.html')).toBe('in/proposal.html')
    expect(workAliasRel('${TRINA_WORK}/in/proposal.html')).toBe('in/proposal.html')
    expect(workAliasRel('chat:work/in/proposal.html')).toBe('in/proposal.html')
    expect(workAliasRel('$TRINA_WORK')).toBe('')
    expect(workAliasRel('shared/a.txt')).toBeNull()
    expect(() => workAliasRel('$TRINA_WORK/../x')).toThrow()
  })
  test('the people-changed words; nothing a person should not read', () => {
    expect(NO_WORK_WORDS.changed).toContain('people in this chat')
    expect(NO_WORK_WORDS.changed).toContain('new, empty work folder')
    expect(noWorkText(undefined)).toBe(NO_WORK_WORDS.elsewhere)
    for (const w of [...Object.entries(NO_WORK_WORDS).filter(([k]) => k !== 'off').map(([, v]) => v), WORK_WRITE_WORDS]) expect(w).not.toMatch(/dev environment|sub-agent|main assistant|temporary/i)
  })
})

describe('TC-6938: write to the work folder steers to box_shell or copy_files', () => {
  test('every spelling gets the same steer', () => {
    expect(placeWriteRefusal({ kind: 'work', rel: 'report.txt' })).toBe(WORK_WRITE_WORDS)
    expect(WORK_WRITE_WORDS).toContain('box_shell')
    expect(WORK_WRITE_WORDS).toContain('copy_files')
    expect(WORK_WRITE_WORDS).toContain('chat:files/')
    expect(WORK_WRITE_WORDS).toContain('Do not save an extra copy')
  })
})

describe('TC-6939 / TC-6940: the shared read card for a copy names the files and the place', () => {
  test('names (at most three) or how many, and where they go', () => {
    expect(copyCardFiles('copy_files', { paths: ['users/u/QA/proposal.html', 'users/u/QA/images/'], to_folder: 'chat:work/in/' }, 'en')).toEqual({ to: 'work', files: 'proposal.html, images' })
    expect(copyCardFiles('copy_files', { paths: ['a/1.txt', 'a/2.txt', 'a/3.txt', 'a/4.txt'], to_folder: 'chat:work/' }, 'en')).toEqual({ to: 'work', files: '4 files' })
    expect(copyCardFiles('copy_files', { paths: ['a/1.txt', 'a/2.txt', 'a/3.txt', 'a/4.txt'], to_folder: 'chat:work/' }, 'ko')!.files).toBe('파일 4개')
    expect(copyCardFiles('copy_files', { paths: ['users/u/a.pdf'], to_folder: 'chat:files/' }, 'en')).toEqual({ to: 'chat', files: 'a.pdf' })
    expect(copyCardFiles('copy_files', { paths: ['users/u/a.pdf'], to_folder: 'shared/x' }, 'en')).toBeNull()
    expect(copyCardFiles('read', { file_path: 'users/u/a.pdf' }, 'en')).toBeNull()
    // a name never opens a block or a line
    expect(copyCardFiles('copy_files', { paths: ['users/u/<b>\nx.txt'], to_folder: 'chat:work/' }, 'en')!.files).not.toMatch(/[<>\n]/)
  })
  test('the card says the work folder is seen by everyone in the chat', () => {
    const en = tr('sharedCopyWorkConfirm', 'en', { sources: 'your personal folder', files: 'proposal.html, images', n: '2', m: '1' })
    expect(en).toBe("The AI wants to read files in your personal folder and copy them into this chat's work folder: proposal.html, images. Everyone who sees this chat can see that folder, including people who get access later. 1 of the 2 people who see this chat can't open where they are now.")
    for (const l of LOCALES) for (const k of ['sharedCopyWorkConfirm', 'sharedCopyChatConfirm'] as const) {
      const s = tr(k, l, { sources: 'S', files: 'proposal.html', n: '2', m: '1' })
      expect(s).toContain('proposal.html')
      expect(s).not.toMatch(/\{|\}/)
    }
  })
  test('Korean: the particle fits the word, never "을(를)"; the AI chat is 채팅 as on the rest of its screen', () => {
    const ko = tr('sharedReadConfirm', 'ko', { sources: '내 개인 폴더', n: '2', m: '1' })
    expect(ko.startsWith('AI가 내 개인 폴더를 읽으려고 해요.')).toBe(true)
    expect(tr('sharedReadConfirm', 'ko', { sources: '마케팅 팀', n: '2', m: '1' })).toContain('마케팅 팀을 읽으려고')
    expect(ko).not.toContain('(를)')
    expect(ko).toContain('이 채팅을 보는')
    // the chip of a chat file says the same word
    expect(placeName('chat:files/a.pptx', 'ko')).toBe('이 채팅 › a.pptx')
    // a value whose reading cannot be told keeps the written-out form (as the web app does)
    expect(tr('sharedConnectionConfirm', 'ko', { service: 'Xyzq', n: '2' })).toContain('Xyzq을(를)')
  })
})

describe('TC-6941: refusals the AI may pass on are plain', () => {
  test('no "main assistant", <attachments> or users/<your id>/', () => {
    for (const w of [CHAT_FILES_NONE, NO_CHAT_PLACE, PLACE_WORDS.noChat, PLACE_WORDS.personalSave, PLACE_WORDS.projectSave, placeWriteRefusal({ kind: 'chatFiles', id: null, name: 'a.txt' })]) {
      expect(w).not.toMatch(/main assistant|<attachments>|users\/<|sub-agent/)
    }
    expect(CHAT_FILES_NONE.startsWith('This chat has no files of its own.')).toBe(true)
    expect(PLACE_WORDS.personalSave).toContain('My files')
  })
  test('a deck counts slides, a PDF pages', () => {
    expect(() => parsePages('9', 3, 'slide')).toThrow('slide 9 is past the end: this deck has 3 slides')
    expect(() => parsePages('9', 3)).toThrow('page 9 is past the end: this PDF has 3 pages')
    expect(() => parsePages('2', 1, 'slide')).toThrow('this deck has 1 slide')
  })
})

describe('TC-6944: a guest on a team whose AI they may not use', () => {
  test('its own words, no admin to tell', () => {
    expect(CHAT_ERROR_MESSAGES.guest_no_ai.en).toBe("AI isn't available for guests in this team.")
    for (const l of LOCALES) {
      expect(CHAT_ERROR_MESSAGES.guest_no_ai[l]).toBeTruthy()
      expect(CHAT_ERROR_MESSAGES.guest_no_ai[l]).not.toMatch(/admin|관리자/i)
    }
  })
})
