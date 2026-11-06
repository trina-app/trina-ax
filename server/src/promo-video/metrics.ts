// Text widths for the promo video templates (docs/DECISIONS.md "V"), measured once in Chromium from the bundled
// Pretendard Variable 1.3.9 (resources/promo-video/fonts/) with canvas measureText at 1000 px, per weight; weight 400
// for the intro deck's body text (docs/DECISIONS.md "D2") read from the advance widths of the bundled static
// Pretendard-Regular.ttf 1.3.9 (resources/fonts/pretendard/; the same reading of the static Bold gives the 700 row
// below within 1/1000 em). The server
// checks that every line the AI wrote fits its box and picks the headline size from these, so a frame never depends on
// a browser measuring at render time. Kerning is left out (it only narrows a line), so a measured line is never
// shorter than the drawn one. Every Hangul syllable is 864/1000 em wide at every weight.

export type Weight = 400 | 500 | 600 | 700 | 800 | 900
/** advance widths of ASCII 32–126 in 1/1000 em */
const ASCII: Record<Weight, number[]> = {
  400: [251,257,379,600,607,862,609,201,341,341,471,627,258,433,254,334,596,438,587,617,624,597,613,552,606,613,254,254,627,627,627,479,880,646,619,693,686,567,557,709,706,244,516,621,533,853,718,727,604,727,608,607,611,707,646,915,612,634,595,341,334,341,442,425,469,535,591,529,591,553,337,579,563,218,218,517,218,834,557,567,579,579,350,496,340,553,529,777,513,529,513,341,306,341,627],
  500: [244,273,378,608,615,895,622,200,357,357,493,636,268,438,263,347,617,449,595,625,635,607,623,560,619,623,263,263,636,636,636,499,878,669,625,704,691,574,559,717,710,251,526,635,538,863,715,735,611,735,616,615,622,706,669,943,637,654,610,357,347,357,451,435,472,542,598,541,598,560,347,589,575,231,231,530,231,849,570,575,589,589,363,510,350,567,541,791,525,541,525,357,322,357,636],
  600: [238,291,377,616,623,927,635,199,374,374,516,645,277,443,272,359,639,459,603,632,646,617,633,567,631,633,272,272,645,645,645,519,876,694,630,714,696,582,561,725,715,259,537,649,542,873,712,744,617,745,624,623,632,705,694,971,661,675,625,374,359,374,459,445,474,550,604,552,604,567,357,599,587,244,244,544,244,864,584,583,598,598,376,525,360,582,552,805,538,552,537,374,339,374,645],
  700: [231,307,376,625,630,959,648,197,390,390,539,653,287,449,282,372,660,469,611,639,657,627,643,576,643,643,282,282,653,653,653,538,875,718,636,724,701,588,563,733,719,266,548,663,546,883,709,753,623,753,632,630,643,704,718,999,686,696,641,390,372,390,467,456,477,557,611,563,611,574,367,608,600,257,257,558,257,879,598,590,608,608,390,539,370,597,563,819,551,563,549,390,355,390,653],
  800: [225,324,375,633,638,992,661,196,406,406,562,662,297,454,292,384,682,479,619,646,668,637,653,583,655,653,292,292,662,662,662,558,873,742,642,734,706,595,565,741,724,273,559,676,550,893,707,762,629,763,639,638,653,703,742,1027,710,716,656,406,384,406,476,466,480,564,618,575,618,582,377,618,613,270,270,572,270,895,611,598,617,617,403,554,380,612,574,833,563,574,561,406,372,406,662],
  900: [218,341,375,641,645,1024,674,195,423,423,584,671,307,459,301,396,704,489,626,654,679,647,663,591,667,663,301,301,671,671,671,577,871,766,647,744,711,603,567,749,728,281,569,690,554,903,704,771,636,771,647,645,664,702,766,1055,735,737,671,423,396,423,484,477,482,572,625,586,625,589,388,628,625,283,283,586,283,910,625,605,627,627,417,568,391,626,585,847,576,585,573,423,389,423,671],
}
const EXTRA_CHARS = "·‘’“”…—–×%℃㎡㎏「」『』《》〈〉、。！？～∙•→←①②③ㄱㅏ漢"
/** the same for the characters of EXTRA_CHARS, in order */
const EXTRA: Record<Weight, number[]> = {
  400: [254,221,221,439,439,762,957,471,627,862,1109,1229,1073,341,341,427,427,482,482,341,341,938,938,938,938,938,639,510,913,913,871,871,871,864,864,1004],
  500: [263,235,235,455,455,790,960,474,636,895,1122,1248,1097,357,357,438,438,504,504,357,357,938,938,938,938,938,639,495,916,916,879,879,879,864,864,1004],
  600: [272,249,249,470,470,818,963,477,645,927,1134,1267,1121,374,374,449,449,527,527,374,374,938,938,938,938,938,639,480,918,918,887,887,887,864,864,1004],
  700: [282,263,263,485,485,846,966,479,653,959,1146,1285,1144,390,390,460,460,549,549,390,390,938,938,938,938,938,639,465,921,921,895,895,895,864,864,1004],
  800: [292,277,277,500,500,875,969,482,662,992,1159,1304,1167,406,406,471,471,571,571,406,406,938,938,938,938,938,639,450,924,924,903,903,903,864,864,1004],
  900: [301,292,292,516,516,903,972,485,671,1024,1171,1323,1191,423,423,482,482,593,593,423,423,938,938,938,938,938,639,435,927,927,911,911,911,864,864,1004],
}

