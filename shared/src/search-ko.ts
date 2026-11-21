// The other forms of a Korean verb or adjective a search word may stand for (docs/decisions/20261121-ko-search-forms.md).
// Every search matches a word as a part of the text, and a Korean verb changes its last syllable when it is conjugated
// (만들 → 만든 / 만듭니다, 보내 → 보냈어요, 하 → 해 / 했), so no one part of the word is in every form. This reads the
// word the other way round: its stem (the word without a verb ending), then each way that stem's last syllable is
// written, and gives them as a list of parts any of which counts as the word. No dictionary: a few rules of Korean
// conjugation on Hangul syllables (U+AC00…U+D7A3: initial × 588 + vowel × 28 + final).
//
// What counts as a verb, so nouns do not grow matches they never had:
//   - a noun + 하다/되다/드리다/시키다 in any form ("작성했습니다", "확인해주세요", "공유된") is that noun ("작성");
//   - a word with a verb ending (TAILS: "었어요", "습니다", "세요", "는데", a plain "다" or "요" …) is its stem, as a
//     part of the text ("만들었어요" → "만들"), with its other forms;
//   - a word that may be a verb's form or a noun ("만든", "보낸", "만드는", "괜찮은"; "사진", "시간" alike) adds only whole
//     forms of the stem (the stem with an ending after it: "만들었", "만들어", "보냈", "보내고"), never the stem alone,
//     so "시간" never finds "시가" and "이미지" never "이미";
//   - a stem of one syllable ("봤어요", "갔다") is too short to search by a part: the word stays as typed.

const S0 = 0xac00
interface Syl { cho: number; jung: number; jong: number }
const isSyl = (c: string | undefined): c is string => !!c && c >= '가' && c <= '힣'
const part = (c: string): Syl => { const n = c.codePointAt(0)! - S0; return { cho: Math.floor(n / 588), jung: Math.floor((n % 588) / 28), jong: n % 28 } }
const make = (s: Syl): string => String.fromCodePoint(S0 + s.cho * 588 + s.jung * 28 + s.jong)
const withJong = (c: string, jong: number) => make({ ...part(c), jong })
const withJung = (c: string, jung: number) => make({ ...part(c), jung })

// finals (받침)
const N = 4, L = 8, LM = 10, D = 7, M = 16, B = 17, S = 19, SS = 20, H = 27
// vowels
const A = 0, AE = 1, EO = 4, YEO = 6, O = 8, WA = 9, WAE = 10, OE = 11, U = 13, WO = 14, EU = 18, I = 20
// initials
const CHO_R = 5, CHO_NG = 11, CHO_H = 18

/** The verb endings a word is read without (as written after a stem), each with what may stand before it. A plain "다"
 * and "요" count when two syllables stay ("만들다", "아파요"; "바다" stays a noun). */
const TAILS = [
  '습니다', '었습니다', '았습니다', '였습니다', '겠습니다', '셨습니다', '으셨습니다', '니다', '입니다', '이었습니다',
  '었어요', '았어요', '였어요', '겠어요', '셨어요', '으셨어요', '어요', '아요', '여요', '에요', '예요', '이에요', '이었어요',
  '세요', '으세요', '셔요', '주세요', '줘요', '주셨어요', '주셔서', '주시면', '줄게요', '드릴게요', '드립니다', '드려요', '드렸어요', '드렸습니다', '드리겠습니다',
  '네요', '었네요', '았네요', '군요', '는군요', '죠', '지요', '었죠', '았죠', '겠죠', '나요', '었나요', '았나요', '는데요', '은데요', '데요',
  '었는데요', '았는데요', '거든요', '잖아요', '을게요', '게요', '을까요', '까요', '고요', '래요', '대요',
  '었다', '았다', '였다', '는다', '이다', '이었다', '겠다', '다', '었고', '았고', '였고', '었는데', '았는데', '는데', '은데', '었지만', '았지만', '지만',
  '어서', '아서', '여서', '으면', '으면서', '면서', '으니까', '니까', '려고', '으려고', '려면', '으려면', '도록', '어야', '아야', '어도', '아도',
  '는지', '은지', '을지', '었던', '았던', '기로', '다가', '었어', '았어', '였어', '이야', '요',
].sort((a, b) => b.length - a.length)
/** after a noun + 하다/되다 (작성하고, 확인해야, 정리하면): one syllable endings too */
const HA_TAILS = new Set([...TAILS, '', '고', '지', '게', '기', '면', '서', '는', '니', '네', '자', '여', '야', '며', '라', '려', '러'])
/** 하다 / 되다 written as one syllable (하, 해, 했, 한, 할, 함, 합; 되 …), and 시키다 / 드리다 as two */
const HA1 = new Set([...'하해했한할함합되돼됐된될됨됩'])
const HA2 = ['시키', '시켜', '시켰', '시킨', '시킬', '시킵', '드리', '드려', '드렸', '드린', '드릴', '드립']
/** after a stem whose own part is not searched (only whole forms): the first syllable of an ending, after a stem that
 * ends in a vowel (보내고, 보내서, 보내드릴게요; 보내어 is written 보내: the forms of its last syllable) or a final
 * (괜찮아, 괜찮았, 괜찮으면, 괜찮습니다) */
