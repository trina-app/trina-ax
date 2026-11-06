// Tab 5 "다국어": ko / en / id have the same keys (CI check), the same {placeholders}, no empty texts, no Korean left in
// the English and Indonesian texts, and no screen text in Korean outside the Korean dictionary.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_LOCALE } from '@mycel/shared/api'
import { localizeStep, PRODUCT } from '@mycel/shared'
import { browserLocale, DICTS, format, koRo, LOCALES, pickLocale, placeholdersOf, translate } from '../../src/i18n'
import { ko } from '../../src/i18n/ko'

const placeholders = (s: string) => placeholdersOf(s)

describe('translations', () => {
  test('account deletion describes private archive transfer without a fixed path', () => {
    for (const loc of ['ko', 'en', 'id', 'ja', 'es'] as const) {
      const body = translate(loc, 'members.removeBody', { days: 7 })
      expect(placeholders(DICTS[loc]['members.removeBody'])).toEqual(['days'])
      expect(body).not.toContain('users/')
    }
    expect(translate('en', 'members.removeBody')).toContain('moved to an archive in the owner’s personal folder')
    expect(translate('en', 'members.removeBody')).toContain('Only the owner can read')
  })
  test('chat trash and account deletion guidance show the team chat retention, not a fixed 7 days', () => {
    for (const loc of ['ko', 'en', 'id', 'ja', 'es'] as const) {
      for (const key of ['trash.desc', 'members.removeBody', 'chat.deleteBody'] as const) {
        expect(placeholders(DICTS[loc][key])).toEqual(['days'])
        expect(DICTS[loc][key]).not.toMatch(/\d/)
        expect(translate(loc, key, { days: 3 })).toContain('3')
        expect(translate(loc, key, { days: 3 })).not.toContain('7')
      }
    }
    expect(translate('en', 'trash.desc', { days: 1 })).toContain('for 1 day ')
    expect(translate('en', 'trash.desc', { days: 30 })).toContain('for 30 days ')
    expect(translate('ko', 'members.removeBody', { days: 14 })).toContain('14일 뒤')
    expect(translate('id', 'trash.desc', { days: 14 })).toContain('14 hari')
    expect(translate('en', 'chat.deleteBody', { days: 1 })).toContain('for 1 day ')
    expect(translate('ko', 'chat.deleteBody', { days: 14 })).toContain('14일 동안')
    expect(translate('id', 'chat.deleteBody', { days: 14 })).toContain('selama 14 hari')
  })
  test('file deletion guidance uses the team retention policy and each item’s saved date', () => {
    for (const loc of ['ko', 'en', 'id', 'ja', 'es'] as const) {
      for (const key of ['files.deleteBody', 'files.trashNote'] as const) {
        expect(translate(loc, key)).not.toMatch(/\d/)
        expect(placeholders(translate(loc, key))).toEqual([])
      }
      expect(placeholders(DICTS[loc]['files.purgeAt'])).toEqual(['date'])
    }
    expect(translate('en', 'files.deleteBody')).toContain('retention period set by your team at the time of deletion')
    expect(translate('en', 'files.trashNote')).toContain('Changing the retention period does not change dates for items already in the trash')
  })
  test('Korean engine guidance uses the translated owner role', () => {
    for (const key of ['engines.betaHint', 'engines.choiceDesc'] as const) {
      expect(ko[key]).toContain(ko['role.owner'])
      expect(ko[key]).not.toMatch(/\bowner\b/i)
    }
  })
  test('every language has exactly the Korean keys', () => {
    const keys = Object.keys(ko).sort()
    for (const [loc, d] of Object.entries(DICTS)) expect({ loc, keys: Object.keys(d).sort() }).toEqual({ loc, keys })
  })
  test('placeholders match and no text is empty', () => {
    for (const [loc, d] of Object.entries(DICTS)) {
      for (const [k, v] of Object.entries(d)) {
        expect({ loc, k, empty: !v.trim() }).toEqual({ loc, k, empty: false })
        expect({ loc, k, p: placeholders(v) }).toEqual({ loc, k, p: placeholders(ko[k as keyof typeof ko]) })
      }
    }
  })
  test('no screen text is hard-coded where a key belongs: product name comes from PRODUCT, not "Saram"', () => {
    const src = path.resolve(import.meta.dir, '../../src')
    const files = fs.readdirSync(src, { recursive: true }).map(String).filter((f) => /\.(tsx?|css)$/.test(f))
    for (const f of files) {
      const text = fs.readFileSync(path.join(src, f), 'utf8')
      expect({ f, saram: /\bSaram\b/.test(text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')) }).toEqual({ f, saram: false })
    }
  })
  test('the product name is never written in a text: {product} / {productFile} fill it from PRODUCT', () => {
    for (const [loc, d] of Object.entries(DICTS)) {
      for (const [k, v] of Object.entries(d)) {
        for (const n of [PRODUCT.displayName, PRODUCT.shortName, PRODUCT.artifactBase]) expect({ loc, k, hardCoded: v.includes(n) }).toEqual({ loc, k, hardCoded: false })
      }
    }
    expect(translate('en', 'browser.desktopOnly')).toBe(`The in-app browser is only available in the ${PRODUCT.displayName} desktop app.`)
    expect(translate('ko', 'apps.winHow')).toContain(`${PRODUCT.artifactBase}-Setup-`)
    expect(format('{product}', { product: 'X' })).toBe('X') // a caller's own value wins
  })
  test('every audit action the server writes has words on the audit screen', () => {
    const server = path.resolve(import.meta.dir, '../../../server/src')
    const actions = new Set<string>()
    for (const f of fs.readdirSync(server, { recursive: true }).map(String).filter((x) => x.endsWith('.ts'))) {
      const text = fs.readFileSync(path.join(server, f), 'utf8')
      for (const m of text.matchAll(/action: '([a-z_]+(?:\.[a-z_]+)+|setup)'/g)) actions.add(m[1]!)
    }
    expect(actions.size).toBeGreaterThan(20)
    for (const a of actions) expect({ a, label: `audit.act.${a}` in ko }).toEqual({ a, label: true })
    // file events (migration 001 CHECK list)
    for (const a of ['create', 'update', 'delete', 'conflict', 'rejected', 'upload', 'restore']) expect(`audit.file.${a}` in ko).toBe(true)
  })
  test('format, fallback and locale choice: own choice, else the team default, else English', () => {
    expect(format('{a} and {b}', { a: 1 })).toBe('1 and {b}')
    expect(translate('en', 'chat.queued', { n: 3 })).toBe('Waiting · estimated position 3')
    expect(pickLocale(null, 'ko')).toBe('ko')
    expect(pickLocale('id', 'ko')).toBe('id')
    expect(pickLocale(null, null)).toBe('en')
    expect(DEFAULT_LOCALE).toBe('en')
    // pickers: English first, each language in its own language
    expect(LOCALES).toEqual([{ id: 'en', label: 'English' }, { id: 'ko', label: '한국어' }, { id: 'id', label: 'Bahasa Indonesia' }, { id: 'ja', label: '日本語' }, { id: 'es', label: 'Español' }])
  })
  test('English counts take the singular or the plural form', () => {
    expect(translate('en', 'steps.summary', { n: 1 })).toBe('1 step')
    expect(translate('en', 'steps.summary', { n: 3 })).toBe('3 steps')
    expect(translate('en', 'files.summary.conflicts', { n: 1 })).toBe('1 conflict copy')
    expect(translate('en', 'members.days', { n: 1 })).toBe('1 day')
    expect(translate('en', 'rules.losingLine', { name: 'Lee', paths: 'a/', n: 1 })).toBe('Lee: a/ (1 chat continues without what the AI read there before)')
    expect(translate('ko', 'steps.summary', { n: 1 })).toContain('1')
    expect(placeholdersOf('{n, plural, one {# day} other {# days}} {x}')).toEqual(['n', 'x'])
    // "1 steps" style texts: a count right before an English plural noun must use the plural form
    for (const [k, v] of Object.entries(DICTS.en)) expect({ k, bare: /\{n\} \w+s\b/.test(v) }).toEqual({ k, bare: false })
  })
  // App review 2026-11-01: "1 uses · 1 people" on the Skills page. Any count, not only {n}, and "people" too.
  test('every count before a plural noun has its singular form (English, Spanish)', () => {
    expect(translate('en', 'skills.popularCount', { uses: 1, users: 1 })).toBe('1 use · 1 person')
    expect(translate('en', 'skills.popularCount', { uses: 5, users: 2 })).toBe('5 uses · 2 people')
    expect(translate('es', 'skills.popularCount', { uses: 1, users: 1 })).toBe('1 uso · 1 persona')
    expect(translate('es', 'skills.popularCount', { uses: 4, users: 3 })).toBe('4 usos · 3 personas')
    expect(translate('ja', 'skills.popularCount', { uses: 1, users: 1 })).toBe('1回使用 · 1人')
    expect(translate('ko', 'skills.popularCount', { uses: 1, users: 1 })).toBe('1회 · 1명')
    expect(translate('id', 'skills.popularCount', { uses: 1, users: 1 })).toBe('1 kali · 1 orang')
    expect(translate('en', 'home.frequentCount', { count: 1 })).toBe('1 time')
    expect(translate('es', 'home.frequentCount', { count: 1 })).toBe('1 vez')
    expect(translate('en', 'files.shareBody', { n: 1 })).toBe('1 more person will see this file.')
    expect(translate('es', 'files.shareBody', { n: 1 })).toBe('1 persona más podrá ver este archivo.')
    expect(translate('en', 'files.narrowBody', { n: 1 })).toContain('means 1 other person can no longer see it')
    expect(translate('es', 'files.narrowBody', { n: 2 })).toContain('2 personas dejarán de poder verlo')
    expect(translate('en', 'projects.shareBody', { n: 1 })).toMatch(/^1 more person will see this folder\./)
    expect(translate('en', 'notifications.unread', { count: 1 })).toBe('1 unread notification')
    expect(translate('es', 'notifications.unread', { count: 1 })).toBe('1 notificación sin leer')
    expect(translate('en', 'connected.last', { time: 'today', files: '1', size: '2 KB' })).toBe('Last today · 1 file · 2 KB')
    expect(translate('es', 'picker.selected', { n: '1' })).toBe('Seleccionados: 1')
    expect(translate('en', 'credentials.month', { tokens: '1,204' })).toBe('Tokens this month: 1,204')
    // a bare {count} right before a plural noun: none left (limits that are never 1 and numbers written with
    // separators, which no plural rule reads, are listed)
    const bare = /\{\w+\} (?:more |other |unread )?(?:people|times|uses|files|items|rows|lines|notifications|questions|tokens|members|chats|skills|personas|veces|usos|archivos|elementos|filas|líneas|notificaciones|preguntas|seleccionados|caracteres)(?![\p{L}])/u
    const notCounts = new Set(['preview.sheetRowsCut', 'ask.skillLines', 'composer.answerTooLong', 'memory.hint', 'memory.tooLong'])
    for (const loc of ['en', 'es'] as const) for (const [k, v] of Object.entries(DICTS[loc])) expect({ loc, k, bare: !notCounts.has(k) && bare.test(v) }).toEqual({ loc, k, bare: false })
  })
  test('steps of older answers follow the language on screen', () => {
    expect(localizeStep({ kind: 'tool', tool: 'read', label: 'Read · shared/fruit.md' }, 'ko').label).toBe('파일 읽기 · shared/fruit.md')
    expect(localizeStep({ kind: 'tool', tool: 'remember', label: '기억함: I prefer short answers.' }, 'en').label).toBe('Remembered: I prefer short answers.')
    expect(localizeStep({ kind: 'ask_user', tool: 'ask_user', label: 'Question: Which fruit?', detail: 'Not answered' }, 'ko')).toEqual({ label: '질문: Which fruit?', detail: '답하지 않음' })
    expect(localizeStep({ kind: 'thinking', label: '생각하는 중' }, 'id').label).toBe('Berpikir')
    expect(localizeStep({ kind: 'browser', tool: 'navigate', label: '페이지 열기 · https://a.example' }, 'en').label).toBe('Open page · https://a.example')
    expect(localizeStep({ kind: 'web_search', tool: 'WebSearch', label: 'Cari di web: durian' }, 'en').label).toBe('Web search: durian')
    // a label that is not ours stays as it is
    expect(localizeStep({ kind: 'tool', tool: 'mystery', label: 'Something else' }, 'ko').label).toBe('Something else')
  })
  test('English and Indonesian texts have no Korean left in them', () => {
    for (const loc of ['en', 'id', 'ja', 'es'] as const) {
      for (const [k, v] of Object.entries(DICTS[loc])) expect({ loc, k, korean: HANGUL.test(v) }).toEqual({ loc, k, korean: false })
    }
  })
  test('unlocalized bootstrap pages (index.html and public files) default to English', () => {
    const root = path.resolve(import.meta.dir, '../..')
    for (const f of ['index.html', ...fs.readdirSync(path.join(root, 'public')).filter((x) => /\.(js|html)$/.test(x)).map((x) => `public/${x}`)]) {
      const text = stripComments(fs.readFileSync(path.join(root, f), 'utf8'))
      expect({ f, korean: HANGUL.test(text), lang: /<html lang="(?!en")/.test(text) }).toEqual({ f, korean: false, lang: false })
    }
  })
  test('Korean "(으)로" after a value follows how it is read: v1로, v3으로, 마케팅으로, 서울로; Latin keeps (으)로', () => {
    expect(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'].map(koRo)).toEqual(['으로', '로', '로', '으로', '로', '로', '으로', '로', '로', '로'])
    expect(translate('ko', 'files.restoreTitle', { version: 1 })).toBe('v1로 되돌릴까요?')
    expect(translate('ko', 'files.restored', { version: 3 })).toBe('v3으로 되돌렸어요.')
    expect(translate('ko', 'files.restored', { version: 10 })).toBe('v10으로 되돌렸어요.')
    expect(translate('ko', 'files.moved', { path: 'shared/마케팅' })).toBe('shared/마케팅으로 옮겼어요.')
    expect(translate('ko', 'files.moved', { path: 'shared/서울' })).toBe('shared/서울로 옮겼어요.')
    expect(translate('ko', 'files.moved', { path: 'shared/자료' })).toBe('shared/자료로 옮겼어요.')
    expect(translate('ko', 'files.moved', { path: 'marketing/archive' })).toBe('marketing/archive(으)로 옮겼어요.')
    // other languages have no such marker; a value left unfilled stays as written
    expect(translate('en', 'files.restored', { version: 1 })).toBe('Restored v1.')
    expect(format('{x}(으)로', {}, 'ko')).toBe('{x}(으)로')
  })
  test('a name that already ends with an honorific does not get a second one: 대표님, never 대표님님', () => {
    expect(translate('ko', 'home.greeting', { name: '대표님' })).toBe('대표님, 무엇을 도와드릴까요?')
    expect(translate('ko', 'home.greeting', { name: '김민지 씨' })).toBe('김민지 씨, 무엇을 도와드릴까요?')
    expect(translate('ko', 'home.greeting', { name: 'Mia' })).toBe('Mia님, 무엇을 도와드릴까요?')
    expect(translate('ko', 'home.greeting', { name: '김님희' })).toBe('김님희님, 무엇을 도와드릴까요?')
    expect(translate('ja', 'home.greeting', { name: '田中様' })).toBe('田中様、どのようなお手伝いができますか？')
    expect(translate('ja', 'home.greeting', { name: '山田さん' })).toBe('山田さん、どのようなお手伝いができますか？')
    expect(translate('ja', 'home.greeting', { name: '佐藤先生' })).toBe('佐藤先生、どのようなお手伝いができますか？')
    expect(translate('ja', 'home.greeting', { name: 'Mia' })).toBe('Miaさん、どのようなお手伝いができますか？')
    // a name in the middle of a sentence, and a value that is not filled in stays as written
    expect(translate('ko', 'goal.waitingMany', { name: '팀장님', n: 2, skill: "'광고 문구'는" })).toBe("팀장님 외 2명이 들어왔어요. '광고 문구'는 아직 써 보기 전이에요.")
    expect(format('{name}님', {}, 'ko')).toBe('{name}님')
    // with a space before the honorific ("{name} 님"), as in about 18 Korean and 9 Japanese texts
    expect(translate('ko', 'rooms.replyTo', { name: '대표님' })).toBe('대표님에게 답장')
    expect(translate('ko', 'notifications.event.room.dmNamed', { name: '대표님' })).toBe('대표님이 메시지를 보냈어요.')
    expect(translate('ko', 'rooms.replyTo', { name: '김님희' })).toBe('김님희 님에게 답장')
    expect(translate('ko', 'notifications.event.room.dmNamed', { name: '김님희' })).toBe('김님희 님이 메시지를 보냈어요.')
    expect(translate('ko', 'rooms.replyTo', { name: '이민준' })).toBe('이민준 님에게 답장')
    // the particle after it follows the name's last sound: 씨 ends in a vowel
    expect(translate('ko', 'notifications.event.room.dmNamed', { name: '김민지 씨' })).toBe('김민지 씨가 메시지를 보냈어요.')
    expect(translate('ko', 'demo.start', { name: '김민지 씨' })).toBe('김민지 씨로 시작하기')
    expect(translate('ko', 'demo.start', { name: '대표님' })).toBe('대표님으로 시작하기')
    expect(translate('ja', 'accessView.who.person', { name: '田中様' })).toBe('田中様')
    expect(translate('ja', 'accessView.membersLinkFor', { name: '山田さん' })).toBe('山田さんが見られるフォルダー')
    expect(translate('ja', 'accessView.membersLinkFor', { name: '山田' })).toBe('山田 さんが見られるフォルダー')
    // English, Spanish and Indonesian add no honorific of their own: the name stays as it is
    expect(translate('en', 'home.greeting', { name: '대표님' })).toBe('How can I help you, 대표님?')
    expect(translate('id', 'home.greeting', { name: 'Bapak Budi' })).toBe('Halo Bapak Budi, ada yang bisa aku bantu?')
    expect(translate('es', 'home.greeting', { name: 'Sra. García' })).toBe('¿En qué puedo ayudarle, Sra. García?')
  })
  test('no Korean screen text outside the Korean dictionary (comments aside)', () => {
    const src = path.resolve(import.meta.dir, '../../src')
    // the one place that must recognise a Korean file name: conflict copies made by a Korean team ("충돌 사본")
    // and the Korean object and topic particles after a skill's name (을 / 를, 은 / 는: grammar, not text;
    // lib/teamGoal.ts objectParticle, topicParticle), and "(으)로" / "(을)를" after a filled-in value (i18n/index.ts koRo,
    // koEul); the honorifics a name may already end with are in shared/src/honorific.ts
    const allowed: Record<string, RegExp> = {
      'lib/paths.ts': /충돌 사본\|conflict copy\|salinan konflik/,
      'lib/teamGoal.ts': /^[^\uAC00-\uD7A3]*(?:[을를은는][^\uAC00-\uD7A3]*)+$/,
      'i18n/index.ts': /^[^\uAC00-\uD7A3]*(?:[으로을를][^\uAC00-\uD7A3]*)+$/,
    }
    const files = fs.readdirSync(src, { recursive: true }).map(String).filter((f) => /\.tsx?$/.test(f) && f !== path.join('i18n', 'ko.ts'))
    for (const f of files) {
      const lines = stripComments(fs.readFileSync(path.join(src, f), 'utf8')).split('\n')
      // (a regex literal can throw the comment stripper off: lines that look like comment lines are skipped too)
      const bad = lines.filter((l) => HANGUL.test(l) && !/^\s*(\*|\/\/|\/\*)/.test(l) && !(allowed[f]?.test(l)))
      expect({ f, bad }).toEqual({ f, bad: [] })
    }
  })
})

const HANGUL = /[\u3131-\u318E\uAC00-\uD7A3]/

/** Source without // and /* *\/ comments (strings kept; a "//" inside a string ends nothing here: good enough). */
function stripComments(text: string): string {
  let out = ''
  let mode: 'code' | "'" | '"' | '`' | 'line' | 'block' = 'code'
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    const n = text[i + 1]
    if (mode === 'line') {
      if (c === '\n') { mode = 'code'; out += c }
      continue
    }
    if (mode === 'block') {
      if (c === '*' && n === '/') { mode = 'code'; i++ } else if (c === '\n') out += c
      continue
    }
    if (mode === 'code') {
      if (c === '/' && n === '/') { mode = 'line'; i++; continue }
      if (c === '/' && n === '*') { mode = 'block'; i++; continue }
      if (c === "'" || c === '"' || c === '`') mode = c
      out += c
      continue
    }
    if (c === '\\') { out += c + (n ?? ''); i++; continue }
    if (c === mode || (c === '\n' && mode !== '`')) mode = 'code'
    out += c
  }
  return out
}

describe('browserLocale (first-run setup starts in the browser language)', () => {
  test('the first of the browser languages we have', () => {
    expect(browserLocale(['ko-KR', 'en-US'])).toBe('ko')
    expect(browserLocale(['ja-JP', 'en-US'])).toBe('ja')
    expect(browserLocale(['es-MX', 'en-US'])).toBe('es')
    expect(browserLocale(['es-ES'])).toBe('es')
    expect(browserLocale(['fr-FR', 'ja'])).toBe('ja')
    expect(browserLocale(['fr-FR', 'id-ID', 'en'])).toBe('id')
    expect(browserLocale(['fr-FR'])).toBeNull()
    expect(browserLocale(undefined)).toBeNull()
  })
})
