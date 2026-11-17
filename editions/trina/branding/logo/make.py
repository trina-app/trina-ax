#!/usr/bin/env python3
"""Writes every Trina AX logo and app icon file from one place, then renders the PNGs.

    python3 editions/trina/branding/logo/make.py <Geist-Variable.woff2|ttf>

Needs fontTools (pip install fonttools brotli) for the wordmark and rsvg-convert (brew install librsvg) for the PNGs.
The Geist font is ax.trina.app's (public/docs/assets/site-nav/Geist-Variable.woff2 in the website repository, OFL).
The web app's PNG icons and favicon.ico come from web/public/favicon.svg afterwards: bun web/scripts/make-icons.ts.
"""
import os, subprocess, sys
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..', '..'))
TOP = 'M16 19.028L11.497 13.85L2.528 11.25L11.497 8.65L16 3.472L20.503 8.65L29.472 11.25L20.503 13.85Z'
SIDES = ['M29.472 11.25L20.503 13.85L20.503 23.35L29.472 20.75Z', 'M11.497 13.85L2.528 11.25L2.528 20.75L11.497 23.35Z',
         'M16 19.028L11.497 13.85L11.497 23.35L16 28.528Z', 'M20.503 13.85L16 19.028L16 28.528L20.503 23.35Z']
# light = the primary mark (ink sides, Signal Orange top); dark = for dark backgrounds (paper sides, brighter orange)
COLOURS = {'light': ('#14110f', '#ff5b1f'), 'dark': ('#f6f2ea', '#ff6a33')}
# the app icon's light tile: brand paper, toned a little darker at the bottom so it still reads on a white home screen
TILE_TOP, TILE_BOTTOM, TILE_FLAT = '#fbf9f4', '#efe9de', '#f6f2ea'
GRADIENT = f'<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{TILE_TOP}"/><stop offset="1" stop-color="{TILE_BOTTOM}"/></linearGradient>'


def mark(theme):
    ink, top = COLOURS[theme]
    return ('<defs><mask id="m" maskUnits="userSpaceOnUse" x="-8" y="-8" width="48" height="48"><rect x="-8" y="-8" width="48" height="48" fill="#fff"/>'
            f'<path d="{TOP}" fill="#000" stroke="#000" stroke-width="3" stroke-linejoin="round"/><path d="M16 19.028L16 29.528" stroke="#000" stroke-width="1.65"/></mask></defs>'
            f'<g fill="{ink}" stroke="{ink}" stroke-width="0.25" stroke-linejoin="round" mask="url(#m)">' + ''.join(f'<path d="{d}"/>' for d in SIDES) +
            f'</g><path d="{TOP}" fill="{top}"/>')


def scaled(theme, s):
    return f'<g transform="translate(16 16) scale({s}) translate(-16 -16)">{mark(theme)}</g>'


def svg(body, box='0 0 32 32', extra=''):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{box}"{extra}>{body}</svg>\n'


# a rounded tile (tabs, the web app, Windows tiles drawn by us): hairline edge so it holds on white
def rounded_tile(s):
    return svg(f'<defs>{GRADIENT}</defs><rect width="32" height="32" rx="7.2" fill="url(#bg)"/>'
               '<rect x=".25" y=".25" width="31.5" height="31.5" rx="6.95" fill="none" stroke="#14110f" stroke-opacity=".12" stroke-width=".5" data-edge=""/>' + scaled('light', s))


# a full-bleed square (iOS and the stores cut their own corners; an edge line would be cut too)
def square_tile(s):
    return svg(f'<defs>{GRADIENT}</defs><rect width="32" height="32" fill="url(#bg)"/>' + scaled('light', s))


def wordmark(theme, font):
    """The site nav's logo (.logo in the website's base.css): a 26 px mark, 10 px gap, "Trina AX" in Geist 650 at 17 px,
    letter-spacing -0.03em, the words' cap height centred on the mark. Text as outlines, so no font is needed."""
    f = instantiateVariableFont(TTFont(font), {'wght': 650})
    gs, cmap, upm = f.getGlyphSet(), f.getBestCmap(), f['head'].unitsPerEm
    size = 17.0; k = size / upm; spacing = -0.03 * size
    x, parts = 0.0, []
    for ch in 'Trina AX':
        g = gs[cmap[ord(ch)]]
        pen = SVGPathPen(gs)
        g.draw(TransformPen(pen, (k, 0, 0, -k, x, 0)))
        if pen.getCommands(): parts.append(pen.getCommands())
        x += g.width * k + spacing
    width = 36 + x - spacing
    baseline = 13 + f['OS/2'].sCapHeight * k / 2
    ink = COLOURS[theme][0]
    return svg(f'<svg width="26" height="26" viewBox="0 0 32 32">{mark(theme)}</svg><path transform="translate(36 {baseline:.3f})" fill="{ink}" d="{" ".join(parts)}"/>',
               f'0 0 {width:.2f} 26')


def write(rel, text):
    p = os.path.join(ROOT, rel)
    with open(p, 'w') as fh: fh.write(text)
    return p


