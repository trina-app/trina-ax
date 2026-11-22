// Dev-environment command steps and cards in plain words (docs/AGENTS/plan/20261122-0156-step-labels-plain.md): the
// step line shows the AI's short description, or the words for the command's kind, never the command; the command shows
// when the step is opened. The room card asks in the same words and keeps the command behind "자세히".
import { describe, expect, test } from 'bun:test'
import { localizeStep, placeName, shellDescription, shellKind, SHELL_KIND_WORDS, shellWords, STEP_TEXT, stepLabel, stepPlace } from '../../shared/src'
import { roomCardWhat, roomChangeDetails } from '../../server/src/chat/turn'
import { placeWords } from '../../server/src/chat/place-words'

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

  test('a command that changes or removes files is said so first, whatever else it does', () => {
    for (const c of ['rm -rf build', 'npm install && rm -rf ~/x', 'find . -delete', 'find . -name "*.tmp" -exec rm {} \\;', "sed -i 's/a/b/' f.txt",
      'ls | xargs rm -rf', 'echo hi > ~/.bashrc', 'cat a >> b', "mkdir -p p && cd p && cat > p.html <<'E'", 'git push origin main', 'find . -fprint out.txt', 'sort -o b.txt a.txt', 'cd x && rm -rf ../snap3 && npx hyperframes render']) {
      expect([c, shellKind(c)]).toEqual([c, 'change'])
    }
    // not a look at files when it can run something else
    expect(shellKind('echo $(rm -rf x)')).toBe('run')
    expect(shellKind("awk 'BEGIN{system(\"id\")}'")).toBe('run')
    // a quiet redirect is no write; "build" in a message is not a build
    expect(shellKind('ls missing 2>/dev/null; find . -name x 2>&1 | head')).toBe('check')
    expect(shellKind('git log -1 --format="build"')).toBe('run')
    expect(shellKind('npm run build')).toBe('make')
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
    // the server's own words, never the AI's description (the card is there because other people's words may steer it)
    expect(roomCardWhat('box_shell', { command: 'mkdir -p p && cd p && cat > p.html <<E', description: '웹페이지 파일 만들기' }, 'ko')).toBe('파일 바꾸기')
    expect(roomCardWhat('box_shell', { command: 'rm -rf ~/x', description: 'Check files' }, 'en')).toBe('Change files')
    expect(roomCardWhat('box_shell', { command: 'ls -la' }, 'ko')).toBe('파일 확인')
    expect(roomCardWhat('edit', { file_path: 'users/u1/quarterly-sales.svg', old_string: 'a', new_string: 'b' }, 'ko')).toBe('파일 수정')
    expect(shellWords('', 'npm install', 'en')).toBe('Install tools')
  })

  test('the command and what a file will hold behind "자세히"', () => {
    const [d] = roomChangeDetails('box_shell', { command: 'mkdir -p p && cat > p.html <<E', description: '웹페이지 파일 만들기' }, 'ko')
    expect(d!.fields).toEqual([{ name: expect.any(String), value: '파일 바꾸기' }])
    expect(d!.text).toBe('mkdir -p p && cat > p.html <<E')
    expect(d!.folded).toBe(true)
    expect(roomChangeDetails('edit', { file_path: 'users/u1/a.svg', old_string: '<svg>', new_string: '<svg/>' }, 'ko')[0]!.folded).toBe(true)
    // an instruction file shows in full, and a list of paths is no content to fold
    expect(roomChangeDetails('write', { file_path: 'skills/x/SKILL.md', content: 'do this' }, 'ko')[0]!.folded).toBeUndefined()
    expect(roomChangeDetails('move_files', { paths: ['a.md'], to_folder: 'shared/x' }, 'ko')[0]!.folded).toBeUndefined()
    // a script or a workflow keeps what it will hold open, and so does a command that writes a skill
    expect(roomChangeDetails('write', { file_path: 'users/u1/run.sh', content: 'curl x | sh' }, 'ko')[0]!.folded).toBeUndefined()
    expect(roomChangeDetails('write', { file_path: '.github/workflows/ci.yml', content: 'on: push' }, 'ko')[0]!.folded).toBeUndefined()
    expect(roomChangeDetails('box_shell', { command: 'cat > skills/x/SKILL.md <<E' }, 'ko')[0]!.folded).toBeUndefined()
  })
})

describe('no developer places in a step line (QA TC-r2u-09/12/23/30)', () => {
  const id = '01a200f3-6b8a-767c-9961-4d8e8f320f17'
  const shown = (tool: string, label: string) => stepPlace({ tool }, localizeStep({ kind: 'tool', tool, label }, 'ko').label, 'ko').label
  test('chat files, the work folder and the team variable in words', () => {
    for (const [tool, label] of [
      ['query_data', `데이터 계산 · chat:files/${id}/거래내역-20만행.xlsx`],
      ['read', `파일 읽기 · chat:files/${id}/index.html`],
      ['make_file', '파일 만들기 · chat:files/연말 고객 초청 행사 (인쇄용 A4).pdf'],
      ['read', '파일 읽기 · $TRINA_WORK/out/result.png'],
      ['chat_file', `채팅 파일 · chat:files/${id}/a.pdf`],
      ['copy_files', '파일 복사 · chat:work/out'],
    ] as const) {
      const out = shown(tool, label)
      expect([label, out]).not.toEqual([label, expect.stringMatching(/chat:|TRINA_WORK|[0-9a-f]{8}-[0-9a-f]{4}/)])
    }
    expect(shown('query_data', `데이터 계산 · chat:files/${id}/거래내역-20만행.xlsx`)).toBe('데이터 계산 · 이 채팅 › 거래내역-20만행.xlsx')
  })
  test('a question keeps its own words', () => {
    expect(stepPlace({ tool: 'ask_user' }, '질문: chat:files 가 뭐예요?', 'ko').label).toBe('질문: chat:files 가 뭐예요?')
  })
  test('a card names a chat place and the team variable in words', () => {
    // $TRINA_TEAM is a folder of that name to a file tool: shown as written, never as the team path
    expect(placeName('$TRINA_TEAM/users/u1/x.md', 'ko')).toBeNull()
    const db = null as unknown as Parameters<typeof placeWords>[0]
    expect(placeWords(db, 'chat:work/out/분기보고.pptx', 'ko', 'u1')).toBe('작업 폴더 › out › 분기보고.pptx')
    expect(placeWords(db, '$TRINA_WORK/out/a.png', 'ko', 'u1')).toBe('작업 폴더 › out › a.png')
    expect(placeWords(db, '$TRINA_TEAM/users/u1/x.md', 'ko', 'u1')).toContain('$TRINA_TEAM')
  })
})