const FOLLOW_V = [...'고지게기다면서시세셨니네죠겠던자려러야드주']
const FOLLOW_C = [...'어아었았고지게기다면으습겠던자네죠']
/** a final of an ending, by the ending after it: 만듭니다 (ㅂ), 보낸다 / 보낸대요 (ㄴ), 보낼게요 / 할까요 (ㄹ) */
const FUSED: Record<string, number> = { '니다': B, '다': N, '데요': N, '대요': N, '게요': L, '까요': L }
/** endings that may also be a particle or the end of a noun: only whole forms of what stands before them */
const WEAK_TAILS = ['는', '은', '을', '던']

/** endings that follow a noun (이다): what stands before them is that noun */
const COPULA = new Set(['예요', '이에요', '에요', '이다', '입니다', '이었어요', '이었습니다', '이었다', '이야'])

const sylsOf = (s: string) => [...s]
/** the stem a word is ranked and shown by: the shortest, one without an ending's final before one with it (보냈 → 보내,
 * 만듭 → 만드) */
const rank = (s: string) => sylsOf(s).length * 2 + ([N, B, M, SS].includes(part(sylsOf(s).at(-1)!).jong) ? 1 : 0)

/** the vowel of a stem's last syllable written together with 어/아 (보 → 봐, 주 → 줘, 시 → 셔, 쓰 → 써, 하 → 해) */
function contracted(c: string): string[] {
  const p = part(c)
  if (p.jong) return []
  if (p.cho === CHO_H && p.jung === A) return [withJung(c, AE)]
  const to: Record<number, number[]> = { [O]: [WA], [U]: [WO], [I]: [YEO], [OE]: [WAE], [EU]: [EO, A] }
  return (to[p.jung] ?? []).map((v) => withJung(c, v))
}
/** the other way: what stem's last syllable a contracted one may be (봐 → 보, 셔 → 시, 해 → 하, 써 → 쓰, 아파 → 아프) */
function uncontracted(c: string): string[] {
  const p = part(c)
  if (p.jong) return []
  if (p.cho === CHO_H && p.jung === AE) return [withJung(c, A)]
  const to: Record<number, number[]> = { [WA]: [O], [WO]: [U], [YEO]: [I], [WAE]: [OE], [EO]: [EU], [A]: [EU] }
  return (to[p.jung] ?? []).map((v) => withJung(c, v))
}

/** a stem; `bare`: the stem alone is a part to search; `noun`: only itself (before 이다) */
interface Stem { s: string; bare: boolean; noun?: boolean }

/** The stems `r` (a word without its ending) may be written from: itself, and its last syllable read back (a final
 * ㅆ, ㄴ, ㄹ, ㅂ, ㅁ of an ending taken off; a contraction undone; the ㅂ, 르 and ㄹ irregulars). `bare`: whether the stem
 * alone is a part to search (the ending made it a verb) or only its whole forms. */
