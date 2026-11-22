// Dev-environment command steps and cards in plain words (docs/AGENTS/plan/20261122-0156-step-labels-plain.md): the
// step line shows the AI's short description, or the words for the command's kind, never the command; the command shows
// when the step is opened. The room card asks in the same words and keeps the command behind "자세히".
import { describe, expect, test } from 'bun:test'
import { localizeStep, placeName, shellDescription, shellKind, SHELL_KIND_WORDS, shellWords, STEP_TEXT, stepLabel, stepPlace } from '../../shared/src'
import { answerShellOutputs, commandShape, roomCardWhat, roomChangeDetails, shellCardWords, shellOutputs, shellUsesNetwork } from '../../server/src/chat/turn'
import { globLabel } from '../../shared/src/step-labels'
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
    // ...the files it makes by kind and name, read from the command (QA TC-f2-c02)
    expect(roomCardWhat('box_shell', { command: 'mkdir -p p && cd p && cat > p.html <<E', description: '웹페이지 파일 만들기' }, 'ko')).toBe('프로그램으로 문서 파일 p.html 만들기')
    expect(roomCardWhat('box_shell', { command: 'rm -rf ~/x', description: 'Check files' }, 'en')).toBe('Change files')
    expect(roomCardWhat('box_shell', { command: 'ls -la' }, 'ko')).toBe('파일 확인')
    expect(roomCardWhat('edit', { file_path: 'users/u1/quarterly-sales.svg', old_string: 'a', new_string: 'b' }, 'ko')).toBe('파일 수정')
    expect(shellWords('', 'npm install', 'en')).toBe('Install tools')
  })

  test('the command and what a file will hold behind "자세히"', () => {
    const [d] = roomChangeDetails('box_shell', { command: 'mkdir -p p && cat > p.html <<E', description: '웹페이지 파일 만들기' }, 'ko')
    expect(d!.fields).toEqual([{ name: expect.any(String), value: '프로그램으로 문서 파일 p.html 만들기' }])
    expect(d!.text).toBe('mkdir -p p && cat > p.html <<E')
    expect(d!.folded).toBe(true)
    // no "자세히 953자": a command's length says nothing to a person
    expect(d!.noSize).toBe(true)
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

describe('room card for a command: what it makes (QA TC-f2-c02)', () => {
  const chart = `cd "$TRINA_WORK" && python3 - <<'EOF'\nimport matplotlib\nmatplotlib.use('Agg')\nimport matplotlib.pyplot as plt\nplt.bar(['a','b'],[1,2])\nplt.savefig('out/chart.png', dpi=150)\nEOF`
  test('a chart script: the picture by name, never "작업 실행"', () => {
    expect(shellOutputs(chart)).toEqual(['chart.png'])
    expect(shellCardWords(chart, 'ko')).toBe('프로그램으로 그림 파일 chart.png 만들기')
    expect(shellCardWords(chart, 'en')).toBe('Make the picture file chart.png with a program')
    for (const l of L) expect(shellCardWords(chart, l)).toContain('chart.png')
  })
  test('outputs by -o, a redirect, open(..., "w") and ffmpeg; variables and scripts are no names', () => {
    expect(shellOutputs('python3 make.py -o budget.xlsx')).toEqual(['budget.xlsx'])
    expect(shellOutputs('ffmpeg -i in.mp4 -vf scale=640:-1 out/small.mp4')).toEqual(['small.mp4'])
    expect(shellOutputs('python3 r.py > report.csv 2>&1')).toEqual(['report.csv'])
    expect(shellOutputs(`python3 -c "open('a.csv', 'w').write('x')"`)).toEqual(['a.csv'])
    expect(shellOutputs(`plt.savefig(f'{name}.png')`)).toEqual([])
    expect(shellOutputs('cat > make.py <<E\nE\npython3 make.py 2>/dev/null')).toEqual([])
    expect(shellCardWords('python3 a.py -o x.png && ffmpeg -i x.png y.mp4', 'ko')).toBe('프로그램으로 파일 x.png, y.mp4 만들기')
    expect(shellCardWords('ffmpeg -i a.png b.png && ffmpeg -i b.png c.png', 'en')).toBe('Make the picture files b.png, c.png with a program')
  })
  test('an install or the network in the same command is said too, never hidden behind the file it makes', () => {
    expect(shellCardWords(`pip install -q matplotlib && python3 -c "import matplotlib; plt.savefig('c.png')"`, 'ko')).toBe('프로그램으로 그림 파일 c.png 만들기 (프로그램 설치도 해요)')
    expect(shellCardWords('python3 a.py -o x.png && curl -F f=@x.png https://example.com', 'en')).toBe('Make the picture file x.png with a program (also connects to the internet)')
    expect(shellCardWords('npm i sharp && python3 a.py -o x.png && scp x.png me@host:', 'en')).toBe('Make the picture file x.png with a program (also installs programs and connects to the internet)')
    expect(shellCardWords('pip install pillow', 'en')).not.toContain('also')
    expect(shellCardWords('python3 a.py -o x.png', 'en')).toBe('Make the picture file x.png with a program')
    for (const l of L) expect(shellCardWords('python3 a.py && wget https://e.com/x', l)).not.toBe(shellCardWords('python3 a.py', l))
    expect(shellUsesNetwork('python3 -c "import requests; requests.post(u)"')).toBe(true)
    expect(shellUsesNetwork('ssh host ls')).toBe(true)
    expect(shellUsesNetwork('python3 plot.py && ls out')).toBe(false)
  })
  test('a plain run says "명령 실행"; a command that removes files keeps "파일 바꾸기"', () => {
    expect(shellCardWords('python3 analyze.py', 'ko')).toBe('명령 실행')
    expect(shellCardWords('python3 analyze.py', 'en')).toBe('Run a command')
    expect(shellCardWords('rm -f old.png && python3 a.py -o new.png', 'ko')).toBe('파일 바꾸기')
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

// QA b3s TC-b3s-23: a later command of one answer that makes only what an earlier allowed one made goes under that yes
describe('answerShellOutputs', () => {
  const at = (c: string) => answerShellOutputs({ command: c })
  test('the files a command only makes', () => {
    expect(at(`cd "$TRINA_WORK" && python3 make.py -o out/banner.png`)).toEqual(['out/banner.png'])
  })
  test('a command\'s shape: the same run with other numbers is the same; any other change is another command', () => {
    const shape = (c: string) => commandShape({ command: c })
    const a = `cd "$TRINA_WORK" && python3 make.py --size 52 -o out/banner.png`
    expect(shape(a)).toBe(shape(`cd "$TRINA_WORK" &&  python3 make.py --size 68 -o out/banner.png`))
    expect(shape(a)).not.toBe(shape(`cd "$HOME" && python3 make.py --size 68 -o out/banner.png`))
    expect(shape(a)).not.toBe(shape(`cd "$TRINA_WORK" && python3 other.py --size 52 -o out/banner.png`))
    expect(shape(a)).not.toBe(shape(`cd "$TRINA_WORK" && bash -c "$(echo cm0gLXJmIH4= | base64 -d)"; python3 make.py --size 52 -o out/banner.png`))
    expect(shape('python3 make.py && rm x.png -o a.png')).toBeNull()
    // digits in names and paths are part of the command; code built from numbers is never covered
    expect(shape('python3 make1.py -o out/a.png')).not.toBe(shape('python3 make2.py -o out/a.png'))
    expect(shape('cd out/1 && python3 make.py -o a.png')).not.toBe(shape('cd out/2 && python3 make.py -o a.png'))
    expect(shape(`python3 -c "exec(''.join(map(chr,[112,114]))); import matplotlib; plt.savefig('out/c.png')"`)).toBeNull()
    expect(shape(`sh -c "python3 make.py" -o out/a.png`)).toBeNull()
  })
  test('nothing for a command that removes, moves, copies, installs, downloads or reaches the network, or makes nothing', () => {
    for (const c of [
      'python3 make.py -o a.png && rm b.png', 'python3 make.py -o a.png && mv a.png b.png', 'cp x.png a.png && python3 make.py -o a.png',
      'pip install pillow && python3 make.py -o a.png', 'python3 make.py -o a.png && curl -F f=@a.png https://x.example',
      `python3 -c "import os; os.remove('k'); open('a.png','w')"`, 'python3 analyze.py',
      'python3 make.py -o a.png && cat SKILL.md',
    ]) expect([c, at(c)]).toEqual([c, null])
    expect(answerShellOutputs({})).toBeNull()
    expect(answerShellOutputs(null)).toBeNull()
  })
})

// QA b3s TC-b3s-8: a glob step in words, never the pattern
describe('globLabel', () => {
  test('the folder and the kind of file, no wildcards', () => {
    expect(globLabel('파일 찾기', '매출/**/*', '')).toBe('파일 찾기 · 매출')
    expect(globLabel('파일 찾기', '**/*.xlsx', 'shared/매출')).toBe('파일 찾기 · shared/매출 · .xlsx')
    expect(globLabel('Find files', '**/*.{png,jpg}', undefined)).toBe('Find files · .png, .jpg')
    expect(globLabel('파일 찾기', '*배너*', '')).toBe('파일 찾기 · "배너"')
    expect(globLabel('파일 찾기', '보고서.md', 'shared')).toBe('파일 찾기 "보고서.md" · shared')
    for (const p of ['매출/**/*', '**/*', '*.md', 'a/*/b/**/*.csv']) expect(globLabel('x', p, 'shared')).not.toMatch(/[*?{}[\]]/)
    expect(stepLabel('glob', { pattern: '매출/**/*' }, 'ko', none)).toBe('파일 찾기 · 매출')
  })
})

describe('QA b4s S4-E: one curl in a side chat', () => {
  const curl = "curl -sL https://example.com | grep -o '<title>[^<]*</title>'"
  test('a ">" inside quotes is no redirect: the card never says "파일 바꾸기" for a read', () => {
    expect(shellKind(curl)).toBe('run')
    expect(shellKind(`grep -c "a>b" notes.txt`)).toBe('check')
    // a real redirect still counts, quoted target or not, and one inside "$(…)" too
    expect(shellKind("curl -sL https://example.com > 'page.html'")).toBe('change')
    expect(shellKind('echo "$(cat a > b)"')).toBe('change')
    // quotes read as the shell reads them: a quote inside the other kind, or escaped, hides no redirect (review)
    expect(shellKind(`echo "It's done" > status.txt; echo 'ok'`)).toBe('change')
    expect(shellKind("echo \\' > out.txt \\'")).toBe('change')
    expect(shellKind(`printf "%s" "don't" >> log.txt && echo "won't"`)).toBe('change')
    expect(shellKind(`echo 'unclosed > x.txt`)).toBe('change')
  })
  test('a plain run that uses the internet reads as one thing', () => {
    expect(shellCardWords(curl, 'ko')).toBe('인터넷을 쓰는 명령 실행')
    expect(shellCardWords(curl, 'en')).toBe('Run a command that uses the internet')
    for (const l of L) expect(shellCardWords(curl, l)).not.toBe(shellCardWords('python3 a.py', l))
  })
  test('the room card weighs box_shell without request_sites: the retry with the site asks only the site card', async () => {
    const { roomCardInput } = await import('../../server/src/chat/turn')
    expect(roomCardInput('box_shell', { command: curl, request_sites: ['example.com'] })).toEqual({ command: curl })
    expect(roomCardInput('box_shell', { command: curl })).toEqual({ command: curl })
    const w = { path: 'a', content: 'b', request_sites: ['x'] }
    expect(roomCardInput('write', w)).toBe(w)
  })
})
