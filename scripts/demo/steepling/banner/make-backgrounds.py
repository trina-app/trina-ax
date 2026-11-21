"""The demo's banner backgrounds (server/src/demo/fakes/banner.ts): text-free product photos cut to the three banner
sizes, with the pouch's blank label found on each, into ../assets/banner/ (bg-<scene>-<size>.jpg and scenes.json).

  python3 scripts/demo/steepling/banner/make-backgrounds.py <folder of photos>

The folder holds <scene>-wide.jpg (16:9), <scene>-square.jpg (1:1, optional) and <scene>-tall.jpg (9:16): one-cup is
the scripted story's three photos (scripts/demo/mina/source/photos/hero, square, story), the others were made once with
Higgsfield (gpt_image_2_6, medium, 2k, the hero as reference; no text in them) and are not kept in the repository.
A scene without a square photo has no square banner (the fake picks the closest scene that has one).

Each picture is JPEG quality 84, 4:4:4, progressive, at most 1200 px on its longest side (the story is 675x1200 and
drawn at 1080x1920). Needs python3 with Pillow. The demo never runs this; it only reads ../assets/banner.
"""
import json
import os
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'assets', 'banner')
MAX_SIDE = 1200

# scene id -> the words the fake matches a prompt against (English and Korean; the first scene is the default)
SCENES = {
  'one-cup': ['one', 'single', 'glass', 'cup', 'window', 'frosted', 'morning', 'launch', '한', '잔', '한잔', '유리잔', '창가', '아침'],
  'two-cups': ['two', 'cups', 'glasses', 'pair', 'share', 'friends', 'together', '두', '두잔', '둘', '함께', '같이', '나눠'],
  'pouch': ['pouch', 'pack', 'package', 'bag', 'product', 'close', 'closeup', 'packshot', '파우치', '패키지', '포장', '제품', '클로즈업'],
  'cafe': ['cafe', 'café', 'coffee', 'shop', 'table', 'marble', 'partner', 'partners', '카페', '테이블', '매장', '파트너'],
}
# size -> (source photo, output w, h)
SIZES = {'1200x628': ('wide', 1200, 628), '1080x1080': ('square', 1080, 1080), '1080x1920': ('tall', 1080, 1920)}


def cover(img, w, h):
  """the middle of `img` cut to w:h"""
  sw, sh = img.size
  if sw / sh > w / h:
    nw = round(sh * w / h)
    x = (sw - nw) // 2
    return img.crop((x, 0, x + nw, sh))
  nh = round(sw * h / w)
  y = (sh - nh) // 2
  return img.crop((0, y, sw, y + nh))


def largest(mask, w, h, within=None):
  """the bounding box (x0, y0, x1, y1) and size of the largest 4-connected region of `mask` (inside `within`)"""
  seen = bytearray(w * h)
  best, best_n = None, 0
  x_lo, y_lo, x_hi, y_hi = within or (0, 0, w - 1, h - 1)
  for sy in range(y_lo, y_hi + 1):
    for sx in range(x_lo, x_hi + 1):
      i = sy * w + sx
      if seen[i] or not mask[i]:
        continue
      stack, n, bx0, by0, bx1, by1 = [i], 0, sx, sy, sx, sy
      seen[i] = 1
      while stack:
        j = stack.pop(); n += 1
        x, y = j % w, j // w
        bx0, by0, bx1, by1 = min(bx0, x), min(by0, y), max(bx1, x), max(by1, y)
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
          if x_lo <= nx <= x_hi and y_lo <= ny <= y_hi:
            k = ny * w + nx
            if not seen[k] and mask[k]:
              seen[k] = 1; stack.append(k)
      if n > best_n:
        best, best_n = (bx0, by0, bx1, by1), n
  return best, best_n


def label_box(img):
  """the pouch's blank cream label as fractions (left, top, right, bottom), or None: the largest dark green region is
  the pouch, the largest cream region inside its box the label"""
  small = img.resize((img.width // 3, img.height // 3))
  w, h = small.size
  data = list(small.getdata())
  green = [1 if (g > r + 12 and g >= b and g < 130 and r < 90) else 0 for r, g, b in data]
  pouch, n = largest(green, w, h)
  if not pouch or n < w * h * 0.02:
    return None
  cream = [1 if (r > 165 and g > 155 and b > 125 and r - b < 60 and r - g < 30) else 0 for r, g, b in data]
  lab, m = largest(cream, w, h, pouch)
  if not lab or m < n * 0.08:
    return None
  x0, y0, x1, y1 = lab
  return [round(x0 / w, 4), round(y0 / h, 4), round((x1 + 1) / w, 4), round((y1 + 1) / h, 4)]


def main():
  src = sys.argv[1]
  os.makedirs(OUT, exist_ok=True)
  scenes = []
  for scene, words in SCENES.items():
    photos = {}
    for size, (kind, w, h) in SIZES.items():
      f = os.path.join(src, f'{scene}-{kind}.jpg')
      if not os.path.exists(f):
        continue
      img = cover(Image.open(f).convert('RGB'), w, h)
      s = min(1, MAX_SIDE / max(w, h))
      img = img.resize((round(w * s), round(h * s)), Image.LANCZOS)
      name = f'bg-{scene}-{size}.jpg'
      img.save(os.path.join(OUT, name), 'JPEG', quality=84, subsampling=0, progressive=True, optimize=True)
      photos[size] = {'file': name, 'label': label_box(img)}
      print(name, img.size, photos[size]['label'], os.path.getsize(os.path.join(OUT, name)))
    scenes.append({'id': scene, 'words': words, 'photos': photos})
  with open(os.path.join(OUT, 'scenes.json'), 'w') as fh:
    json.dump({'scenes': scenes}, fh, ensure_ascii=False, indent=1)
    fh.write('\n')


if __name__ == '__main__':
  main()
