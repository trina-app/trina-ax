# Promo video sounds

The music beds and sound effects of the promo video template (docs/DECISIONS.md "V"). Only CC0 or public-domain
sound is allowed here: it is bundled in this repository, served to the chat from /vendor/promo-video/ and mixed
into customers' MP4s. Each bed was cut to 18.5 s with a downbeat on its first frame and normalised; each effect was
trimmed and normalised. Checked by tests/unit/b-promo-video.test.ts.

The tempo is our measurement, not the source pages' (none of them states one): spectral-flux onsets of the decoded track,
with a line fitted through the beat onsets over the whole track, gave 119.999 BPM for each of the three (so no time
stretch was applied); after the cut, onsets land within ±9 ms of the 0.5 s grid (37 of 37 grid points for the bright
and pulse beds; 24 of 37 for the calm bed, whose half-time pattern rests on the others), and the same fit over the cut
gives 119.985, 120.024 and 120.005 BPM.

| File | Title | Author | Source | Licence | Licence text |
|---|---|---|---|---|---|
| bed-bright.m4a | Back In The 80s | Holizna (HoliznaCC0) | https://opengameart.org/content/happy-pop-electronic-collection | CC0 1.0 | https://creativecommons.org/publicdomain/zero/1.0/ |
| bed-calm.m4a | Village of Snow | zesona | https://opengameart.org/content/village-of-snow | CC0 1.0 | https://creativecommons.org/publicdomain/zero/1.0/ |
| bed-pulse.m4a | Trace Agent | vitalezzz | https://opengameart.org/content/trace-agent | CC0 1.0 | https://creativecommons.org/publicdomain/zero/1.0/ |
| whoosh.m4a | Whoosh (synthesised) | made for this repository | generated with ffmpeg (below) | Made for this repository (CC0 1.0) | https://creativecommons.org/publicdomain/zero/1.0/ |
| whoosh-short.m4a | Short whoosh (synthesised) | made for this repository | generated with ffmpeg (below) | Made for this repository (CC0 1.0) | https://creativecommons.org/publicdomain/zero/1.0/ |
| click.m4a | click_001 (Interface Sounds) | Kenney (Kenney Vleugels, kenney.nl) | https://kenney.nl/assets/interface-sounds | CC0 1.0 | https://creativecommons.org/publicdomain/zero/1.0/ |
| hit.m4a | impactPunch_heavy_002 (Impact Sounds) | Kenney (Kenney Vleugels, kenney.nl) | https://kenney.nl/assets/impact-sounds | CC0 1.0 | https://creativecommons.org/publicdomain/zero/1.0/ |
| impact.m4a | Impact (Kenney impactSoft_heavy_000 + lowFrequency_explosion_000, a generated swell) | Kenney (kenney.nl), made for this repository | https://kenney.nl/assets/impact-sounds , https://kenney.nl/assets/sci-fi-sounds | CC0 1.0 | https://creativecommons.org/publicdomain/zero/1.0/ |
| chime.m4a | Chime (synthesised: A5 then E6 struck tones) | made for this repository | generated with ffmpeg (below) | Made for this repository (CC0 1.0) | https://creativecommons.org/publicdomain/zero/1.0/ |

## How each file was made

- **bed-bright.m4a** — "Back In The 80s" (Holizna, *Happy Pop Electronic Collection*), measured at 120 BPM (above): source 2:00.0–2:18.5
  (the drop after the breakdown, a kick on every beat), cut on a downbeat, fade-out over the last 1.8 s, −16 LUFS, AAC.
  OpenGameArt licence field: CC0; the page: "This music is public domain Cc0, so use it how you want!"
- **bed-calm.m4a** — "Village of Snow" (zesona), measured at 120 BPM: source 0:32.0–0:50.5 (beat and pads after the intro), same
  processing. OpenGameArt licence field: CC0; the page: "…I am releasing it here into the public domain."
- **bed-pulse.m4a** — "Trace Agent" (vitalezzz), measured at 120 BPM: an 18.5 s section cut on a downbeat, same processing.
  OpenGameArt licence field: CC0.
- **whoosh.m4a**, **whoosh-short.m4a** — made for this repository: seeded pink noise through a frequency sweep and a
  swell envelope (ffmpeg `anoisesrc` + `afftfilt`), peaking at 0.457 s and 0.218 s. Dedicated under CC0 1.0.
- **click.m4a** — Kenney *Interface Sounds* `click_001`, trimmed. **hit.m4a** — Kenney *Impact Sounds*
  `impactPunch_heavy_002`, trimmed. Kenney's pages: "License: Creative Commons CC0"; the packs' License.txt: "(Creative
  Commons Zero, CC0) … free to use in personal, educational and commercial projects."
- **impact.m4a** — Kenney *Impact Sounds* `impactSoft_heavy_000` and *Sci-fi Sounds* `lowFrequency_explosion_000` (CC0,
  as above) under a generated swell made for this repository, peaking at 0.506 s.
- **chime.m4a** — made for this repository: two struck sine tones (A5, then E6) with harmonics and decay (ffmpeg
  `aevalsrc`). Dedicated under CC0 1.0.

Every effect is mono AAC, trimmed with short fades and normalised to sit under a −16 LUFS bed; the template places each
one so that its loudest moment lands on its visual hit (server/src/promo-video/audio.ts).