function stemsOf(r: string, bare: boolean, tail: string | null): Stem[] {
  const out: Stem[] = [{ s: r, bare }]
  const syl = sylsOf(r)
  const last = syl.at(-1)!
  const pre = syl.slice(0, -1).join('')
  const p = part(last)
  const vowelStem = (pre: string, c: string, b: boolean) => {
    for (const u of uncontracted(c)) out.push({ s: pre + u, bare: b })
    const q = part(c)
    const prev = sylsOf(pre).at(-1)
    // ㅂ irregular: 어려워 → 어렵, 고마워 → 고맙, 도와 → 돕
    if (q.cho === CHO_NG && (q.jung === WO || q.jung === WA) && isSyl(prev) && !part(prev).jong) out.push({ s: pre.slice(0, -1) + withJong(prev, B), bare: b })
    // 르 irregular: 몰라 → 모르, 불러 → 부르
    if (q.cho === CHO_R && (q.jung === A || q.jung === EO) && isSyl(prev) && part(prev).jong === L) out.push({ s: pre.slice(0, -1) + withJong(prev, 0) + '르', bare: b })
  }
  if (p.jong === SS) {
    // a past tense (보냈 → 보내, 마셨 → 마셔 → 마시, 어려웠 → 어려워 → 어렵): a verb for certain
    const o = withJong(last, 0)
    out.push({ s: pre + o, bare: true })
    vowelStem(pre, o, true)
  } else if (!p.jong) vowelStem(pre, last, false)
  else if (tail === null ? p.jong === N : FUSED[tail] === p.jong) {
    // a final of an ending (보낸, 만듭니다, 보낼게요): the stem without it, or with ㄹ (만든 → 만들), or 우 → ㅂ (어려운 →
    // 어렵). Typed alone ("만든": tail null) it may be a noun's own final ("사진"): only whole forms then.
    const sure = tail !== null
    const o = withJong(last, 0)
    out.push({ s: pre + o, bare: sure })
    if (p.jong !== L) out.push({ s: pre + withJong(last, L), bare: sure })
    const prev = sylsOf(pre).at(-1)
    if (part(o).cho === CHO_NG && part(o).jung === U && isSyl(prev) && !part(prev).jong) out.push({ s: pre.slice(0, -1) + withJong(prev, B), bare: false })
  }
  // 어/아/여 between a stem and a helping verb (만들어주세요 → 만들어 → 만들)
  const q = part(last)
  if (syl.length >= 3 && q.cho === CHO_NG && !q.jong && (q.jung === EO || q.jung === A || q.jung === YEO)) out.push({ s: pre, bare })
  return out
}

/** The parts of the text a stem is found by: itself (`bare`) or itself with an ending after it, and the ways its last
 * syllable is written in the other forms */
function formsOf({ s, bare, noun }: Stem): string[] {
  const syl = sylsOf(s)
  if (syl.length < 2 || !syl.every(isSyl)) return []
  if (noun) return [s]
  const last = syl.at(-1)!
  const pre = syl.slice(0, -1).join('')
  const p = part(last)
  const out = bare ? [s] : (p.jong ? FOLLOW_C : FOLLOW_V).map((f) => s + f)
  if (!p.jong) {
    // 보내 → 보낸, 보낼, 보냅, 보냄, 보냈; 보 → 봐, 봤
    for (const j of [N, L, B, M, SS]) out.push(pre + withJong(last, j))
    for (const c of contracted(last)) out.push(pre + c, pre + withJong(c, SS))
    // 르: 모르 → 몰라, 몰랐; 부르 → 불러, 불렀
    const prev = sylsOf(pre).at(-1)
    if (p.cho === CHO_R && p.jung === EU && isSyl(prev) && !part(prev).jong) for (const x of ['라', '러', '랐', '렀']) out.push(pre.slice(0, -1) + withJong(prev, L) + x)
  } else {
    const o = withJong(last, 0)
    // ㄹ drops before ㄴ, ㅂ, 시, 세, 니 (만들 → 만든, 만듭니다, 만듦, 만드는, 만드세요)
    if (p.jong === L) { for (const j of [N, B, LM]) out.push(pre + withJong(last, j)); for (const x of ['는', '세', '시', '니', '네', '셨']) out.push(pre + o + x) }
    // ㄷ → ㄹ before a vowel (알아듣 → 알아들어)
    if (p.jong === D) for (const x of ['어', '었', '아', '았', '으']) out.push(pre + withJong(last, L) + x)
    // ㅂ → 우/오 (어렵 → 어려워, 어려운; 돕 → 도와)
    if (p.jong === B) for (const x of ['워', '웠', '운', '울', '와', '왔']) out.push(pre + o + x)
    // ㅅ drops before a vowel (나아, 지은)
    if (p.jong === S) for (const x of ['아', '어', '았', '었', '은', '을']) out.push(pre + o + x)
    // ㅎ (그렇 → 그런, 그럴, 그래, 그랬)
    if (p.jong === H) { const e = withJung(o, AE); out.push(pre + withJong(last, N), pre + withJong(last, L), pre + e, pre + withJong(e, SS)) }
  }
  return out
}

