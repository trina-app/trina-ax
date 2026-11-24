// The LibreOffice profile of one page render (files/office-view.ts; docs/decisions/20261124-documents-mode.md): made new
// in the render's empty work folder for every file and thrown away with it. One rule on every install:
//
// - Fonts: one replacement table from the fonts people's Office uses to the kit's fonts (Carlito and Caladea have
//   Calibri's and Cambria's widths, Liberation has Arial's, Times' and Courier's; Noto CJK draws Korean, Japanese and
//   Chinese). So a page breaks where it breaks in Office, and an Asian font the server does not have never leaves the
//   text blank. Where the kit's fonts are not system fonts (a Mac), the profile's user/fonts links to them (LibreOffice
//   loads that folder on every platform); the render must be allowed to read kitFontsDir() then.
// - Text with no language of its own (an untagged Korean workbook) is Chinese, Japanese and Korean alike to LibreOffice:
//   its Asian default language decides which Noto CJK face draws it (Hanja and punctuation differ between KR, JP, SC and
//   TC). It follows the team's language; Korean where the team's language is not an Asian one.
// - Macros never run, whatever the file asks (the highest security level and macro execution off).
// - A workbook's formulas are calculated when it is opened, so a page and the stored values show real results.
//
// Nothing here depends on the document: no rule per file, per language or per sample.
import fs from 'node:fs'
import path from 'node:path'

/** the kit's families, by role */
const SANS_KR = 'Noto Sans CJK KR', SERIF_KR = 'Noto Serif CJK KR'
const SANS_JP = 'Noto Sans CJK JP', SERIF_JP = 'Noto Serif CJK JP'
const SANS_SC = 'Noto Sans CJK SC', SERIF_SC = 'Noto Serif CJK SC', SANS_TC = 'Noto Sans CJK TC', SERIF_TC = 'Noto Serif CJK TC'

/** font in the file -> the kit's font that draws it */
export const FONT_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
  ['Calibri', 'Carlito'], ['Calibri Light', 'Carlito'], ['Cambria', 'Caladea'],
  ['Arial', 'Liberation Sans'], ['Helvetica', 'Liberation Sans'], ['Helvetica Neue', 'Liberation Sans'],
  ['Times New Roman', 'Liberation Serif'], ['Times', 'Liberation Serif'], ['Courier New', 'Liberation Mono'],
  ...['Malgun Gothic', '맑은 고딕', 'Apple SD Gothic Neo', 'Gulim', '굴림', 'Dotum', '돋움', 'NanumGothic', '나눔고딕', 'Nanum Gothic', 'Pretendard']
    .map((f) => [f, SANS_KR] as const),
  ...['Batang', '바탕', 'Gungsuh', '궁서', 'NanumMyeongjo', '나눔명조', 'AppleMyungjo'].map((f) => [f, SERIF_KR] as const),
  ...['MS Gothic', 'ＭＳ ゴシック', 'MS PGothic', 'Yu Gothic', '游ゴシック', 'Meiryo', 'メイリオ', 'Hiragino Sans', 'Hiragino Kaku Gothic ProN']
    .map((f) => [f, SANS_JP] as const),
  ...['MS Mincho', 'ＭＳ 明朝', 'Yu Mincho', '游明朝', 'Hiragino Mincho ProN'].map((f) => [f, SERIF_JP] as const),
  ...['Microsoft YaHei', '微软雅黑', 'SimHei', '黑体', 'PingFang SC', 'DengXian', '等线'].map((f) => [f, SANS_SC] as const),
  ...['SimSun', '宋体', 'NSimSun', 'FangSong', '仿宋'].map((f) => [f, SERIF_SC] as const),
  ...['Microsoft JhengHei', '微軟正黑體', 'PingFang TC'].map((f) => [f, SANS_TC] as const),
  ...['PMingLiU', '新細明體', 'MingLiU'].map((f) => [f, SERIF_TC] as const),
]

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const prop = (name: string, value: string | boolean | number) => `<prop oor:name="${name}" oor:op="fuse"><value>${xml(String(value))}</value></prop>`

/** the Asian default language of the render, from the team's language (Locale: ko en id ja es zh) */
export function cjkLocale(team: string | null | undefined): string {
  return team === 'ja' ? 'ja-JP' : team === 'zh' ? 'zh-CN' : 'ko-KR'
}

/** registrymodifications.xcu of the render's profile */
export function profileXcu(cjk: string = cjkLocale(null)): string {
  const items = [
    `<item oor:path="/org.openoffice.Office.Linguistic/General">${prop('DefaultLocale_CJK', cjk)}</item>`,
    `<item oor:path="/org.openoffice.Office.Common/Security/Scripting">${prop('MacroSecurityLevel', 3)}${prop('DisableMacrosExecution', true)}</item>`,
    `<item oor:path="/org.openoffice.Office.Calc/Formula/Load">${prop('OOXMLRecalcMode', 0)}${prop('ODFRecalcMode', 0)}</item>`,
    `<item oor:path="/org.openoffice.Office.Common/Font/Substitution">${prop('Replacement', true)}</item>`,
    ...FONT_REPLACEMENTS.map(([from, to], i) => `<item oor:path="/org.openoffice.Office.Common/Font/Substitution/FontPairs"><node oor:name="_${i}" oor:op="replace">${prop('Always', true)}${prop('OnScreenOnly', false)}${prop('ReplaceFont', from)}${prop('SubstituteFont', to)}</node></item>`),
  ]
  return `<?xml version="1.0" encoding="UTF-8"?>\n<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n${items.join('\n')}\n</oor:items>\n`
}

/** The kit's font files where they are not system fonts (MYCEL_KIT_FONTS_DIR: the office Mac's per-user kit), or null:
 * on Linux and in Docker they are the list's font packages, which LibreOffice finds through fontconfig. */
export function kitFontsDir(env: Record<string, string | undefined> = process.env): string | null {
  const d = env.MYCEL_KIT_FONTS_DIR ?? ''
  try { return path.isAbsolute(d) && fs.statSync(d).isDirectory() ? d : null } catch { return null }
}

const FONT_FILE = /\.(ttf|otf|ttc|otc)$/i

/** Makes the profile folder (`dir`, inside the render's work folder) and returns its file: URL for -env:UserInstallation. */
export function writeOfficeProfile(dir: string, fonts: string | null = kitFontsDir(), cjk: string = cjkLocale(null)): string {
  const user = path.join(dir, 'user')
  fs.mkdirSync(user, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(user, 'registrymodifications.xcu'), profileXcu(cjk), { mode: 0o600 })
  if (fonts) {
    const into = path.join(user, 'fonts')
    fs.mkdirSync(into, { mode: 0o700 })
    for (const f of fs.readdirSync(fonts)) {
      const from = path.join(fonts, f)
      if (FONT_FILE.test(f) && fs.lstatSync(from).isFile()) fs.symlinkSync(from, path.join(into, f))
    }
  }
  return `file://${dir}`
}
