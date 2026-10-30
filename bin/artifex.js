#!/usr/bin/env node
// ImageArtifex CLI: every command is turned into an op and appended to the project's history log.
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { findLayer, findPath, selectionText, BLEND_MODES, ADJUST_DEFAULTS } from '../src/model.js';
import { toSvgPath, anchorCount, pathBounds } from '../src/paths.js';
import { layerSize } from '../src/render.js';
import { CURVE_PRESETS, TONE_CHANNELS, BALANCE_RANGES, BALANCE_AXES, PARAM_SETS, TONE_KEYS, hasTone } from '../src/tone.js';
import { isProject, loadState, undoneSeqs, commit, exportImage, initProject, selectionCanvas, maskStats, layerHistogram, histogramStats, pickColor } from '../src/store.js';
import { serve } from '../src/server.js';
import { openApiSpec, opCatalog } from '../src/opschema.js';

const HELP = `ImageArtifex — layered image editing from the CLI, a browser editor, and a readable change log.

Project:   -p/--project <dir>, or $ARTIFEX_PROJECT, or the current directory
Author:    --as <name>, or $ARTIFEX_AUTHOR (default "cli"); the browser editor records as "user"

Setup
  init [dir] [--width 1200] [--height 800] [--bg #ffffff|none]
  serve [--port 4747] [--root <dir>]      open the browser editor (live-syncs with CLI edits); other projects in
                                          the same folder (or --root) open with File → Open project / ?project=<name>

Inspect
  layers                                  canvas + layer stack (top first) as text
  log [--author A] [--last N] [--json]    full change history in plain English
  changes                                 what others changed since you last ran "changes"
  export <out.png|jpg|webp|avif|psd|xcf|pdf|svg> [--layers a,b] [--transparent] [--quality 92] [--dpi 72]
                                          psd/xcf keep layers/groups; svg keeps shapes/text/gradients as vectors

Add layers
  import <file...> [--x N --y N] [--fit|--cover] [--name S]   each file becomes an image layer
                                          a .psd or .xcf brings in its layers, groups, masks (one history entry) [--resize-canvas]
  add text "<text>" [--x --y --size 48 --color #000 --font sans-serif --weight bold --italic --align left]
                    [--width 400] [--line-height 1.2]     --width makes a paragraph box (text wraps inside it)
  add rect|ellipse [--x --y --w 200 --h 120 --fill #3b82f6 --stroke #000 --stroke-width 2 --radius 0]
  add paint [--name S]                    empty raster layer for strokes
  add adjustment [--name S]               adjustment layer: set levels/curves/balance/... on it (by name) and they
                                          apply to every layer below it (clip it to affect one layer; mask to limit)
  stroke <layer> --points "x,y x,y ..." [--color #000] [--size 8] [--opacity 1] [--hardness 1] [--blend multiply] [--erase]
                                          (points may carry pen pressure: "x,y,0.4 x,y,0.9")
  clone <layer> --from x,y | --offset dx,dy --points "x,y x,y ..." [--size 20] [--hardness 0.75] [--sample merged|<layer>]
  heal  <layer> (same options)            clone pixels from --from onto a paint layer; heal blends them into
                                          the surroundings (GIMP's healing). Points are canvas coordinates.
  smudge <layer> --points "x,y x,y ..." [--size 20] [--hardness 0.75] [--rate 50] [--flow 0 --color #hex] [--sample ...]
                                          drag colors along the stroke (rate 0–100: how far colors are carried)
  dodge|burn <layer> --points "x,y ..." [--range shadows|midtones|highlights] [--exposure 50] [--size 20] [--hardness 0.75]
                                          lighten (dodge) or darken (burn) along the stroke
  blur|sharpen <layer> --points "x,y ..." [--strength N] [--size 20] [--hardness 0.75]   blur (radius px, 4) / sharpen (0–100, 50)

Edit layers   (<layer> = id like L3 or the layer name)
  set <layer> key=value ...               e.g. x=10 opacity=0.5 blend=multiply adjust.brightness=120
  move <layer> <x> <y>    rename <layer> <name>    hide <layer>    show <layer>
  fit <layer> [--cover]   center <layer>           rotate <layer> <deg>   scale <layer> <factor>
  order <layer> top|bottom|up|down|<index>         dup <layer>    remove <layer>
  merge <layer> <layer> ...    merge-down <layer>    flatten
  group <layer> [<layer> ...] [--name S]   ungroup <group>   nudge <layer|group> <dx> <dy>
  text-on-path <text layer> <path> [--offset px] | <text> --offset px | --off   text follows a Pen-tool path
  liquify <layer> --points "x,y ..." [--mode push|twirl|bloat|pinch] [--size 60] [--strength 0.5] | --reset
  distort <layer> --kind lens [--main −100..100] [--edge N] [--zoom N] [--x-shift N] [--y-shift N] [--brighten N]   GIMP lens distortion
  distort <layer> --kind twirl|pinch|ripple|waves [--amount N] [--radius 0-1] [--center 0.5,0.5] [--amplitude 5] [--wavelength 20] [--vertical] | --off
  perspective <layer> --corners "x,y x,y x,y x,y" | --reset    corners TL TR BR BL in canvas px
  warp <layer> [--grid 3x3] --move "i,j:dx,dy ..." | --reset    move warp grid points (i column, j row) by canvas px
  clip <layer> | unclip <layer>           clipping mask: show only where the layer below has pixels
  lock <layer> [--position] [--pixels] [--alpha]   unlock <layer> [...]   (no flags = position + pixels / all)

Select   (--mode replace|add|subtract|intersect, default replace; coordinates are canvas pixels)
  select rect <x> <y> <w> <h>             rectangle select        select ellipse <x> <y> <w> <h>
  select lasso "x,y x,y x,y ..."          free select (polygon)
  select wand <x> <y> [--threshold 32] [--layer L]      fuzzy select (contiguous; default samples merged image)
  select color <x> <y> | --color #hex [--threshold 32]  select by color (all matching pixels)
  select alpha <layer>                    alpha to selection
  select scissors "x,y x,y x,y ..."       intelligent scissors: outline through the anchors, snapping to edges
  select foreground [--outline "x,y ..."] [--paint "x,y ..." --size 15]   object inside a rough outline (or the selection)
  select all | none | invert
  select feather|grow|shrink|border <px>
  select move <dx> <dy>                   move the selection outline (not the pixels)
  select transform [--scale 1.2] [--scale-x N --scale-y N] [--rotate 15] [--about x,y]   rotate / scale the outline
  select save <name>   select load <name> [--mode add]   channels   channel remove <name>   (saved selections)
  select paint --points "x,y ..." [--size 20] [--hardness 0.75] [--subtract]   quick mask: paint the selection
  select info                             describe the current selection and its bounds

Use the selection
  clear <layer>                           erase the selected area from a layer (via layer mask)
  fill [color] [--name S]                 new fill layer covering the selection (or whole canvas)
  bucket <x> <y> [--color #000] [--threshold 32] [--contiguous false] [--layer L]
  copy-layer <layer> | cut-layer <layer>  new layer from the selected part of a layer
  mask <layer> [--hide]                   add layer mask from selection (--hide hides it instead)
  unmask <layer>                          remove a layer's mask
  mask-paint <layer> --points "x,y ..." [--size 20] [--hardness 0.75] [--reveal]   paint the layer mask: hide (default) or reveal
  crop-selection                          crop the canvas to the selection bounds
  paste-from <other project> <layer...> [--in-place]   copy layers (editable) from another project
  stroke-selection [--color #000] [--width 4] [--position center|inside|outside]   draw the selection outline (new layer)
  (brush strokes are limited to the selection; pass --clip false to "stroke" to ignore it)

Paths (Pen tool) — SVG path data: M x y, L x y, H x, V y, C x1 y1 x2 y2 x y, S, Q, T, Z (lowercase = relative)
  path add "<d>" [--name S]               e.g. path add "M 100 100 C 150 40 250 40 300 100 L 300 200 Z" --name Arch
  path list [--json]                      every path with its SVG data, anchors and bounds
  path set <path> "<d>" | --name S | --move dx,dy
  path select <path> [--mode replace|add|subtract|intersect]   path → selection
  path stroke <path> [--color #000] [--size 4] [--layer <paint layer>]   brush line along the path
  path fill <path> [--color #000]          fill the inside (new fill layer)
  path remove <path>

Gradients & tones
  gradient <x1> <y1> <x2> <y2> [--from #000] [--to #fff|transparent] [--type linear|radial] [--name S]
                                          new gradient layer (limited to the selection, if any)
  levels <layer> [--channel value|r|g|b] [--in 0,255] [--gamma 1] [--out 0,255]
  levels <layer> --auto | --reset         auto-stretch each channel / remove all levels
  curves <layer> [--channel value|r|g|b] --points "0,0 128,160 255,255" | --preset ${Object.keys(CURVE_PRESETS).join('|')} | --reset
  balance <layer> [--range shadows|midtones|highlights] [--cyan-red N] [--magenta-green N] [--yellow-blue N]
                  [--preserve true|false] | --reset-range | --reset
                                          color balance (GIMP's formula), values -100..100, default range midtones
  threshold <layer> [--low 127] [--high 255] [--channel value|r|g|b] | --off
  posterize <layer> <levels 2-256> | --off
  shadows-highlights <layer> [--shadows N] [--highlights N] [--whitepoint N] [--radius 100] [--compress 50]
                     [--shadows-color 100] [--highlights-color 50] | --off
                                          GIMP's shadows-highlights: shadows/highlights -100..100, white point -10..10
  exposure <layer> [--stops N] [--black-level N] | --off
                                          GIMP's exposure: stops -10..10 (+1 = twice the light), black level -0.1..0.1
  hue-chroma <layer> [--hue N] [--chroma N] [--lightness N] | --off
                                          GIMP's hue-chroma (CIE LCh): hue -180..180°, chroma/lightness -100..100
  unsharp <layer> [--radius 3] [--amount 0.5] [--threshold 0] | --off   sharpen (GIMP unsharp mask)
  denoise <layer> [--strength 30] [--radius 2] | --off                  edge-preserving noise reduction
  high-pass <layer> [--radius 4] | --off                                detail only, around gray (use with overlay blend)
  pixelate <layer> [--size 16] | --off                                  GIMP pixelize (block average)
  emboss <layer> [--azimuth 30] [--elevation 45] [--depth 20] [--keep-color 1] | --off   GIMP emboss / bump map
  color-to-alpha <layer> [--color #fff | --at x,y] [--transparency 0] [--opacity 1] | --off
                                          make a color transparent (GIMP's formula); --at samples it from the layer
  histogram [layer]                       per-channel min / 1% / mean / 99% / max (merged image if no layer)
  pick <x> <y> [--layer L] [--json]       color at a point: merged image, or a layer before/after its adjustments
  tone <layer> [--json]                   all of a layer's tone settings, including curve points
  (order applied: noise reduction → unsharp → high pass → shadows-highlights → exposure → levels → curves → color balance → hue-chroma → posterize
   → threshold → color to alpha)

Canvas
  canvas <w> <h> [--anchor center|top-left|...]    crop <x> <y> <w> <h>    bg <color|none>
  image-size <w> [<h>] | --percent 50     resample the whole image (layers stay non-destructive)
  guide add x|y <pos>   guide remove x|y <pos>   guide clear   guides (list)

History
  undo    redo    op '<json op or array>'  (use "-" to read JSON from stdin)    ops (op reference)

For AI agents / tools
  ops --json                              every op with its JSON Schema and an example
  openapi [file] [--server URL]           OpenAPI 3.1 description of the HTTP API (also GET /api/openapi.json)
  (see AGENTS.md)

Blend modes: ${BLEND_MODES.join(', ')}
Adjustments: ${Object.entries(ADJUST_DEFAULTS).map(([k, v]) => `${k}(${v})`).join(', ')}`;

