// The `intro_deck` tool (docs/DECISIONS.md "D2"; round 2): the AI plans the deck (`step: "outline"`), fills one slide
// per call (`step: "slide"`) and finishes it after the server has shown it every slide as a picture
// (`step: "finish"`). It never writes HTML, XML, coordinates or any layout: it fills slots, and the server checks them,
// draws every figure and ground itself (build.ts, spec2.ts, layout2.ts, figures.ts) and keeps the deck as the chat's
// artifact "intro-deck" with its PowerPoint file and PDF (files.ts).
import { DECK_ACCENT_MAX_BYTES, DECK_ACCENTS_MAX, DECK_FIXES_MAX, DECK_TOOL, IntroDeckListing, IntroDeckStep } from '@mycel/shared/api'
import type { AppContext } from '../context'
import type { ToolRegistry } from '../tools/registry'
import type { FetchOptions } from '../tools/web-fetch'
import { runDeckStep } from './build'
import { ICON_NAMES } from './icons'
import { deckTier, tierText } from './tiers'
export { DECK_FONT_CSS, THEME_NAME } from './theme'

export const DECK_TOOL_DESCRIPTION =
  'Make the company\'s intro deck (company profile: 6–10 designed 16:9 slides). You never write HTML, SVG layout or coordinates: you fill slots and the server draws every slide, figure and ground in one design language, checks it and shows it next to the chat (artifact "intro-deck"; people download PowerPoint and PDF). ' +
  'Read the material first (the files in `sources`, the company profile) and look at every picture in the brand images folder. Then, with no text in between: ' +
  '(1) step "outline": title, company, website, brand_color, logo, sources, `pattern`, a note for every picture you may use (what it shows, whether it has lettering where type would sit, its calm side, its tone), and 6–10 slide stubs in order — cover, about, opening (optional, one), needs, offer, numbers, products (up to two), process, proof, history, contact last; leave out a kind without material, never pad. Each content stub names its figure; flow, cycle, hub, layers, timeline, compare, funnel and merge need a `basis`: a sentence copied word for word from the sources that shows the order, the loop, the centre, the stack, the before/after, the convergence or the narrowing. ' +
  '(2) step "slide" once per slide, in order (index 0 first), with the slide\'s slots and its figure. (3) After the last slide the result shows you every slide as a picture with the server\'s findings: call step "finish" once, with at most ' + DECK_FIXES_MAX + ' slide changes or none. ' +
  'Figures by slide: about — hub (the company or its core at the centre of what it serves), compare (before → now) or figures (big numbers), or just facts; needs — merge (many channels into one), compare (old way → new way) or grid (pains with icons); offer — layers (built on), grid (offers with icons and product tags as written) or hub; numbers — donut (shares written as %), bars (values of one unit, or durations), line (≥ 3 dated values) or figures (single numbers); products — cards (each product\'s own picture ≥ 400 px) or grid (icons); process — flow (3–5 steps in order) or cycle (only if the material says it repeats); proof — a quote word for word, names as written, or a compare (a case); history — timeline (years as written, or an order of places the material states; a "next" only if the material names it). No numbers slide when the material has no numbers. ' +
  'Rules the server checks: every number written in the sources (chart values exactly as written with their unit); names of customers, partners, certifications and people as written; a quote word for word; contact details as written in the sources or the profile; no superlative (best, first, only, No.1, in any language) unless the sources say it; every line fits (a line too long comes back with the size it must keep); pictures only from the brand images folder, each once, never the logo; a full-bleed cover needs a landscape picture ≥ 1,600 px wide, a panel ≥ 800 px on its short side, a card ≥ 400 px; a picture with lettering where type would sit never goes under type. ' +
  'Icons: names from this list only (an unknown name becomes a dot): ' + ICON_NAMES.join(', ') + '. ' +
  `Accents (the owner's wish: draw one on the closing slide, and one on the cover when the cover has no picture; at most ${DECK_ACCENTS_MAX} per deck, only on the cover, an opening or the closing, drawn on the right half): an SVG in this grammar only — viewBox="0 0 800 800"; elements svg, g, path, circle, ellipse, rect, line, polyline, polygon, defs, linearGradient, radialGradient, stop, clipPath; attributes for geometry and fill, stroke, stroke-width (1.5, 2 or 3), opacity / fill-opacity / stroke-opacity (0.08–1), stroke-linecap, stroke-linejoin, stroke-dasharray, transform (translate, rotate, scale), id on gradients and clip paths, fill / clip-path = url(#local-id); colours by name only: ink, ground, line, mark, onMark; no text, no people, no logos, no other colours, at most 150 elements and ${DECK_ACCENT_MAX_BYTES / 1000} KB. Make it abstract, fine and from the company's world, filling the 800 box around its centre (400, 400) out to a radius of about 360: 30–150 elements, thin strokes (1.5 or 2), most of it in \`line\` or in \`mark\` at low opacity (0.1–0.3), one to a few small elements in solid \`mark\` as the highlight. Examples: a wafer (a circle with a small notch, and 150–300 small square dies of 24–30 px with 4–6 px gaps written as ONE path of many "M x y h 26 v 26 h -26 z" squares inside the circle, a second path with 6–12 of them in solid mark); growth rings (10–14 slightly wobbly closed paths, one ring in mark); orbits (two rings around a solid disc, small circles on the rings joined to the centre by thin lines). Never a few big blocks. A rejected accent is simply left out. ` +
  'If a step comes back with problems, fix all of them and send that step again.'

export function registerIntroDeck(ctx: AppContext, reg: ToolRegistry, o: { fetch?: FetchOptions } = {}): void {
  reg.register({
    name: DECK_TOOL,
    description: DECK_TOOL_DESCRIPTION,
    input: IntroDeckStep,
    // the model's API takes only an object as a tool's input schema: the steps' fields in one object for the listing
    // the team's time budget (tiers.ts) is read at every answer's start: what to read and search before the outline
    listing: () => ({ description: `${tierText(deckTier(ctx.db, ctx.config.mode === 'dev'))} ${DECK_TOOL_DESCRIPTION}`, input: IntroDeckListing }),
    describe: (a) => `${DECK_TOOL} ${a.step}${a.step === 'slide' ? ` ${a.index} ${a.slide.kind}` : a.step === 'outline' ? ` ${a.slides.length}` : a.step === 'read' ? ` ${a.urls?.length ?? 0}` : ''}`,
    run: (a, t) => runDeckStep(ctx, a, t, { fetch: o.fetch }),
  })
}