/** A Korean word's verb or adjective reading: `stem`, the part the word is ranked and shown by (a noun before 하다, a
 * stem; none when the word does not read as a verb), and `forms`, the parts of the text any of which counts as it (may
 * be empty). Only for a word of Hangul syllables; anything else: none. */
export function koVerbForms(word: string): { stem: string | null; forms: string[] } {
  const syl = sylsOf(word)
  if (syl.length < 2 || !syl.every(isSyl)) return { stem: null, forms: [] }
  // a noun + 하다 / 되다 / 드리다 / 시키다: the noun (two syllables or more)
  for (let i = 2; i < syl.length; i++) {
    const one = HA1.has(syl[i]!) && HA_TAILS.has(syl.slice(i + 1).join(''))
    const two = HA2.includes(syl.slice(i, i + 2).join('')) && HA_TAILS.has(syl.slice(i + 2).join(''))
    if (one || two) { const n = syl.slice(0, i).join(''); return { stem: n, forms: [n] } }
  }
  const stems: Stem[] = []
  let stem: string | null = null
  let ended = false
  for (const t of TAILS) {
    if (!word.endsWith(t)) continue
    const r = word.slice(0, -t.length)
    const n = sylsOf(r).length
    if (n < 1 || ((t === '다' || t === '요') && n < 2)) continue
    // "봤어요" is 봤 + 어요, never 봤어 + 요 (a stem that ends in 어 is read by 어요 itself)
    if (t === '요' && /[어아여]$/.test(r)) continue
    ended = true
    // after a noun (회의예요, 보고서입니다, 사과였어요 is a verb's too): the noun as it is
    const got: Stem[] = COPULA.has(t) ? [{ s: r, bare: true, noun: true }] : stemsOf(r, true, t)
    stems.push(...got)
    for (const x of got) if (x.bare && sylsOf(x.s).length >= 2 && (stem === null || rank(x.s) < rank(stem))) stem = x.s
  }
  if (!ended) {
    const p = part(syl.at(-1)!)
    // a past tense with no ending after it ("만들었", "보냈")
    if (p.jong === SS) stems.push(...stemsOf(word, true, null))
    // a form that may be a noun as well ("만든", "보낸"): whole forms of the stem only
    else if (p.jong === N) stems.push(...stemsOf(word, false, null).slice(1))
    for (const t of WEAK_TAILS) {
      if (!word.endsWith(t) || syl.length - 1 < 2) continue
      const r = word.slice(0, -1)
      stems.push({ s: r, bare: false })
      // 만드는 → 만들 (ㄹ drops before ㄴ)
      const last = sylsOf(r).at(-1)!
      if (t === '는' && !part(last).jong) stems.push({ s: r.slice(0, -1) + withJong(last, L), bare: false })
    }
  }
  return { stem, forms: stems.flatMap(formsOf) }
}
