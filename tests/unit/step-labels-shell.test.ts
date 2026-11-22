// Dev-environment command steps and cards in plain words (docs/AGENTS/plan/20261122-0156-step-labels-plain.md): the
// step line shows the AI's short description, or the words for the command's kind, never the command; the command shows
// when the step is opened. The room card asks in the same words and keeps the command behind "자세히".
import { describe, expect, test } from 'bun:test'
import { localizeStep, shellDescription, shellKind, SHELL_KIND_WORDS, shellWords, STEP_TEXT, stepLabel } from '../../shared/src'
import { roomCardWhat, roomChangeDetails } from '../../server/src/chat/turn'

const none = new Set<string>()
const L = ['ko', 'en', 'id', 'ja', 'es', 'zh'] as const

describe('shellKind', () => {
  test('commands by what they do', () => {
    expect(shellKind('cd $TRINA_WORK/hf && npm install hyperframes')).toBe('install')
    expect(shellKind('pip install -q pillow && python3 make.py')).toBe('install')
    expect(shellKind('cd $TRINA_WORK/hf/promo && export NODE_NO_WARNINGS=1 HYPERFRAMES_BROWSER_PATH=/x && npx hyperframes render --out ../out')).toBe('make')
    expect(shellKind('ffmpeg -i a.mp4 -vf scale=640:-1 b.mp4')).toBe('make')
    expect(shellKind('sleep 110; find $TRINA_WORK/hf/out -name "frame_*" | wc -l')).toBe('check')
    expect(shellKind('ls -la $TRINA_WORK')).toBe('check')
    expect(shellKind('sleep 30')).toBe('wait')
    expect(shellKind('git clone https://github.com/a/b')).toBe('download')
    expect(shellKind('curl -sLo x.zip https://example.com/x.zip')).toBe('download')
    expect(shellKind('python3 analyze.py')).toBe('run')
    expect(shellKind('')).toBe('run')
  })
})

describe('shellDescription', () => {
  test('plain words pass, commands and work paths do not', () => {
    expect(shellDescription('영상 프레임 만들기')).toBe('영상 프레임 만들기')
    expect(shellDescription('  Install   the video tool ')).toBe('Install the video tool')
    expect(shellDescription('cd $TRINA_WORK && ls')).toBe('')
    expect(shellDescription('npm install hyperframes')).toBe('')
    expect(shellDescription('NODE_NO_WARNINGS=1 render')).toBe('')
    expect(shellDescription('Check $TRINA_WORK/out frames')).toBe('Check frames')
    expect(shellDescription('a · b')).toBe('a b')
    expect(shellDescription(42)).toBe('')
    expect(shellDescription('x'.repeat(100)).length).toBe(60)
  })
})