const OPS_HELP = `Raw ops for "artifex op" (layer refs may be ids or names):
  {"type":"canvas.new","width":1200,"height":800,"background":"#fff"}
  {"type":"canvas.resize","width":1600,"height":900,"anchor":"center"}
  {"type":"canvas.crop","x":0,"y":0,"width":800,"height":600}
  {"type":"canvas.background","color":"#000000"}            (null = transparent)
  {"type":"layer.add","layer":{"type":"image","src":"photo.jpg","x":0,"y":0}}
  {"type":"layer.add","layer":{"type":"text","text":"Hi","size":64,"color":"#fff","x":40,"y":40}}
  {"type":"layer.add","layer":{"type":"shape","shape":"ellipse","w":100,"h":100,"fill":"#f00"}}
  {"type":"layer.add","layer":{"type":"paint","name":"Sketch"}}
  {"type":"layer.update","id":"L2","props":{"x":10,"opacity":0.5,"adjust":{"contrast":130}}}
  {"type":"layer.remove","id":"L2"}     {"type":"layer.duplicate","id":"L2"}
  {"type":"layer.reorder","id":"L2","index":"top"}
  {"type":"layer.group","ids":["L2","L3"],"name":"Logo"}   {"type":"layer.ungroup","id":"Logo"}   {"type":"layer.move","id":"Logo","dx":20,"dy":0}
  {"type":"layer.update","id":"L4","props":{"clip":true,"locks":{"position":true},"parent":"L5"}}
  {"type":"layer.merge","ids":["L1","L2"]}   {"type":"layer.merge","down":"L2"}   {"type":"layer.merge","flatten":true}
  {"type":"paint.stroke","id":"Sketch","stroke":{"color":"#000","size":6,"points":[[0,0],[50,50]]}}
  {"type":"selection.set","mode":"add","shape":{"type":"rect","x":10,"y":10,"w":100,"h":50}}
     shapes: rect/ellipse {x,y,w,h} · polygon {points} · wand {x,y,threshold,contiguous,layer}
             color {x,y | color:"#hex", threshold} · alpha {layer} · all
  {"type":"selection.all"}  {"type":"selection.none"}  {"type":"selection.invert"}
  {"type":"selection.modify","kind":"feather|grow|shrink|border","radius":5}
  {"type":"edit.clear","id":"L2"}   {"type":"edit.fill","color":"#ff0000"}
  {"type":"edit.bucket","x":10,"y":10,"color":"#ff0000","threshold":32,"contiguous":true,"sample":"L2"}
  {"type":"layer.fromSelection","id":"L2","cut":false}
  {"type":"layer.mask","id":"L2","mode":"keep|hide"}   {"type":"layer.unmask","id":"L2"}
  {"type":"canvas.crop","toSelection":true}
  {"type":"edit.gradient","kind":"linear|radial","x1":0,"y1":0,"x2":800,"y2":0,"from":"#000","to":"transparent"}
  {"type":"layer.update","id":"L2","props":{"levels":{"value":{"inLow":20,"inHigh":235,"gamma":1.2,"outLow":0,"outHigh":255}}}}
  {"type":"layer.update","id":"L2","props":{"curves":{"value":[[0,0],[128,160],[255,255]],"r":null}}}   (null resets)
  {"type":"layer.autoLevels","id":"L2"}
  {"type":"layer.update","id":"L2","props":{"colorBalance":{"shadows":{"cyanRed":-20,"yellowBlue":15},"preserveLuminosity":true}}}
  {"type":"layer.update","id":"L2","props":{"threshold":{"low":100,"high":255,"channel":"value"}}}   (null = off)
  {"type":"layer.update","id":"L2","props":{"posterize":4}}   (null = off)
  {"type":"layer.update","id":"L2","props":{"shadowsHighlights":{"shadows":40,"highlights":-30,"radius":100,"compress":50}}}   (null = off)
  {"type":"layer.update","id":"L2","props":{"exposure":{"stops":0.5,"blackLevel":0.01}}}   (null = off)
  {"type":"layer.update","id":"L2","props":{"hueChroma":{"hue":30,"chroma":-20,"lightness":5}}}   (null = off)
  {"type":"paint.clone","id":"L3","points":[[100,100],[140,100]],"from":[300,100],"size":20,"hardness":0.75,"sample":"merged"}
  {"type":"paint.heal","id":"L3","points":[[100,100]],"offset":[200,0],"size":30}   (same options as paint.clone)
  {"type":"path.add","path":{"name":"Arch","d":"M 100 100 C 150 40 250 40 300 100 Z"}}   (or "subpaths":[{"closed":true,"anchors":[{"x":0,"y":0,"in":[x,y],"out":[x,y]}]}])
  {"type":"path.update","id":"P1","props":{"d":"M ...","name":"New"},"dx":0,"dy":0}   {"type":"path.remove","id":"P1"}
  {"type":"path.select","id":"P1","mode":"replace"}   {"type":"path.fill","id":"P1","color":"#ff0000"}
  {"type":"path.stroke","id":"P1","color":"#000000","size":4,"layer":"L3"}   (no layer = new paint layer)
  {"type":"paint.smudge","id":"L3","points":[[100,100],[160,100]],"size":20,"rate":50,"flow":0,"color":"#000000"}
  {"type":"paint.dodge","id":"L3","points":[[100,100],[160,100]],"range":"midtones","exposure":50}   (paint.burn the same)
  {"type":"layer.colorToAlpha","id":"L2","at":[10,10],"transparency":0,"opacity":1}   (or "color":"#ffffff")
  {"type":"layer.update","id":"L2","props":{"colorToAlpha":{"color":"#ffffff","transparency":0.1,"opacity":0.9}}}   (null = off)
  {"type":"history.undo"}   {"type":"history.redo"}
Common layer props: name visible opacity(0-1) blend x y rotation scaleX scaleY adjust{...}
  text: text font size weight color align   shape: shape w h fill stroke strokeWidth radius`;

