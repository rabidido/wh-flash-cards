# AdMech Flash Cards

Mobile flash cards for learning Adeptus Mechanicus datasheets: model statlines
(M, T, Sv, W, Ld, OC, invulnerable save) and weapon profiles (Range, A, BS/WS,
S, AP, D, keywords).

Pick the units you want to drill, tap a card to reveal the statline, mark
yourself right or wrong. Cards you miss come back later in the same session,
and how well you know each card is remembered between sessions.

## Data

Everything comes from the [BSData wh40k-11e](https://github.com/BSData/wh40k-11e)
catalogues and nothing else. `data/admech.json` is generated — do not hand-edit
it. The exact source commit is recorded in the file and shown at the bottom of
the unit list.

Excluded: Legends and Crucible datasheets, Enhancements, Crusade content, and
optional weapon modifications — none of them are part of a datasheet's printed
statlines.

Statlines are taken as printed. BattleScribe conditional modifiers (a
detachment rule that adds a weapon keyword, say) are deliberately not applied.

### Regenerating

```sh
git clone --depth 1 https://github.com/BSData/wh40k-11e.git
python3 tools/build_data.py wh40k-11e
```

Python 3 standard library only. The script reads `Warhammer 40,000.json` (for
the profile type ids) and `Imperium - Adeptus Mechanicus.json`, then writes
`data/admech.json`.

## Running it

No build step, no package manager, no dependencies — plain HTML, CSS and
JavaScript. It needs to be served over HTTP rather than opened as a `file://`
URL, because the data is fetched:

```sh
python3 -m http.server 8000
# http://localhost:8000
```

## GitHub Pages

Every push to `main` deploys via `.github/workflows/pages.yml`. This needs
Settings → Pages → Build and deployment → Source set to **GitHub Actions**
(once).

The workflow copies `index.html`, `style.css`, `app.js`, `.nojekyll` and
`data/` into `_site` and publishes that, so the generator and this README are
not served. Adding a file to the site means adding it to the staging step.

## Layout

```
.github/workflows/pages.yml   deploys to Pages on every push to main
index.html          markup for the three views: setup, drill, results
style.css           mobile-first dark theme
app.js              card building, session queue, localStorage
data/admech.json    generated data
tools/build_data.py generator
```

Browser state lives in `localStorage` under the `admech-fc:` prefix: unit
selection, which card kinds are enabled, and a per-card streak counter used to
put weaker cards earlier in a session. The ↺ button on the setup screen clears
the streaks.

Not affiliated with Games Workshop. Warhammer 40,000 is a trademark of Games
Workshop Ltd.