/** One character's width in 1/1000 em (a character the table does not know counts as a full em). */
export function charWidth(ch: string, w: Weight): number {
  const cp = ch.codePointAt(0) ?? 0
  if (cp >= 32 && cp <= 126) return ASCII[w][cp - 32]!
  const i = EXTRA_CHARS.indexOf(ch)
  if (i >= 0) return EXTRA[w][i]!
  if ((cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0x1100 && cp <= 0x11ff) || (cp >= 0x3131 && cp <= 0x318e)) return 864
  if (cp >= 0xff01 && cp <= 0xff5e) return 938
  // Latin letters with marks (é, ñ, ü …): as wide as the widest plain capital but W
  if (cp >= 0xc0 && cp <= 0x24f) return 780
  if (cp === 0xa0) return ASCII[w][0]!
  return 1000
}

const chars = (s: string) => [...s.normalize('NFC')]

/** A text's width in px at `size` px, with CSS letter-spacing `tracking` (em; added after every character). */
export function textWidth(text: string, size: number, w: Weight, tracking = 0): number {
  const cs = chars(text)
  let sum = 0
  for (const c of cs) sum += charWidth(c, w)
  return (sum / 1000) * size + cs.length * tracking * size
}

/** Lines of `text` in a box `max` px wide, broken only at spaces (CSS word-break: keep-all, as every Korean line of
 * the templates). null: one word is wider than the box. */
export function wrapLines(text: string, max: number, size: number, w: Weight, tracking = 0): string[] | null {
  const words = text.trim().split(/\s+/).filter(Boolean)
  const out: string[] = []
  let line = ''
  for (const word of words) {
    if (textWidth(word, size, w, tracking) > max) return null
    const next = line ? `${line} ${word}` : word
    if (!line || textWidth(next, size, w, tracking) <= max) line = next
    else { out.push(line); line = word }
  }
  if (line) out.push(line)
  return out
}

/** The largest whole size from `max` down to `min` at which every line fits `width`; null when none does. */
export function fitSize(lines: readonly string[], width: number, w: Weight, tracking: number, max: number, min: number): number | null {
  const widest = Math.max(...lines.map((l) => textWidth(l, 1, w, tracking)), 0.0001)
  const size = Math.min(max, Math.floor(width / widest))
  return size >= min ? size : null
}