const BOOLEAN_FLAGS = new Set(['in-place', 'vertical', 'resize-canvas', 'italic', 'subtract', 'reveal', 'position', 'pixels', 'alpha', 'all', 'fit', 'cover', 'transparent', 'erase', 'json', 'help', 'hide', 'auto', 'reset', 'off', 'reset-range']);

function parseArgs(argv) {
  const pos = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split(/=(.*)/s);
      const next = argv[i + 1];
      if (inline !== undefined) flags[k] = inline;
      else if (BOOLEAN_FLAGS.has(k)) flags[k] = true;
      else if (next !== undefined && (!next.startsWith('-') || /^-\d/.test(next))) { flags[k] = next; i++; }
      else flags[k] = true;
    } else if (a === '-p') flags.project = argv[++i];
    else pos.push(a);
  }
  return { pos, flags };
}

const pointsFlag = v => {
  const pts = String(v).trim().split(/\s+/).map(q => q.split(',').map(Number));
  if (!pts.every(q => q.length === 2 && q.every(Number.isFinite))) throw new Error('--points needs "x,y x,y ..."');
  return pts;
};
const num = v => (v === undefined ? undefined : Number(v));
function value(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === 'none') return null;
  if (v !== '' && !Number.isNaN(Number(v))) return Number(v);
  return v;
}
const clean = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

function projectDir(flags, required = true) {
  const dir = path.resolve(flags.project || process.env.ARTIFEX_PROJECT || '.');
  if (required && !isProject(dir)) throw new Error(`${dir} is not an ImageArtifex project. Run "artifex init <dir>" or pass -p <dir>.`);
  return dir;
}

const measureCtx = createCanvas(1, 1).getContext('2d');
const fmt = n => Math.round(n * 10) / 10;