describe('step line', () => {
  test('saved with the description first, the command after it', () => {
    expect(stepLabel('box_shell', { command: 'npx hyperframes render', description: '영상 프레임 만들기' }, 'ko', none)).toBe('영상 프레임 만들기 · npx hyperframes render')
    expect(stepLabel('box_shell', { command: 'npm install\nnpm test' }, 'en', none)).toBe('Dev environment command · npm install')
    expect(stepLabel('box_shell', { command: 'npm run build', description: 'cd x && make', job: true }, 'en', none)).toBe(`Dev environment command · npm run build (${STEP_TEXT.jobSuffix.en})`)
  })

  test('shown: the words alone, the command when opened', () => {
    const saved = stepLabel('box_shell', { command: 'npx hyperframes render', description: '영상 프레임 만들기' }, 'ko', none)
    expect(localizeStep({ kind: 'tool', tool: 'box_shell', label: saved }, 'en')).toEqual({ label: '영상 프레임 만들기', detail: 'npx hyperframes render' })
  })

  test('an old line ("개발 환경 명령 · <command>"): the kind in the language on screen', () => {
    const old = '개발 환경 명령 · cd $TRINA_WORK/hf/promo && export NODE_NO_WARNINGS=1 HYPERFRAMES_BROWSER_PATH=/x && npx hyperframes render'
    for (const l of L) {
      const r = localizeStep({ kind: 'tool', tool: 'box_shell', label: old }, l)
      expect(r.label).toBe(SHELL_KIND_WORDS.make[l])
      expect(r.label).not.toContain('TRINA_WORK')
      expect(r.detail).toContain('npx hyperframes render')
    }
    expect(localizeStep({ kind: 'tool', tool: 'box_shell', label: 'Dev environment command · sleep 110; find $TRINA_WORK/hf/out -name "frame_*" | wc -l' }, 'ko').label).toBe('파일 확인')
  })

  test('the job / background ending and a cover ending stay, in the language on screen', () => {
    expect(localizeStep({ kind: 'tool', tool: 'box_shell', label: '개발 환경 명령 · npm run build (job)' }, 'ko').label).toBe(`결과물 만들기 (${STEP_TEXT.jobSuffix.ko})`)
    expect(localizeStep({ kind: 'tool', tool: 'box_shell', label: 'Dev environment command · npm run dev (background)' }, 'ja')).toEqual({ label: `${SHELL_KIND_WORDS.run.ja} (${STEP_TEXT.backgroundSuffix.ja})`, detail: 'npm run dev' })
    expect(localizeStep({ kind: 'tool', tool: 'box_shell', label: `Install tools · npm i (job) · ${STEP_TEXT.roomGrantStep.en}` }, 'ko').label).toBe(`Install tools (${STEP_TEXT.jobSuffix.ko}) · ${STEP_TEXT.roomGrantStep.ko}`)
  })

  test('a bare command, a verb alone, and an earlier detail', () => {
    expect(localizeStep({ kind: 'tool', tool: 'box_shell', label: 'npx remotion render' }, 'en')).toEqual({ label: 'Make the result', detail: 'npx remotion render' })
    expect(localizeStep({ kind: 'tool', tool: 'box_shell', label: '개발 환경 명령' }, 'en')).toEqual({ label: 'Run a task' })
    expect(localizeStep({ kind: 'tool', tool: 'box_shell', label: 'Dev environment command · ls', detail: 'card waits' }, 'en')).toEqual({ label: 'Check files', detail: 'ls\n\ncard waits' })
  })
})

describe('room card', () => {
  test('the question in plain words', () => {
    expect(roomCardWhat('box_shell', { command: 'mkdir -p p && cd p && cat > p.html <<E', description: '웹페이지 파일 만들기' }, 'ko')).toBe('웹페이지 파일 만들기')
    expect(roomCardWhat('box_shell', { command: 'ls -la' }, 'ko')).toBe('파일 확인')
    expect(roomCardWhat('edit', { file_path: 'users/u1/quarterly-sales.svg', old_string: 'a', new_string: 'b' }, 'ko')).toBe('파일 수정')
    expect(shellWords('', 'npm install', 'en')).toBe('Install tools')
  })

  test('the command and what a file will hold behind "자세히"', () => {
    const [d] = roomChangeDetails('box_shell', { command: 'mkdir -p p && cat > p.html <<E', description: '웹페이지 파일 만들기' }, 'ko')
    expect(d!.fields).toEqual([{ name: expect.any(String), value: '웹페이지 파일 만들기' }])
    expect(d!.text).toBe('mkdir -p p && cat > p.html <<E')
    expect(d!.folded).toBe(true)
    expect(roomChangeDetails('edit', { file_path: 'users/u1/a.svg', old_string: '<svg>', new_string: '<svg/>' }, 'ko')[0]!.folded).toBe(true)
    // an instruction file shows in full, and a list of paths is no content to fold
    expect(roomChangeDetails('write', { file_path: 'skills/x/SKILL.md', content: 'do this' }, 'ko')[0]!.folded).toBeUndefined()
    expect(roomChangeDetails('move_files', { paths: ['a.md'], to_folder: 'shared/x' }, 'ko')[0]!.folded).toBeUndefined()
  })
})
