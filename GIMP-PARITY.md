# GIMP 3 feature parity

ImageArtifex reimplements GIMP's *features* (not its code: GIMP is GPL-3 C/GTK and can't run in a
browser). The layout follows the Photoshop-style single-window arrangement (as in PhotoGIMP):
tools on the left, tool options on top, Properties / Layers / History docked on the right.

Every feature must exist in three places: an **op** (so it's logged in plain English and undoable),
a **CLI command** (so Claude can use it), and a **UI control**.

Legend: ✅ done · 🟡 partial · ⬜ not yet

## Tools
| GIMP tool | Status | Notes |
|---|---|---|
| Move (M / PS: V) | ✅ | auto-selects the clicked layer; arrow keys nudge |
| Paintbrush (P / PS: B) | ✅ | vector strokes on paint layers: size `[` `]`, opacity, hardness, blend mode, pen pressure; limited to the selection |
| Eraser (Shift+E / PS: E) | ✅ | erases within a paint layer only |
| Text (T) | ✅ | type on the canvas (click), paragraph boxes (drag), double-click to edit; font (+ installed fonts in Chrome), size, weight, italic, line height, alignment; text along a path (`text-on-path <text> <path>`) |
| Rectangle / Ellipse | ✅ | shape layers with fill, stroke, corner radius |
| Crop (Shift+C / PS: C) | ✅ | crops the canvas non-destructively |
| Color picker (O / PS: I) | ✅ | |
| Unified transform: rotate, scale, flip | ✅ | Move tool handles: corners scale (Shift keeps proportions), edges stretch, knob rotates (Shift snaps 15°); numeric in Properties |
| Perspective / warp | ✅ | Move tool → Perspective (4 corners) or Warp (grid 2×2–5×5); `perspective <layer> --corners …`, `warp <layer> --grid 3x3 --move "i,j:dx,dy"` |
| Rectangle select (PS: M) | ✅ | modes replace/add/subtract/intersect; Shift = add, Alt = subtract |
| Ellipse select (Shift+M) | ✅ | |
| Free select / lasso (L) | ✅ | freehand drag (no click-to-add-point polygon mode yet) |
| Fuzzy select / magic wand (W) | ✅ | threshold, contiguous, sample merged or one layer |
| Select by color | ✅ | wand with Contiguous off, or `select color --color #hex` |
| Intelligent scissors (Shift+L) | ✅ | live-wire: click anchors, the outline snaps to edges; `select scissors "x,y x,y x,y"` |
| Foreground select (Shift+F) | ✅ | rough outline (or selection) + optional object strokes → color-model segmentation (simplified SIOX); `select foreground --outline … [--paint …]` |
| Bucket fill (Shift+G) | ✅ | fills similar colors (inside the selection) as a new fill layer |
| Gradient (G) | ✅ | linear/radial, FG → BG or transparent, Shift snaps 15°; editable gradient layer, limited to the selection |
| Clone (S) | ✅ | Alt/Ctrl-click sets the source; aligned or per-stroke; sample merged or one layer; hardness. `clone <layer> --from x,y --points "…"` |
| Heal (J) | ✅ | GIMP's method (Laplace-blended difference); `heal <layer> --from x,y --points "…"`. Heals the whole stroke at once (GIMP heals per dab) |
| Blur / sharpen (Shift+R) | ✅ | blur radius, unsharp strength; `blur\|sharpen <layer> --points …` |
| Smudge (R) | ✅ | GIMP's accumulator smudge (rate, flow + foreground color); `smudge <layer> --points "…" [--rate 50] [--flow 0 --color #hex]` |
| Dodge / burn (Shift+D) | ✅ | GIMP's formulas, shadows/midtones/highlights + exposure; Alt switches; `dodge\|burn <layer> --points "…" [--range] [--exposure 50]` |
| Paths / Pen (P) | ✅ | click corners, drag curves, click first point to close, Enter/Esc; drag anchors & handles to edit (Alt breaks symmetry); Paths panel; stroke, fill, path → selection. `path add "<svg d>"`, `path list/set/select/stroke/fill/remove`. Not yet: selection → path, text → path, boolean ops |
| Zoom | ✅ | Ctrl+wheel, Ctrl+0 fit, Ctrl+1 100% |

## Layers
| Feature | Status |
|---|---|
| Image / text / shape / paint / fill / gradient layers | ✅ |
| Visibility, opacity, rename, reorder (drag), duplicate, delete | ✅ |
| Layer modes: multiply, screen, overlay, … (16 modes) | ✅ |
| Merge down, merge selected, flatten | ✅ |
| Layer masks (add from selection, remove) | ✅ |
| New layer via copy / cut (Ctrl+J / Ctrl+Shift+J) | ✅ |
| Edit mask by painting on it | ✅ Properties → Paint mask (dark hides, light reveals); `mask-paint <layer> --points … [--reveal]` |
| Layer groups (nested), clipping masks, adjustment layers | ✅ `group`/`ungroup`/`nudge`, `clip`, `add adjustment` (+ any tone command on it); Ctrl+G, Ctrl+Alt+G |
| Lock alpha / pixels / position | ✅ Properties → Lock; `lock <layer> --position --pixels --alpha` (enforced for every client) |

## Select menu
| Feature | Status | CLI |
|---|---|---|
| All / None / Invert | ✅ | `select all\|none\|invert` |
| From layer alpha (Alpha to selection) | ✅ | `select alpha <layer>` |
| Feather / Grow / Shrink / Border | ✅ | `select feather\|grow\|shrink\|border <px>` |
| Selection info (bounds, area) | ✅ | `select info` |
| Move / rotate / scale the selection outline | ✅ | drag inside it, arrow keys, or Transform outline handles; `select move`, `select transform --rotate 15 --scale 1.2` |
| Quick mask, saved selections (channels) | ✅ | Q to paint the selection; Channels panel / Select → Save/Load selection; `select save <name>`, `select load <name> --mode add` |

## Edit menu (selection-aware)
| Feature | Status | CLI |
|---|---|---|
| Clear (Delete) | ✅ | `clear <layer>` — non-destructive via layer mask |
| Fill with foreground color | ✅ | `fill <color>` |
| Stroke selection outline | ✅ | Edit → Stroke selection (width, center/inside/outside) → new layer; `stroke-selection --width 4 --position outside` |
| Copy / paste (also between projects) | ✅ | Ctrl+C layer (editable, with masks/adjustments/images) or selected pixels, Ctrl+V / Ctrl+Shift+V in place, any project tab; system clipboard PNG for other apps; `paste-from <project> <layer>` |

## Image menu
| Feature | Status |
|---|---|
| Canvas size (with anchor), crop to rectangle, background color | ✅ |
| Crop to selection | ✅ |
| Scale image (resample everything) | ✅ Image → Image size; `image-size <w> [<h>] \| --percent 50` (non-destructive) |
| Rulers, guides, grid, snapping | ✅ drag guides from the rulers; View menu; `guide add x\|y <pos>` (guides are in the document) |

## Colors menu (non-destructive per-layer adjustments)
| Feature | Status |
|---|---|
| Brightness-contrast, hue-saturation, desaturate, invert, sepia | ✅ |
| Levels (per channel, histogram, auto) | ✅ — `levels <layer> --in --gamma --out`, `--auto` |
| Curves (per channel, interactive editor, presets) | ✅ — `curves <layer> --points` / `--preset` |
| Histogram | ✅ — shown in Levels/Curves; `histogram [layer]` in CLI |
| Color balance (shadows/midtones/highlights, preserve luminosity) | ✅ GIMP's formula — `balance <layer> --range --cyan-red --magenta-green --yellow-blue [--preserve] [--reset-range\|--reset]` |
| Threshold (low/high, per channel) | ✅ — `threshold <layer> --low --high --channel` / `--off` |
| Posterize | ✅ — `posterize <layer> <levels>` / `--off` |
| Shadows-highlights (GIMP's formula: CIE Lab, blurred lightness mask) | ✅ — `shadows-highlights <layer> --shadows --highlights --whitepoint --radius --compress --shadows-color --highlights-color` / `--off` |
| Color to alpha (GIMP's formula, transparency/opacity thresholds) | ✅ — `color-to-alpha <layer> --color #fff \| --at x,y [--transparency] [--opacity]` / `--off` |
| Color picker readout | ✅ — `pick <x> <y> [--layer L]` (before/after a layer's adjustments), `GET /api/pick` |
| Exposure (GIMP's formula: linear light, stops + black level) | ✅ — `exposure <layer> --stops 0.5 [--black-level 0.01]` / `--off` |
| Hue-chroma (GIMP's formula: CIE LCh hue/chroma/lightness) | ✅ — `hue-chroma <layer> --hue 30 --chroma -20 --lightness 5` / `--off` |

## Filters menu
| Feature | Status |
|---|---|
| Gaussian blur | ✅ |
| Drop shadow | ✅ |
| Unsharp mask, noise reduction, high pass | ✅ per-layer, removable; `unsharp`, `denoise`, `high-pass` |
| Liquify (push, twirl, bloat, pinch) | ✅ Liquify tool / `liquify <layer> --points …` (non-destructive, per stroke) |
| Distorts: twirl, pinch/bulge, ripple, waves | ✅ Filters → Distort; `distort <layer> --kind twirl --amount 180` |
| Pixelate, emboss, lens distortion | ✅ per-layer: `pixelate --size 16`, `emboss --azimuth 30 --depth 20`, `distort --kind lens --main 30` (GIMP formulas) |

## File
| Feature | Status |
|---|---|
| Import PNG/JPEG/WebP/GIF (file picker, drag-drop, paste) | ✅ |
| Export PNG/JPEG/WebP (CLI; browser exports PNG) | ✅ |
| Open/save .psd | ✅ layers, groups, masks, opacity, blend, clipping (`import x.psd`, `export x.psd`); adjustment layers are not written |
| Export PDF / SVG | ✅ PDF (one page), SVG (vector shapes/text/gradients, embedded images otherwise) |
| Multiple documents | ✅ projects in a workspace folder, one per tab (File → Open/New project, `?project=`) |
| Open/save .xcf (GIMP) | ✅ layers, groups, masks, opacity, modes (reads XCF 0–11+, none/RLE/zlib, 8-bit RGB/gray/indexed; writes XCF 10). Clipped layers baked; adjustment layers not written |

## Beyond GIMP
- Plain-English history of every change, with who made it (`user`, `claude`, `cli`).
- `artifex changes` shows Claude what you did since it last looked.
- Live sync: CLI edits appear in the open browser editor immediately.
