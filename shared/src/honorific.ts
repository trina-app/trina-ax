// Honorifics after a name in a text: "{name}님", "{name} 님에게", "{name}さん". A name that already ends with one
// (Korean 님 or 씨: "대표님", "김민지 씨"; Japanese さん, 様, さま, 殿, 先生, 氏, くん, ちゃん: "田中様") gets no second one,
// with or without the space before it: "{name} 님에게 답장" with 대표님 reads "대표님에게 답장", never "대표님 님에게".
// A name that only has one inside ("김님희") keeps the text's own. English, Spanish and Indonesian texts add none.
// The web app (web/src/i18n format) and the team server's texts with a name (Slack, notices, cards) both use this.

const HONORIFICS = ['님', '씨', 'さん', '様', 'さま', '殿', '先生', '氏', 'くん', 'ちゃん']
/** The Korean particle (으)로: 로 after a vowel and also after ㄹ. */
const RO: [string, string] = ['으로', '로']
/** Korean particles that change with the last sound: after a final consonant, after a vowel. */
const PARTICLES: [string, string][] = [['이', '가'], ['은', '는'], ['을', '를'], ['과', '와'], RO]

const SET = HONORIFICS.join('|')
/** A name that ends with an honorific. */
export const HONORIFIC_END = new RegExp(`(?:${SET})$`)
/** A placeholder, an optional space, the text's own honorific, and a Korean particle right after it (only when a word
 * does not go on after it: "님이 " or "님과", not the 이 of "님이에요"). */
const AFTER = new RegExp(`\\{(\\w+)\\}[ \\u00a0\\u3000]?(?:${SET})(?:(${PARTICLES.flat().join('|')})(?![\\uac00-\\ud7a3]))?`, 'g')

/** True when the name already carries an honorific, so a text's own 님 / さん after it is left out. */
export const hasHonorific = (name: string) => HONORIFIC_END.test(name.trim())

/** The final sound of a Hangul syllable: null for anything else, 0 for none (a vowel), 8 for ㄹ, other numbers for the
 * other final consonants. */
function finalOf(ch: string): number | null {
  const c = ch.codePointAt(0) ?? 0
  return c >= 0xac00 && c <= 0xd7a3 ? (c - 0xac00) % 28 : null
}

/** The particle in the form the name's last sound takes ("김민지 씨" + 이 -> 가); as written when that cannot be told. */
function particleFor(particle: string, name: string): string {
  const last = finalOf([...name].pop() ?? '')
  const pair = PARTICLES.find((p) => p.includes(particle))
  if (last === null || !pair) return particle
  if (pair === RO) return last === 0 || last === 8 ? pair[1] : pair[0]
  return last === 0 ? pair[1] : pair[0]
}

/**
 * The template with its own honorific (and the space before it) left out after each placeholder whose value already
 * ends with one, and a Korean particle right after it put in the form for the name ("{name}님이" with "김민지 씨":
 * "{name}가"). The placeholders stay for the caller to fill as before; a value missing from `params` changes nothing.
 */
export function dropDoubleHonorifics(template: string, params: Record<string, unknown>): string {
  return template.replace(AFTER, (all, k: string, particle?: string) => {
    const v = params[k]
    if (v === undefined || v === null) return all
    const name = String(v).trim()
    if (!hasHonorific(name)) return all
    return `{${k}}${particle ? particleFor(particle, name) : ''}`
  })
}