def png(src, out, w, h=None):
    subprocess.run(['rsvg-convert', '-w', str(w), '-h', str(h or w), os.path.join(ROOT, src), '-o', os.path.join(ROOT, out)], check=True)


def main():
    font = sys.argv[1]
    L = 'editions/trina/branding/logo'
    for t in COLOURS:
        write(f'{L}/mark-{t}.svg', svg(mark(t)))
        write(f'{L}/wordmark-{t}.svg', wordmark(t, font))
        for size in (512, 1024): png(f'{L}/mark-{t}.svg', f'{L}/mark-{t}-{size}.png', size)
    import re
    box = re.search(r'viewBox="0 0 ([\d.]+) 26"', open(os.path.join(ROOT, f'{L}/wordmark-light.svg')).read())
    ratio = 26 / float(box.group(1))
    for t in COLOURS:
        for w in (512, 1024): png(f'{L}/wordmark-{t}.svg', f'{L}/wordmark-{t}-{w}.png', w, round(w * ratio))
    write(f'{L}/app-icon.svg', rounded_tile(0.78))
    write(f'{L}/app-icon-square.svg', square_tile(0.83))
    for size in (512, 1024): png(f'{L}/app-icon-square.svg', f'{L}/app-icon-{size}.png', size)  # store uploads (Play's 512 px icon)

    # the web app's tab and installed icon (web/scripts/make-icons.ts renders the PNGs and favicon.ico from it)
    write('web/public/favicon.svg', rounded_tile(0.88))
    # the desktop app: macOS icon grid (an 824 px tile with 184 px corners on 1024), the mark at 0.82 of the tile
    write('desktop/scripts/trina-icon.svg',
          '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">\n'
          '<!-- The desktop app\'s icon (Trina edition), written by editions/trina/branding/logo/make.py: the macOS icon grid (an 824 px\n'
          '     tile with 184 px corners on a 1024 px canvas), the light tile with a hairline edge, the mark at 0.82 of the tile.\n'
          '     electron-builder makes the .icns (DMG and Mac App Store) and the Windows .ico from desktop/build-resources/icon.png. -->\n'
          f'<defs>{GRADIENT}</defs>\n'
          '<rect x="100" y="100" width="824" height="824" rx="184" fill="url(#bg)"/>\n'
          '<rect x="101.5" y="101.5" width="821" height="821" rx="182.5" fill="none" stroke="#14110f" stroke-opacity=".12" stroke-width="3"/>\n'
          f'<g transform="translate(100 100) scale(25.75)">{scaled("light", 0.82)}</g>\n</svg>\n')
    png('desktop/scripts/trina-icon.svg', 'desktop/build-resources/icon.png', 1024)

    # phones (mobile/app.config.ts): iOS icon full-bleed; Android adaptive foreground (mark only) on adaptive-background;
    # the launch screen's mark (light, in both of the phone's modes). The notification icon stays the white silhouette.
    M = 'editions/trina/branding/mobile'
    write(f'{M}/icon.svg', square_tile(0.83)); png(f'{M}/icon.svg', f'{M}/icon.png', 1024)
    write(f'{M}/adaptive-icon.svg', svg(scaled('light', 0.5))); png(f'{M}/adaptive-icon.svg', f'{M}/adaptive-icon.png', 1024)
    write(f'{M}/adaptive-background.svg', svg(f'<defs>{GRADIENT}</defs><rect width="32" height="32" fill="url(#bg)"/>')); png(f'{M}/adaptive-background.svg', f'{M}/adaptive-background.png', 1024)
    write(f'{M}/splash-icon.svg', svg(scaled('light', 1))); png(f'{M}/splash-icon.svg', f'{M}/splash-icon.png', 1024)

    # Microsoft Store tiles: the square icon, and the wide tile
    S = 'editions/trina/microsoft-store/build-resources'
    write(f'{S}/wide-tile.svg', svg(f'<defs>{GRADIENT}</defs><rect width="62" height="30" fill="url(#bg)"/><svg x="16" y="0" width="30" height="30" viewBox="0 0 32 32">{scaled("light", 0.64)}</svg>', '0 0 62 30'))
    for name, size in [('LargeTile', 310), ('LargeTile.scale-200', 620), ('SmallTile', 71), ('SmallTile.scale-200', 142), ('Square150x150Logo', 150),
                       ('Square150x150Logo.scale-200', 300), ('Square44x44Logo', 44), ('Square44x44Logo.scale-200', 88), ('Square44x44Logo.targetsize-256', 256),
                       ('StoreLogo', 50), ('StoreLogo.scale-200', 100)]:
        png(f'{M}/icon.svg', f'{S}/appx/{name}.png', size)
    png(f'{S}/wide-tile.svg', f'{S}/appx/Wide310x150Logo.png', 310, 150)
    png(f'{S}/wide-tile.svg', f'{S}/appx/Wide310x150Logo.scale-200.png', 620, 300)


if __name__ == '__main__':
    main()
