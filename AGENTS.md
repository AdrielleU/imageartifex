# Using ImageArtifex from an AI agent (or any program)

ImageArtifex is a layered image editor (browser UI in the style of Photoshop/GIMP) that can be driven entirely
from a **CLI** or an **HTTP API**. Every edit is an *op* recorded in the project history with a plain-English
description, so a person in the browser and an agent see each other's changes — live.

Hand any agent this file plus the API description:

- **OpenAPI 3.1:** [`docs/openapi.json`](docs/openapi.json) — or `GET /api/openapi.json` from a running server,
  or `artifex openapi > openapi.json`
- **Every op with its JSON Schema and an example:** `artifex ops --json`, or `GET /api/ops/catalog`

## Start

```bash
npm install
node bin/artifex.js init myproject --width 1200 --height 800   # new project folder
node bin/artifex.js -p myproject serve                        # editor + API on http://127.0.0.1:4747
```

The server listens on 127.0.0.1 only. To reach it from another machine use an SSH tunnel:
`ssh -L 4747:127.0.0.1:4747 you@server`.

## Two ways in

**CLI** (no server needed; edits still appear live in an open editor):

```bash
A="node bin/artifex.js -p myproject --as my-agent"   # --as = name shown in the history
$A changes          # what changed since you last looked (e.g. by the user in the browser)
$A layers           # canvas, selection, paths, and layers (top first) with ids like L3
$A import photo.jpg --fit
$A add text "Hello" --x 40 --y 40 --size 64 --color '#ffffff'
$A levels photo.jpg --auto
$A export preview.png            # then look at the PNG
$A op '[{"type":"layer.update","id":"L2","props":{"opacity":0.5}}]'   # any op, or a batch
$A help                          # all commands
```

**HTTP API** (needs `artifex serve`):

```bash
curl -s localhost:4747/api/state                     # doc + history
curl -s localhost:4747/api/ops -H 'content-type: application/json' \
  -d '{"author":"my-agent","op":[
        {"type":"layer.add","layer":{"type":"text","text":"Hello","size":64,"color":"#fff","x":40,"y":40}},
        {"type":"layer.update","id":"Hello","props":{"blend":"overlay"}}]}'
curl -s localhost:4747/api/export -o preview.png       # the rendered image
curl -s --data-binary @photo.jpg 'localhost:4747/api/upload?name=photo.jpg'   # → {"asset": ...}
```

A batch (`"op": [...]`) is applied in order and stops at the first failing op; the error says which one
(`index`), and the ops before it stay applied.

## The loop that works

1. **Look:** `GET /api/state` (or `layers` + `changes`). Layers in `doc.layers` are bottom-first; ids are stable.
2. **Measure before guessing:** `GET /api/histogram?layer=L2` before levels/curves; `GET /api/pick?x=&y=&layer=`
   for exact colors (e.g. a clean source area for heal, or a color to remove).
3. **Edit:** `POST /api/ops` with one op or a batch. Read the returned `text` — it says exactly what happened.
4. **Check:** `GET /api/export` and look at the image. Undo with `{"type":"history.undo"}` if it is wrong.

## Conventions

- Coordinates are canvas pixels, origin top-left. Layer `x`/`y` is the layer's top-left.
- Layers and paths are referenced by id (`L3`, `P1`) or name.
- Adjustments (levels, curves, color balance, hue-chroma, exposure, shadows-highlights, posterize, threshold,
  color to alpha) are per-layer properties set with `layer.update`; set one to `null` to remove it.
  They never change the original pixels.
- Brush, clone, heal, smudge, dodge/burn and path strokes paint onto a **paint layer**
  (`{"type":"layer.add","layer":{"type":"paint","name":"Fix"}}`), so the original stays untouched.
- Painting and fills are limited to the selection when there is one (`selection.none` clears it).
- Paths use SVG path data: `{"type":"path.add","path":{"name":"Arch","d":"M 100 300 C 150 120 450 120 500 300 Z"}}`.
- Structure: groups (`layer.group`, `layer.move` moves a whole group), clipping masks (`clip: true`), adjustment
  layers (`layer.add` type `adjustment`, then set levels/curves/… on it — they affect everything below),
  locks (`locks: {position, pixels, alpha}` — a locked layer rejects those edits with a clear error).
- Masks: `layer.mask` (from the selection) or `layer.maskStroke` (paint hide/reveal). Quick mask: `selection.paint`.
- Transforms: `layer.perspective` (4 corners), `layer.warp` (grid moves), `layer.liquify` (strokes), `distort` prop,
  `text.onPath`; selections: `selection.transform`, `channel.save` / `channel.load`, `selection.scissors` (anchors →
  edge-snapping outline), `selection.foreground` (rough outline → the object), `edit.strokeSelection`.
- Between projects: `{"type":"layer.paste","from":"other-project","ids":["Logo"]}` copies layers, editable.
- Files: `GET /api/export?format=png|jpeg|webp|avif|psd|xcf|pdf|svg`; PSD/XCF come in with `POST /api/upload?name=x.psd`
  then `{"type":"doc.import","src": file}` (one history entry). Image size: `canvas.scale`. Guides: `guide.add`.
- Set `author` (API) or `--as` (CLI) so people can tell your edits apart in the history.

## Several projects

`artifex serve` serves every project in the folder that contains the starting project (or `--root <dir>`).
`GET /api/projects` lists them, `POST /api/projects {"name": "poster", "width": 1080, "height": 1350}` creates one,
and every endpoint takes `?project=<name>` (e.g. `POST /api/ops?project=poster`). The CLI works per project with `-p <dir>`.