function layerLine(l, depth = 0) {
  const tags = [l.clip ? 'clipped to the layer below' : '', l.locks ? `locked: ${Object.keys(l.locks).join(', ')}` : ''].filter(Boolean);
  const indent = '    '.repeat(depth) + (l.clip ? '↳ ' : '');
  if (l.type === 'group') {
    const g = [l.opacity !== 1 ? `opacity ${Math.round(l.opacity * 100)}%` : '', l.blend !== 'normal' ? `blend ${l.blend}` : '', ...tags, l.visible ? '' : '[hidden]'].filter(Boolean);
    return `  ${indent}${l.id.padEnd(4)} "${l.name}" — group${g.length ? `, ${g.join(', ')}` : ''}`;
  }
  const { w, h } = layerSize(l, measureCtx);
  const detail = {
    image: () => `image ${l.w}×${l.h}`, fill: () => `fill ${l.color}`,
    gradient: () => `${l.kind} gradient ${l.stops.map(s => s[1]).join(' → ')} (${l.x1},${l.y1})→(${l.x2},${l.y2})`, text: () => `text "${l.text}" ${l.size}px ${l.weight} ${l.color}`,
    shape: () => `${l.shape} fill ${l.fill ?? 'none'}${l.stroke ? ` stroke ${l.stroke} ${l.strokeWidth}px` : ''}`, paint: () => `paint, ${l.strokes.length} strokes`,
  }[l.type]();
  const extras = [
    `at (${fmt(l.x)}, ${fmt(l.y)})`, `size ${fmt(w * Math.abs(l.scaleX))}×${fmt(h * Math.abs(l.scaleY))}`,
    l.scaleX !== 1 || l.scaleY !== 1 ? `scale ${fmt(l.scaleX)}×${fmt(l.scaleY)}` : '',
    l.rotation ? `rotated ${fmt(l.rotation)}°` : '',
    l.opacity !== 1 ? `opacity ${Math.round(l.opacity * 100)}%` : '',
    l.blend !== 'normal' ? `blend ${l.blend}` : '',
    Object.entries(l.adjust).filter(([k, v]) => v !== ADJUST_DEFAULTS[k]).map(([k, v]) => `${k}=${v}`).join(' '),
    l.levels ? `levels(${Object.keys(l.levels).join(',')})` : '',
    l.curves ? `curves(${Object.keys(l.curves).join(',')})` : '',
    hasTone({ colorBalance: l.colorBalance }) ? `color balance ${BALANCE_RANGES.filter(r => l.colorBalance[r])
      .map(r => `${r}(${BALANCE_AXES.map(a => l.colorBalance[r][a] || 0).join('/')})`).join(' ')}${l.colorBalance.preserveLuminosity === false ? '' : ' preserve'}` : '',
    l.shadowsHighlights ? `shadows-highlights ${l.shadowsHighlights.shadows}/${l.shadowsHighlights.highlights}` : '',
    l.exposure ? `exposure ${l.exposure.stops} stops${l.exposure.blackLevel ? ` black ${l.exposure.blackLevel}` : ''}` : '',
    l.hueChroma ? `hue-chroma ${l.hueChroma.hue}°/${l.hueChroma.chroma}/${l.hueChroma.lightness}` : '',
    l.posterize ? `posterize ${l.posterize}` : '',
    l.threshold ? `threshold ${l.threshold.low}-${l.threshold.high}` : '',
    l.colorToAlpha ? `color to alpha ${l.colorToAlpha.color}` : '',
    l.mask?.length ? `masked (${l.mask.map(m => m.mode).join(', ')})` : '',
    ...tags,
    l.visible ? '' : '[hidden]',
  ].filter(Boolean);
  return `  ${indent}${l.id.padEnd(4)} "${l.name}" — ${detail}, ${extras.join(', ')}`;
}

function printEntry(e, undone) {
  const t = e.ts.replace('T', ' ').slice(0, 19);
  console.log(`#${String(e.seq).padEnd(4)} ${t}  ${e.author.padEnd(7)} ${e.text}${undone?.has(e.seq) ? '  (undone)' : ''}`);
}

function fitProps(doc, l, cover) {
  const { w, h } = layerSize(l, measureCtx);
  const s = (cover ? Math.max : Math.min)(doc.width / w, doc.height / h);
  return { scaleX: s, scaleY: s, x: (doc.width - w * s) / 2, y: (doc.height - h * s) / 2 };
}

