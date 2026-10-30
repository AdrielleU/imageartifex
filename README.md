<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.svg">
    <img src="docs/logo.svg" alt="ImageArtifex" width="360">
  </picture>
</p>

# ImageArtifex

**A flexible, local take on Photoshop, Affinity and GIMP: a layered image editor that runs in your
browser on your own computer, using your CPU or GPU.**

Edit by hand in a familiar layout (tools on the left, layers and properties on the right), or prompt
an AI to do it: Claude, or any model you run on your own computer. Tell it "put the logo top-right and
boost the contrast" and watch the change appear live in the editor. Everything the editor can do is
available from a CLI and an HTTP API (with an OpenAPI description), so any agent or script can drive it,
and every change, by you or the AI, is recorded as a readable line of text.

> **Check out [GIMP](https://www.gimp.org/) first.** It is the mature, free image editor, and ImageArtifex
> owes it a lot. This project is **not a fork** of GIMP, Photoshop or Affinity and contains none of their
> code; we took the big idea and the roadmap from them (see [GIMP-PARITY.md](GIMP-PARITY.md)) and wrote
> our own implementation, built around being scriptable and prompt-driven. Where it matches GIMP's results
> (color balance, curves, heal, shadows-highlights, …), it reimplements the published formulas.

```
#16  user    Layer "landscape.png": contrast 100% → 130%; saturate 100% → 140%
#17  claude  Merged layers "landscape.png", "sun.png" into "sun.png (merged)" (L8)
#18  claude  Undo #17: Merged layers "landscape.png", "sun.png" into "sun.png (merged)" (L8)
```

## Quick start

```bash
npm install
node bin/artifex.js init myproject --width 1200 --height 800
node bin/artifex.js -p myproject serve          # open http://127.0.0.1:4747
```

In another terminal (or ask Claude Code to do it):

```bash
A="node bin/artifex.js -p myproject --as claude"
$A import photo.jpg logo.png --fit       # each file becomes a layer
$A set logo.png blend=screen opacity=0.8 adjust.brightness=120
$A add text "Summer Sale" --x 60 --y 40 --size 72 --color "#fff" --weight bold
$A select wand 400 300 --threshold 40   # magic wand, like GIMP's fuzzy select
$A select grow 4 && $A cut-layer photo.jpg  # move the selected object to its own layer
$A merge-down logo.png
$A export out.png
$A log                                   # full history in plain English
$A changes                               # what the *user* changed since Claude last checked
```

`node bin/artifex.js help` lists every command; `node bin/artifex.js ops` shows the raw JSON ops.

## Prompting it with an AI

Run the editor, then point your AI at this folder: Claude Code, or any local model or agent that can run
shell commands or call HTTP APIs. Give it [AGENTS.md](AGENTS.md) and [docs/openapi.json](docs/openapi.json),
and prompt it like you'd brief a designer: *"cut the person out of photo.jpg, put them on the beach
background, warm up the highlights and add a title along the top curve."* It edits through the same
operations you use, so you can keep working by hand at the same time, undo anything it did, and read the
history to see exactly what changed. Nothing leaves your computer.

## What's in it

- **Layers:** image, text (point, paragraph, on a path), shapes, paint, fills, gradients, groups, clipping
  masks, adjustment layers, layer masks you can paint, locks, blend modes
- **Selections:** rectangle, ellipse, lasso, magic wand, by color, intelligent scissors, foreground select,
  quick mask, saved channels; feather, grow, shrink, move, rotate and scale the outline
- **Tools:** move/transform with handles, perspective, warp, crop, brush (pressure, opacity, hardness),
  eraser, clone, heal, smudge, dodge/burn, blur/sharpen, liquify, gradient, bucket, Pen tool paths
- **Colors and filters (non-destructive):** levels, curves, color balance, hue-chroma, exposure,
  shadows-highlights, threshold, posterize, color to alpha, unsharp mask, noise reduction, high pass,
  pixelate, emboss, twirl/pinch/ripple/waves, lens distortion
- **Files:** PNG, JPEG, WebP, AVIF, PSD and GIMP XCF (with layers), PDF, SVG; several projects open at once
- **Workspace:** rulers, guides, grid, snapping, light and dark themes, one- or two-column toolbar

## API

Everything the browser does goes through `POST /api/ops` with `{"op": {...}}`, the same JSON ops the
CLI writes (`artifex ops` lists them). `GET /api/state` returns the document and history;
`GET /api/events` streams change notifications; `GET /api/export?format=png` renders the image;
`GET /api/pick?x=&y=[&layer=]` returns the color at a point.

## How it works

- A project is a folder: `history.jsonl` (append-only op log, the source of truth), `assets/`
  (imported images), `state.json` (current document, regenerated on each change).
- The document is rebuilt by replaying the log, so everything is non-destructive and undoable.
- The same Canvas 2D renderer runs in the browser and in Node, so exports match what you see.
- See `GIMP-PARITY.md` for which GIMP features exist and what's next.

## Performance / GPU

The browser editor draws with the canvas, which uses your GPU when hardware acceleration is on, and runs
color adjustments as WebGL2 shaders on a real GPU. The badge in the top-right shows which GPU is in use
(hover for details); if it says "software", turn on hardware acceleration (Chrome: `chrome://gpu`, Settings →
System → "Use graphics acceleration when available"). `?gpu=0` forces the CPU path, `?gpu=1` forces shaders.
To use your own machine's GPU with a remote server: `ssh -L 4747:127.0.0.1:4747 you@server`, then open
http://localhost:4747 locally.

## For AI agents and tools

See [AGENTS.md](AGENTS.md). The HTTP API is described in [docs/openapi.json](docs/openapi.json) (OpenAPI 3.1; also served at
`/api/openapi.json`), and `artifex ops --json` lists every op with its JSON Schema and an example.
