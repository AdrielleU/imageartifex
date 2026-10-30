# ImageArtifex — notes for Claude

For any agent: see AGENTS.md (CLI + HTTP API) and docs/openapi.json. Keep `src/opschema.js` in sync when adding an
op, then run `node bin/artifex.js openapi docs/openapi.json` (a test checks both).

A layered image editor with a browser UI (Photoshop/GIMP-style) and a CLI. Every edit — from the
browser or the CLI — is an op appended to `<project>/history.jsonl` with a plain-English `text`.

## Editing an image when the user asks

Always pass `--as claude` so the history shows who made the change.

```bash
A="node bin/artifex.js -p <project> --as claude"
$A changes            # FIRST: what the user changed in the browser since you last looked
$A layers             # current canvas + layer stack (top first), ids like L3
$A ops                # raw op reference
```

Selections work like GIMP: `select rect|ellipse|lasso|wand|color|alpha|all|none|invert|feather|grow|shrink|border`,
then act on them with `clear`, `fill`, `bucket`, `copy-layer`, `cut-layer`, `mask`, `crop-selection`.
Brush strokes are limited to the selection. Check `select info` before relying on one.
Tones: run `histogram <layer>` before choosing `levels`/`curves` values; `levels <layer> --auto` is a good start.
`balance` (GIMP's color balance formula; `--reset-range` clears one range), `threshold` and `posterize` are also per-layer and removable (`--reset` / `--off`). Order applied:
shadows-highlights → exposure → levels → curves → color balance → hue-chroma → posterize → threshold → color to alpha.
`shadows-highlights <layer> --shadows 40 --highlights -30`, `exposure <layer> --stops 0.5`, `hue-chroma <layer> --hue 30 --chroma -20`
and `color-to-alpha <layer> --at x,y` (or `--color #hex`) use GIMP's formulas. To read values back: `pick <x> <y> [--layer L]` (exact color at a point, before/after the
layer's adjustments) and `tone <layer> [--json]` (every tone setting, including curve points).
Retouching: `add paint --name Fix`, then `clone Fix --from x,y --points "x,y x,y"`, `heal Fix --from x,y --points ...`,
`smudge Fix --points ... [--rate 50]`, `dodge Fix`/`burn Fix --points ... [--range midtones --exposure 50]`
(`--size`, `--hardness`, `--sample merged|<layer>`; points are canvas coords; result is baked into a patch). Use `pick`
to find a clean source area with matching tones, and export to check the result.
Paths: `path add "M 100 100 C 150 40 250 40 300 100 Z" --name Arch` (SVG path data, absolute coords), then
`path stroke Arch --color #000 --size 4 [--layer <paint>]`, `path fill Arch --color #hex`, `path select Arch`.
`path list` prints every path's d string, so you can read the user's Pen-tool paths and edit them with `path set`.
Structure: `group a b --name G`, `nudge G dx dy`, `clip <layer>`, `add adjustment --name Warm` then e.g.
`balance Warm --range highlights --yellow-blue -30` (affects everything below), `lock <layer> --position`.
Masks: `mask <layer>` (selection) or `mask-paint <layer> --points … [--reveal]`; quick mask `select paint --points …`.
Filters: `unsharp`, `denoise`, `high-pass`. Canvas: `image-size --percent 50`, `guide add x 300`.
Files: `import x.psd|x.xcf` (layers, groups, masks), `export out.psd|xcf|pdf|svg`.
Transform: `perspective <layer> --corners "x,y x,y x,y x,y"`, `warp <layer> --grid 3x3 --move "1,1:0,30"`,
`liquify <layer> --points … --mode push`, `distort <layer> --kind twirl --amount 120`, `text-on-path <text> <path>`.
Selections: `select transform --rotate 15 --scale 1.2`, `select save <name>` / `select load <name> [--mode add]`,
`select scissors "x,y x,y x,y"` (snaps to edges), `select foreground --outline "…" [--paint "…"]` (cut out an object),
`stroke-selection --width 4`. Filters: `pixelate`, `emboss`, `distort --kind lens`. Other projects: `paste-from <dir> <layer>`.
Gradients: `gradient x1 y1 x2 y2 --from #hex --to #hex|transparent [--type radial]` (fills the selection if one exists).

Then make edits with commands (`import`, `add text|rect|ellipse|paint`, `stroke`, `set`, `move`,
`fit`, `center`, `order`, `merge`, `merge-down`, `flatten`, `crop`, `canvas`, `bg`, `undo`) or a JSON batch:
`$A op '[{"type":"layer.update","id":"Logo","props":{"adjust":{"contrast":120}}}]'`.

To *see* the result: `$A export <scratchpad>/preview.png`, then Read the PNG. Do this after
non-trivial edits rather than assuming the layout is right.

If the user has the editor open (`artifex serve`), CLI edits appear there live.

## Code layout

- `src/model.js` — doc schema, ops (`applyOpMut`), undo/redo `replay`, `describe` (log text). Shared with the browser.
- `src/formats.js` — PSD import/export (ag-psd), XCF (via `src/xcf.js`, GIMP's format), PDF and SVG export. `src/opschema.js` — op catalog → OpenAPI.
- `src/paths.js` — bezier paths (Pen tool): SVG path data ↔ anchors, tracing, transforms. Shared by browser and Node.
- `src/smartselect.js` — intelligent scissors (live-wire) and foreground select; shared by browser (preview) and Node.
- `src/heal.js` / `src/smudge.js` — heal (Laplace) and smudge (accumulator) solvers, run in `materialize` when a stroke is committed.
- Browser speed: `render.js` caches processed (masked/toned) layers in layer space (moving one is a redraw, not a
  re-process) and paint layers incrementally; `web/app.js` draws at most once per frame and uses half-res "draft"
  processing for big layers while a slider is dragged. Keep new per-pixel work behind those caches.
- `web/gpu.js` — WebGL2 version of `applyTone` used by the browser on a real GPU (software WebGL keeps the CPU path;
  `?gpu=0` / `?gpu=1` force either). It reuses toneProgram's LUTs. When adding a tone step, add it to the shader and
  its SUPPORTED list (until then it falls back to the CPU), and re-run the GPU/CPU parity check (±1 per channel).
  The status bar badge shows the browser's GPU, or a warning when it is software-rendered.
- `src/tone.js` — tone math (levels/curves LUTs, exposure, color balance, hue-chroma, shadows-highlights, color to alpha) and histograms, shared by browser and Node.
- `src/render.js` — Canvas 2D renderer, shared by browser and Node (`@napi-rs/canvas`), so previews match exports.
- `src/store.js` — Node-only: project files, `materialize` (names → ids, file paths → assets, merges rasterized), `commit`.
- `src/server.js` — HTTP API + SSE live updates. `web/` — editor UI. `bin/artifex.js` — CLI.
- Every browser button has a matching CLI command (and the same op over `POST /api/ops`). Keep it that way.
- New feature = new op (or new prop) in `model.js` + a `describe` case + CLI command + UI control. Keep ops
  deterministic: anything needing I/O (rasterizing, importing) is resolved in `materialize` before logging.
- `GIMP-PARITY.md` tracks which GIMP features exist. Update it when adding one.
- Tests: `npm test`.