async function main() {
  const { pos: [cmd, ...pos], flags } = parseArgs(process.argv.slice(2));
  const author = flags.as || process.env.ARTIFEX_AUTHOR || 'cli';

  if (!cmd || cmd === 'help' || flags.help) return console.log(HELP);
  if (cmd === 'ops') {
    if (flags.json) return console.log(JSON.stringify(opCatalog(), null, 2));
    return console.log(OPS_HELP);
  }
  if (cmd === 'openapi') {
    // The API description for sharing with any agent or tool; also served at GET /api/openapi.json.
    const spec = JSON.stringify(openApiSpec({ server: flags.server || 'http://127.0.0.1:4747' }), null, 2) + '\n';
    if (!pos[0]) return process.stdout.write(spec);
    fs.writeFileSync(path.resolve(pos[0]), spec);
    return console.log(`Wrote ${path.resolve(pos[0])} (OpenAPI 3.1, ${opCatalog().length} ops)`);
  }
  if (cmd === 'init') {
    const dir = path.resolve(pos[0] || flags.project || '.');
    const bg = flags.bg === undefined ? '#ffffff' : value(flags.bg);
    const e = await initProject(dir, { width: num(flags.width) ?? 1200, height: num(flags.height) ?? 800, background: bg });
    return console.log(`Created project in ${dir}\n✔ #${e.seq} ${e.text}`);
  }

  const dir = projectDir(flags);
  const run = async op => { const e = await commit(dir, op, author); console.log(`✔ #${e.seq} ${e.text}`); return e; };
  const doc = () => loadState(dir).doc;
  const ref = r => findLayer(doc(), r).id;
  const update = (r, props) => run({ type: 'layer.update', id: ref(r), props });

  switch (cmd) {
    case 'serve':
      return serve(dir, { port: num(flags.port) ?? 4747, ...(flags.root ? { root: path.resolve(flags.root) } : {}) });

    case 'layers': case 'info': {
      const d = doc();
      console.log(`Canvas ${d.width}×${d.height}, background ${d.background ?? 'transparent'} — ${d.layers.length} layer(s), top first:`);
      console.log(`Selection: ${selectionText(d.selection)}`);
      if (d.paths?.length) console.log(`Paths: ${d.paths.map(p => `${p.id} "${p.name}"`).join(', ')} (see "path list")`);
      // top first, group contents indented under their group
      const walk = (pid, depth) => { for (const l of d.layers.filter(l => (l.parent ?? null) === pid).reverse()) { console.log(layerLine(l, depth)); if (l.type === 'group') walk(l.id, depth + 1); } };
      walk(null, 0);
      return;
    }
    case 'log': {
      const state = loadState(dir), undone = undoneSeqs(state);
      let entries = state.entries;
      if (flags.author) entries = entries.filter(e => e.author === flags.author);
      if (flags.last) entries = entries.slice(-Number(flags.last));
      if (flags.json) return console.log(JSON.stringify(entries, null, 2));
      return entries.forEach(e => printEntry(e, undone));
    }
    case 'changes': {
      const marker = path.join(dir, `.seen-${author}`);
      const seen = fs.existsSync(marker) ? Number(fs.readFileSync(marker, 'utf8')) : 0;
      const state = loadState(dir), undone = undoneSeqs(state);
      const fresh = state.entries.filter(e => e.seq > seen && e.author !== author);
      if (!fresh.length) console.log(`No changes by others since #${seen}.`);
      else { console.log(`Changes by others since #${seen}:`); fresh.forEach(e => printEntry(e, undone)); }
      fs.writeFileSync(marker, String(state.entries.at(-1)?.seq ?? 0));
      return;
    }
    case 'export': {
      if (!pos[0]) throw new Error('Usage: export <out.png>');
      const r = await exportImage(dir, path.resolve(pos[0]), {
        layers: flags.layers ? String(flags.layers).split(',') : undefined, transparent: !!flags.transparent, quality: num(flags.quality), dpi: num(flags.dpi),
      });
      console.log(`Exported ${r.width}×${r.height} to ${path.resolve(pos[0])} (${Math.round(r.bytes / 1024)} KB)`);
      for (const n of r.notes || []) console.log(`  note: ${n}`);
      return;
    }

    case 'import': {
      if (!pos.length) throw new Error('Usage: import <file...>');
      for (const file of pos) {
        if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
        const fit = flags.cover ? 'cover' : flags.fit ? 'contain' : undefined;
        if (/\.(psd|xcf)$/i.test(file)) { await run(clean({ type: 'doc.import', src: path.resolve(file), resize: flags['resize-canvas'] ? true : undefined })); continue; }
        await run({ type: 'layer.add', layer: clean({ type: 'image', src: path.resolve(file), fit, name: flags.name, x: num(flags.x), y: num(flags.y) }) });
      }
      return;
    }
    case 'add': {
      const [kind, text] = pos;
      const common = { name: flags.name, x: num(flags.x), y: num(flags.y), opacity: num(flags.opacity), blend: flags.blend };
      if (kind === 'text') return run({ type: 'layer.add', layer: clean({ ...common, type: 'text', text: text ?? 'Text', size: num(flags.size), color: flags.color, font: flags.font,
        weight: flags.weight, align: flags.align, italic: flags.italic || undefined, boxWidth: num(flags.width), lineHeight: num(flags['line-height']) }) });
      if (kind === 'rect' || kind === 'ellipse') return run({ type: 'layer.add', layer: clean({ ...common, type: 'shape', shape: kind, w: num(flags.w), h: num(flags.h), fill: flags.fill === undefined ? undefined : value(flags.fill), stroke: flags.stroke, strokeWidth: num(flags['stroke-width']), radius: num(flags.radius) }) });
      if (kind === 'paint') return run({ type: 'layer.add', layer: clean({ ...common, type: 'paint' }) });
      if (kind === 'adjustment') return run({ type: 'layer.add', layer: clean({ ...common, type: 'adjustment', name: flags.name ?? 'Adjustment' }) });
      throw new Error('Usage: add text|rect|ellipse|paint|adjustment');
    }
    case 'stroke': {
      if (!pos[0] || !flags.points) throw new Error('Usage: stroke <layer> --points "x,y x,y ..."');
      const points = String(flags.points).trim().split(/\s+/).map(p => p.split(',').map(Number)); // x,y or x,y,pressure
      const stroke = clean({ color: flags.color || '#000000', size: num(flags.size) ?? 8, erase: !!flags.erase, points,
        opacity: num(flags.opacity), hardness: num(flags.hardness), blend: flags.blend });
      if (flags.clip === 'false') stroke.clip = false;
      return run({ type: 'paint.stroke', id: pos[0], stroke });
    }

    case 'clone': case 'heal': {
      if (!pos[0] || !flags.points || (!flags.from && !flags.offset)) {
        throw new Error(`Usage: ${cmd} <layer> --from x,y | --offset dx,dy --points "x,y x,y ..." [--size 20] [--hardness 0.75] [--sample merged|<layer>]`);
      }
      const pair = v => { const p = String(v).split(',').map(Number); if (p.length !== 2 || !p.every(Number.isFinite)) throw new Error(`Expected x,y but got "${v}"`); return p; };
      const points = String(flags.points).trim().split(/\s+/).map(pair);
      return run(clean({ type: `paint.${cmd}`, id: pos[0], points, from: flags.from && pair(flags.from), offset: flags.offset && pair(flags.offset),
        size: num(flags.size), hardness: num(flags.hardness), sample: flags.sample }));
    }

    case 'smudge': case 'dodge': case 'burn': case 'blur': case 'sharpen': {
      if (!pos[0] || !flags.points) throw new Error(`Usage: ${cmd} <layer> --points "x,y x,y ..." (see "artifex help")`);
      const points = String(flags.points).trim().split(/\s+/).map(q => q.split(',').map(Number));
      if (!points.every(q => q.length === 2 && q.every(Number.isFinite))) throw new Error('--points needs "x,y x,y ..."');
      return run(clean({ type: `paint.${cmd}`, id: pos[0], points, size: num(flags.size), hardness: num(flags.hardness), sample: flags.sample,
        rate: num(flags.rate), flow: num(flags.flow), color: flags.color, range: flags.range, exposure: num(flags.exposure), strength: num(flags.strength) }));
    }

    case 'group': {
      if (!pos.length) throw new Error('Usage: group <layer> [<layer> ...] [--name S]');
      return run(clean({ type: 'layer.group', ids: pos, name: flags.name }));
    }
    case 'ungroup': return run({ type: 'layer.ungroup', id: pos[0] });
    case 'clip': case 'unclip': return update(pos[0], { clip: cmd === 'clip' });
    case 'lock': case 'unlock': {
      const kinds = ['position', 'pixels', 'alpha'].filter(k => flags[k]), all = flags.all || !kinds.length;
      if (cmd === 'unlock' && all) return update(pos[0], { locks: null });
      return update(pos[0], { locks: Object.fromEntries((all ? ['position', 'pixels'] : kinds).map(k => [k, cmd === 'lock'])) });
    }
    case 'text-on-path': {
      if (flags.off) return update(pos[0], { path: null });
      if (pos[1] === undefined && flags.offset !== undefined) return update(pos[0], { path: { offset: Number(flags.offset) } });
      if (!pos[0] || !pos[1]) throw new Error('Usage: text-on-path <text layer> <path> [--offset px] | <text layer> --offset px | --off');
      return run(clean({ type: 'text.onPath', id: pos[0], path: pos[1], offset: num(flags.offset) }));
    }
    case 'liquify': {
      if (flags.reset) return update(pos[0], { liquify: null });
      if (!pos[0] || !flags.points) throw new Error('Usage: liquify <layer> --points "x,y x,y ..." [--mode push|twirl|bloat|pinch] [--size 60] [--strength 0.5] | --reset');
      return run({ type: 'layer.liquify', id: pos[0], stroke: clean({ mode: flags.mode, points: pointsFlag(flags.points), size: num(flags.size), strength: num(flags.strength) }) });
    }
    case 'distort': {
      if (flags.off) return update(pos[0], { distort: null });
      if (!pos[0]) throw new Error('Usage: distort <layer> --kind twirl|pinch|ripple|waves [--amount N] [--radius 0-1] [--center x,y (0-1)] [--amplitude px] [--wavelength px] [--vertical] | --off');
      const [centerX, centerY] = flags.center ? String(flags.center).split(',').map(Number) : [];
      return update(pos[0], { distort: clean({ kind: flags.kind, amount: num(flags.amount), radius: num(flags.radius), centerX, centerY,
        main: num(flags.main), edge: num(flags.edge), zoom: num(flags.zoom), xShift: num(flags['x-shift']), yShift: num(flags['y-shift']), brighten: num(flags.brighten),
        amplitude: num(flags.amplitude), wavelength: num(flags.wavelength), orientation: flags.vertical ? 'vertical' : flags.kind === 'ripple' ? 'horizontal' : undefined }) });
    }
    case 'perspective': {
      if (flags.reset) return update(pos[0], { mesh: null });
      if (!pos[0] || !flags.corners) throw new Error('Usage: perspective <layer> --corners "x,y x,y x,y x,y" (TL TR BR BL) | --reset');
      return run({ type: 'layer.perspective', id: pos[0], corners: pointsFlag(flags.corners) });
    }
    case 'warp': {
      if (flags.reset) return update(pos[0], { mesh: null });
      if (!pos[0]) throw new Error('Usage: warp <layer> [--grid 3x3] --move "i,j:dx,dy i,j:dx,dy" | --reset');
      const [cols, rows] = flags.grid ? String(flags.grid).split(/x/i).map(Number) : [];
      const moves = String(flags.move || '').trim().split(/\s+/).filter(Boolean).map(m => { const [ij, d] = m.split(':'); const [i, j] = ij.split(',').map(Number), [dx, dy] = d.split(',').map(Number); return { i, j, dx, dy }; });
      return run(clean({ type: 'layer.warp', id: pos[0], cols, rows, moves }));
    }
    case 'nudge': return run({ type: 'layer.move', id: pos[0], dx: Number(pos[1] ?? 0), dy: Number(pos[2] ?? 0) });

    case 'set': {
      if (pos.length < 2) throw new Error('Usage: set <layer> key=value ...');
      const props = {};
      for (const kv of pos.slice(1)) {
        const [k, v] = kv.split(/=(.*)/s);
        if (v === undefined) throw new Error(`Expected key=value, got "${kv}"`);
        if (k.startsWith('adjust.')) (props.adjust ||= {})[k.slice(7)] = value(v);
        else props[k] = value(v);
      }
      return update(pos[0], props);
    }
    case 'move': return update(pos[0], { x: Number(pos[1]), y: Number(pos[2]) });
    case 'rename': return update(pos[0], { name: pos.slice(1).join(' ') });
    case 'hide': return update(pos[0], { visible: false });
    case 'show': return update(pos[0], { visible: true });
    case 'rotate': return update(pos[0], { rotation: Number(pos[1]) });
    case 'scale': return update(pos[0], { scaleX: Number(pos[1]), scaleY: Number(pos[2] ?? pos[1]) });
    case 'fit': return update(pos[0], fitProps(doc(), findLayer(doc(), pos[0]), !!flags.cover));
    case 'center': {
      const d = doc(), l = findLayer(d, pos[0]), { w, h } = layerSize(l, measureCtx);
      return update(l.id, { x: (d.width - w * Math.abs(l.scaleX)) / 2, y: (d.height - h * Math.abs(l.scaleY)) / 2 });
    }
    case 'order': return run({ type: 'layer.reorder', id: pos[0], index: pos[1] });
    case 'dup': case 'duplicate': return run({ type: 'layer.duplicate', id: pos[0], name: flags.name });
    case 'remove': case 'rm': return run({ type: 'layer.remove', id: pos[0] });
    case 'merge': return run({ type: 'layer.merge', ids: pos, name: flags.name });
    case 'merge-down': return run({ type: 'layer.merge', down: pos[0], name: flags.name });
    case 'flatten': return run({ type: 'layer.merge', flatten: true, name: flags.name });

    case 'path': case 'paths': {
      const sub = cmd === 'paths' ? 'list' : pos[0], a = pos.slice(1);
      const need = what => { if (!a[0]) throw new Error(`Usage: path ${sub} <path> ${what}`.trim()); return a[0]; };
      switch (sub) {
        case 'list': case undefined: {
          const ps = doc().paths || [];
          if (flags.json) return console.log(JSON.stringify(ps.map(p => ({ ...p, d: toSvgPath(p.subpaths) })), null, 2));
          if (!ps.length) return console.log('No paths. Draw one with the Pen tool (P) or "path add".');
          for (const p of ps) {
            const b = pathBounds(p.subpaths).map(v => Math.round(v));
            console.log(`  ${p.id.padEnd(4)} "${p.name}" — ${anchorCount(p.subpaths)} anchors, ${p.subpaths.every(sp => sp.closed) ? 'closed' : 'open'}, bounds ${b[2]}×${b[3]} at (${b[0]}, ${b[1]})\n       d="${toSvgPath(p.subpaths)}"`);
          }
          return;
        }
        case 'add':
          if (!a[0]) throw new Error('Usage: path add "<svg path data>" [--name S]');
          return run(clean({ type: 'path.add', path: clean({ d: a.join(' '), name: flags.name }) }));
        case 'set': {
          const id = need('"<d>" | --name S | --move dx,dy'), props = clean({ d: a[1], name: flags.name });
          const [dx, dy] = flags.move ? String(flags.move).split(',').map(Number) : [];
          if (!Object.keys(props).length && !flags.move) throw new Error('Give new path data, --name, or --move dx,dy');
          return run(clean({ type: 'path.update', id, props, dx, dy }));
        }
        case 'select': return run(clean({ type: 'path.select', id: need('[--mode replace]'), mode: flags.mode }));
        case 'stroke': return run(clean({ type: 'path.stroke', id: need('[--color #000] [--size 4] [--layer L]'), color: flags.color, size: num(flags.size), layer: flags.layer, clip: flags.clip === 'false' ? false : undefined }));
        case 'fill': return run(clean({ type: 'path.fill', id: need('[--color #000]'), color: flags.color, name: flags.name }));
        case 'remove': case 'rm': return run({ type: 'path.remove', id: need('') });
        default: throw new Error(`Unknown path command "${sub}" (add, list, set, select, stroke, fill, remove)`);
      }
    }
    case 'select': {
      const [kind, ...a] = pos, mode = flags.mode, n = i => Number(a[i]);
      const set = shape => run(clean({ type: 'selection.set', mode, shape }));
      switch (kind) {
        case 'rect': case 'ellipse':
          if (a.length < 4) throw new Error(`Usage: select ${kind} <x> <y> <w> <h>`);
          return set({ type: kind, x: n(0), y: n(1), w: n(2), h: n(3) });
        case 'lasso': case 'polygon': case 'free': {
          if (!a[0]) throw new Error('Usage: select lasso "x,y x,y x,y ..."');
          return set({ type: 'polygon', points: a.join(' ').trim().split(/\s+/).map(p => p.split(',').map(Number)) });
        }
        case 'wand': case 'fuzzy':
          if (a.length < 2) throw new Error('Usage: select wand <x> <y>');
          return set(clean({ type: 'wand', x: n(0), y: n(1), threshold: num(flags.threshold), layer: flags.layer, contiguous: flags.contiguous === 'false' ? false : undefined }));
        case 'color':
          if (!flags.color && a.length < 2) throw new Error('Usage: select color <x> <y>  or  select color --color #hex');
          return set(clean({ type: 'color', x: a.length ? n(0) : undefined, y: a.length ? n(1) : undefined, color: flags.color, threshold: num(flags.threshold), layer: flags.layer }));
        case 'alpha': return set({ type: 'alpha', layer: a[0] });
        case 'all': return run({ type: 'selection.all' });
        case 'none': return run({ type: 'selection.none' });
        case 'invert': return run({ type: 'selection.invert' });
        case 'move': return run({ type: 'selection.translate', dx: n(0) || 0, dy: n(1) || 0 });
        case 'scissors': return run(clean({ type: 'selection.scissors', anchors: pointsFlag(a.join(' ')), mode, layer: flags.layer }));
        case 'foreground': return run(clean({ type: 'selection.foreground', outline: flags.outline ? pointsFlag(flags.outline) : undefined,
          strokes: flags.paint ? [{ points: pointsFlag(flags.paint), size: num(flags.size) ?? 15 }] : undefined, mode, layer: flags.layer }));
        case 'transform': return run(clean({ type: 'selection.transform', scale: num(flags.scale), scaleX: num(flags['scale-x']), scaleY: num(flags['scale-y']),
          rotate: num(flags.rotate), about: flags.about ? String(flags.about).split(',').map(Number) : undefined }));
        case 'save': return run({ type: 'channel.save', name: a[0] });
        case 'load': return run(clean({ type: 'channel.load', name: a[0], mode }));
        case 'paint': {
          if (!flags.points) throw new Error('Usage: select paint --points "x,y x,y ..." [--size 20] [--hardness 0.75] [--subtract]');
          return run({ type: 'selection.paint', mode: flags.subtract ? 'subtract' : 'add', stroke: clean({ points: pointsFlag(flags.points), size: num(flags.size), hardness: num(flags.hardness) }) });
        }
        case 'feather': case 'grow': case 'shrink': case 'border':
          return run({ type: 'selection.modify', kind, radius: n(0) });
        case 'info': case undefined: {
          const d = doc();
          if (!d.selection) return console.log('Selection: nothing');
          const { bbox, area } = maskStats(await selectionCanvas(dir, d, d.selection));
          console.log(`Selection: ${selectionText(d.selection)}`);
      if (d.paths?.length) console.log(`Paths: ${d.paths.map(p => `${p.id} "${p.name}"`).join(', ')} (see "path list")`);
          return console.log(bbox ? `Bounds ${bbox[2]}×${bbox[3]} at (${bbox[0]}, ${bbox[1]}), ${area} px (${(100 * area / (d.width * d.height)).toFixed(1)}% of canvas)` : 'The selection is empty.');
        }
        default: throw new Error('Usage: select rect|ellipse|lasso|wand|color|alpha|all|none|invert|feather|grow|shrink|border|info');
      }
    }
    case 'paste-from': {
      if (pos.length < 2) throw new Error('Usage: paste-from <project dir|name> <layer> [<layer> ...] [--in-place]');
      return run({ type: 'layer.paste', from: path.resolve(pos[0]), ids: pos.slice(1), inPlace: !!flags['in-place'] });
    }
    case 'stroke-selection': return run(clean({ type: 'edit.strokeSelection', color: flags.color, width: num(flags.width), position: flags.position, name: flags.name }));
    case 'clear': return run({ type: 'edit.clear', id: pos[0] });
    case 'fill': return run(clean({ type: 'edit.fill', color: pos[0] || flags.color || '#000000', name: flags.name }));
    case 'bucket':
      if (pos.length < 2) throw new Error('Usage: bucket <x> <y> [--color #hex]');
      return run(clean({ type: 'edit.bucket', x: Number(pos[0]), y: Number(pos[1]), color: flags.color || '#000000', threshold: num(flags.threshold), contiguous: flags.contiguous === 'false' ? false : undefined, sample: flags.layer, name: flags.name }));
    case 'copy-layer': return run(clean({ type: 'layer.fromSelection', id: pos[0], name: flags.name }));
    case 'cut-layer': return run(clean({ type: 'layer.fromSelection', id: pos[0], cut: true, name: flags.name }));
    case 'mask': return run({ type: 'layer.mask', id: pos[0], mode: flags.hide ? 'hide' : 'keep' });
    case 'unmask': return run({ type: 'layer.unmask', id: pos[0] });
    case 'mask-paint': {
      if (!pos[0] || !flags.points) throw new Error('Usage: mask-paint <layer> --points "x,y x,y ..." [--size 20] [--hardness 0.75] [--reveal]');
      return run({ type: 'layer.maskStroke', id: pos[0], mode: flags.reveal ? 'reveal' : 'hide', stroke: clean({ points: pointsFlag(flags.points), size: num(flags.size), hardness: num(flags.hardness) }) });
    }
    case 'crop-selection': return run({ type: 'canvas.crop', toSelection: true });

    case 'gradient': {
      if (pos.length < 4) throw new Error('Usage: gradient <x1> <y1> <x2> <y2> [--from #hex] [--to #hex|transparent] [--type linear|radial]');
      const [x1, y1, x2, y2] = pos.map(Number);
      return run(clean({ type: 'edit.gradient', kind: flags.type, x1, y1, x2, y2, from: flags.from, to: flags.to, name: flags.name }));
    }
    case 'levels': {
      if (!pos[0]) throw new Error('Usage: levels <layer> [--in lo,hi] [--gamma g] [--out lo,hi] | --auto | --reset');
      if (flags.auto) return run({ type: 'layer.autoLevels', id: pos[0] });
      if (flags.reset) return update(pos[0], { levels: null });
      const ch = flags.channel || 'value', pair = v => String(v).split(',').map(Number), lv = {};
      if (flags.in) [lv.inLow, lv.inHigh] = pair(flags.in);
      if (flags.out) [lv.outLow, lv.outHigh] = pair(flags.out);
      if (flags.gamma) lv.gamma = Number(flags.gamma);
      if (!Object.keys(lv).length) throw new Error('Give at least one of --in, --gamma, --out (or --auto / --reset)');
      const cur = findLayer(doc(), pos[0]).levels?.[ch] || {};
      return update(pos[0], { levels: { [ch]: { ...cur, ...lv } } });
    }
    case 'curves': {
      if (!pos[0]) throw new Error('Usage: curves <layer> --points "x,y x,y ..." | --preset name | --reset');
      if (flags.reset && !flags.channel) return update(pos[0], { curves: null });
      const ch = flags.channel || 'value';
      if (!TONE_CHANNELS.includes(ch)) throw new Error(`--channel must be one of ${TONE_CHANNELS.join(', ')}`);
      if (flags.reset) return update(pos[0], { curves: { [ch]: null } });
      const points = flags.preset ? CURVE_PRESETS[flags.preset] : flags.points && String(flags.points).trim().split(/\s+/).map(p => p.split(',').map(Number));
      if (!points) throw new Error(flags.preset ? `Unknown preset "${flags.preset}" (${Object.keys(CURVE_PRESETS).join(', ')})` : 'Give --points or --preset');
      return update(pos[0], { curves: { [ch]: points } });
    }
    case 'balance': {
      if (!pos[0]) throw new Error('Usage: balance <layer> [--range midtones] [--cyan-red N] [--magenta-green N] [--yellow-blue N]');
      if (flags.reset) return update(pos[0], { colorBalance: null });
      const range = flags.range || 'midtones', shift = {};
      if (flags['reset-range']) return update(pos[0], { colorBalance: { [range]: null } });
      for (const [flag, axis] of [['cyan-red', 'cyanRed'], ['magenta-green', 'magentaGreen'], ['yellow-blue', 'yellowBlue']]) {
        if (flags[flag] !== undefined) shift[axis] = Number(flags[flag]);
      }
      const props = {};
      if (Object.keys(shift).length) props[range] = shift;
      if (flags.preserve !== undefined) props.preserveLuminosity = flags.preserve !== 'false';
      if (!Object.keys(props).length) throw new Error('Give --cyan-red, --magenta-green, --yellow-blue, --preserve, or --reset');
      return update(pos[0], { colorBalance: props });
    }
    case 'threshold': {
      if (!pos[0]) throw new Error('Usage: threshold <layer> [--low 127] [--high 255] [--channel value] | --off');
      if (flags.off) return update(pos[0], { threshold: null });
      return update(pos[0], { threshold: clean({ low: num(flags.low) ?? 127, high: num(flags.high) ?? 255, channel: flags.channel }) });
    }
    case 'posterize': {
      if (!pos[0] || (!flags.off && pos[1] === undefined)) throw new Error('Usage: posterize <layer> <levels> | --off');
      return update(pos[0], { posterize: flags.off ? null : Number(pos[1]) });
    }
    case 'shadows-highlights': case 'exposure': case 'hue-chroma': case 'unsharp': case 'denoise': case 'high-pass': case 'pixelate': case 'emboss': {
      // One flag per setting: shadowsColor → --shadows-color, blackLevel → --black-level, ...
      const key = { 'shadows-highlights': 'shadowsHighlights', exposure: 'exposure', 'hue-chroma': 'hueChroma', unsharp: 'sharpen', denoise: 'denoise', 'high-pass': 'highPass', pixelate: 'pixelate', emboss: 'emboss' }[cmd];
      const flagOf = k => `--${k.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`, params = Object.keys(PARAM_SETS[key]);
      if (!pos[0]) throw new Error(`Usage: ${cmd} <layer> ${params.map(k => `[${flagOf(k)} N]`).join(' ')} | --off`);
      if (flags.off) return update(pos[0], { [key]: null });
      const props = {};
      for (const k of params) if (flags[flagOf(k).slice(2)] !== undefined) props[k] = Number(flags[flagOf(k).slice(2)]);
      if (!Object.keys(props).length) throw new Error(`Give at least one of ${params.map(flagOf).join(', ')}, or --off`);
      return update(pos[0], { [key]: props });
    }
    case 'color-to-alpha': {
      if (!pos[0]) throw new Error('Usage: color-to-alpha <layer> [--color #fff | --at x,y] [--transparency 0] [--opacity 1] | --off');
      if (flags.off) return update(pos[0], { colorToAlpha: null });
      // --at x,y  or  --at x y
      const at = flags.at !== undefined && (String(flags.at).includes(',') ? String(flags.at).split(',') : [flags.at, pos[1]]).map(Number);
      if (at && !at.every(Number.isFinite)) throw new Error('--at needs a point: --at x,y');
      return run(clean({ type: 'layer.colorToAlpha', id: ref(pos[0]), at: at || undefined, color: flags.color, transparency: num(flags.transparency), opacity: num(flags.opacity) }));
    }
    case 'pick': {
      if (pos[1] === undefined) throw new Error('Usage: pick <x> <y> [--layer L] [--json]');
      const p = await pickColor(dir, doc(), Number(pos[0]), Number(pos[1]), { layer: flags.layer });
      if (flags.json) return console.log(JSON.stringify(p, null, 2));
      const line = c => `${c.hex}  rgb(${c.r}, ${c.g}, ${c.b})  alpha ${c.alpha}  value ${c.value}  lightness ${c.lightness}`;
      if (p.image) return console.log(`(${p.x}, ${p.y}) merged image: ${line(p.image)}`);
      console.log(`(${p.x}, ${p.y}) layer "${p.layer.name}" (${p.layer.id}):\n  before adjustments: ${line(p.before)}\n  after adjustments:  ${line(p.after)}`);
      return;
    }
    case 'tone': {
      if (!pos[0]) throw new Error('Usage: tone <layer> [--json]');
      const l = findLayer(doc(), pos[0]), t = Object.fromEntries(TONE_KEYS.filter(k => l[k] != null).map(k => [k, l[k]]));
      if (flags.json) return console.log(JSON.stringify(t, null, 2));
      console.log(`Tone settings of layer "${l.name}" (${l.id}), in the order applied:`);
      if (!Object.keys(t).length) return console.log('  none');
      const kv = o => Object.entries(o).map(([k, v]) => `${k} ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ');
      for (const k of TONE_KEYS) {
        if (!t[k]) continue;
        if (k === 'curves') for (const [ch, pts] of Object.entries(t[k])) console.log(`  curves (${ch}): points ${pts.map(q => q.join(',')).join('  ')}`);
        else if (k === 'levels') for (const [ch, lv] of Object.entries(t[k])) console.log(`  levels (${ch}): ${kv(lv)}`);
        else console.log(`  ${k}: ${typeof t[k] === 'object' ? kv(t[k]) : t[k]}`);
      }
      return;
    }
    case 'histogram': {
      const d = doc(), h = await layerHistogram(dir, d, pos[0]);
      console.log(`Histogram of ${pos[0] ? `layer "${findLayer(d, pos[0]).name}" (before its levels/curves)` : 'the merged image'}, ${h.count} visible px:`);
      for (const [c, st] of Object.entries(histogramStats(h))) console.log(`  ${c.padEnd(6)} min ${st.min}  1% ${st.p1}  mean ${st.mean}  99% ${st.p99}  max ${st.max}`);
      return;
    }
    case 'image-size': {
      if (!pos[0] && flags.percent == null) throw new Error('Usage: image-size <width> [<height>] | --percent 50');
      return run(clean({ type: 'canvas.scale', width: num(pos[0]), height: num(pos[1]), percent: num(flags.percent) }));
    }
    case 'channels': case 'channel': {
      if (cmd === 'channel' && (pos[0] === 'remove' || pos[0] === 'rm')) return run({ type: 'channel.remove', name: pos[1] });
      const ch = doc().channels || [];
      return console.log(ch.length ? ch.map(c => `  "${c.name}" — ${c.item.shape.bbox ? `${c.item.shape.bbox[2]}×${c.item.shape.bbox[3]} at (${c.item.shape.bbox[0]}, ${c.item.shape.bbox[1]})` : 'empty'}`).join('\n') : 'No saved channels. Save one with "select save <name>".');
    }
    case 'guide': case 'guides': {
      const [sub, a, b] = pos;
      if (sub === 'add') return run({ type: 'guide.add', axis: a, pos: Number(b) });
      if (sub === 'remove' || sub === 'rm') return run({ type: 'guide.remove', axis: a, pos: Number(b) });
      if (sub === 'clear') return run({ type: 'guide.clear' });
      const g = doc().guides || [];
      return console.log(g.length ? g.map((q, i) => `  ${i}: ${q.axis === 'x' ? 'vertical' : 'horizontal'} at ${q.axis} = ${q.pos}`).join('\n') : 'No guides.');
    }
    case 'canvas': return run({ type: 'canvas.resize', width: Number(pos[0]), height: Number(pos[1]), anchor: flags.anchor });
    case 'crop': return run({ type: 'canvas.crop', x: Number(pos[0]), y: Number(pos[1]), width: Number(pos[2]), height: Number(pos[3]) });
    case 'bg': return run({ type: 'canvas.background', color: value(pos[0] ?? 'none') });

    case 'undo': return run({ type: 'history.undo' });
    case 'redo': return run({ type: 'history.redo' });
    case 'op': {
      const src = pos[0] === '-' || !pos[0] ? fs.readFileSync(0, 'utf8') : pos[0];
      const parsed = JSON.parse(src);
      for (const op of Array.isArray(parsed) ? parsed : [parsed]) await run(op);
      return;
    }
    default:
      throw new Error(`Unknown command "${cmd}". Run "artifex help".`);
  }
}

main().catch(err => { console.error(`✖ ${err.message}`); process.exit(1); });
