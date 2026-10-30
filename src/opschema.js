// The op catalog: every op a client (CLI, browser, HTTP API, any AI agent) can send, with a JSON Schema,
// a summary and an example. The OpenAPI file (`artifex openapi`, GET /api/openapi.json) and `artifex ops --json`
// are generated from it; test/opschema.test.js checks that every op the code handles is listed here.
// Layer and path references accept an id ("L3", "P1") or a name.

const num = (description, extra = {}) => ({ type: 'number', description, ...extra });
const int = (description, extra = {}) => ({ type: 'integer', description, ...extra });
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const bool = description => ({ type: 'boolean', description });
const color = (description = 'CSS color, e.g. "#ff8800"') => ({ type: 'string', description });
const ref = (what = 'layer') => ({ type: 'string', description: `${what === 'layer' ? 'Layer' : 'Path'} id (e.g. "${what === 'layer' ? 'L3' : 'P1'}") or name` });
const point = { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: '[x, y] in canvas pixels' };
const points = { type: 'array', items: point, minItems: 1, description: 'Stroke points [[x, y], ...] in canvas pixels' };
const refJ = name => ({ $ref: `#/components/schemas/${name}` });

const BLEND = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light',
  'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'];
const CHANNELS = ['value', 'r', 'g', 'b'];
const RANGES = ['shadows', 'midtones', 'highlights'];

// Shared component schemas (referenced as #/components/schemas/<Name>).
export const COMPONENTS = {
  Point: point,
  Levels: {
    type: 'object', description: 'Levels for one channel (0–255).',
    properties: { inLow: num('Input black', { minimum: 0, maximum: 255 }), inHigh: num('Input white', { minimum: 0, maximum: 255 }),
      gamma: num('Midtone gamma', { exclusiveMinimum: 0 }), outLow: num('Output black'), outHigh: num('Output white') },
  },
  Curve: { type: 'array', items: point, minItems: 2, description: 'Curve control points [[in, out], ...] (0–255), monotone cubic through them' },
  LayerProps: {
    type: 'object', additionalProperties: true,
    description: 'Layer properties. Common ones are listed; type-specific ones (text: text/font/size/weight/color/align; shape: shape/w/h/fill/stroke/strokeWidth/radius; fill: color; gradient: kind/x1/y1/x2/y2/stops) are accepted too. A tone property set to null removes it.',
    properties: {
      name: str('Display name'), visible: bool('Shown or hidden'), opacity: num('0–1', { minimum: 0, maximum: 1 }),
      blend: { type: 'string', enum: BLEND, description: 'Blend mode' },
      x: num('Left edge in canvas px'), y: num('Top edge in canvas px'), rotation: num('Degrees, about the layer centre'),
      scaleX: num('Horizontal scale (negative flips)'), scaleY: num('Vertical scale (negative flips)'),
      parent: { type: ['string', 'null'], description: 'Group id to put the layer in (null = top level)' },
      clip: bool('Clipping mask: only show where the nearest unclipped layer below has pixels'),
      distort: { type: ['object', 'null'], description: 'Distort filter (GIMP Distorts / Lens Distortion); null removes', properties: { kind: { type: 'string', enum: ['twirl', 'pinch', 'ripple', 'waves', 'lens'] },
        main: num('lens: −100 (pincushion) … 100 (barrel)'), edge: num('lens −100…100'), zoom: num('lens −100…100'), xShift: num('lens −100…100'), yShift: num('lens −100…100'), brighten: num('lens −100…100'),
        amount: num('twirl: degrees; pinch: −1 (bulge) … 1 (pinch)'), radius: num('0–1 of the layer (1)'), centerX: num('0–1 (0.5)'), centerY: num('0–1 (0.5)'),
        amplitude: num('ripple/waves px (5)'), wavelength: num('ripple/waves px (20)'), orientation: { type: 'string', enum: ['horizontal', 'vertical'] } } },
      liquify: { type: 'null', description: 'Set to null to remove all liquify strokes' },
      path: { type: ['object', 'null'], description: 'Text on a path (set with text.onPath); {offset} moves the text along it; null = normal text' },
      mesh: { type: ['object', 'null'], description: 'Perspective / warp mesh in layer coordinates (use layer.perspective / layer.warp to set it in canvas px); null removes',
        properties: { kind: { type: 'string', enum: ['perspective', 'warp'] }, cols: int(''), rows: int(''), points: { type: 'array', items: point } } },
      locks: { type: ['object', 'null'], description: 'Locks; null unlocks all', properties: { position: bool('No moving/transforming'), pixels: bool('No painting/clearing'), alpha: bool('Paint only where there are pixels already') } },
      adjust: { type: 'object', description: 'CSS-filter style adjustments', properties: {
        brightness: num('% (100 = unchanged)'), contrast: num('% (100)'), saturate: num('% (100)'), hue: num('degrees (0)'), blur: num('px (0)'),
        grayscale: num('% (0)'), sepia: num('% (0)'), invert: num('% (0)') } },
      levels: { type: ['object', 'null'], description: 'Per channel: { value|r|g|b: Levels | null }', properties: Object.fromEntries(CHANNELS.map(c => [c, { oneOf: [refJ('Levels'), { type: 'null' }] }])) },
      curves: { type: ['object', 'null'], description: 'Per channel: { value|r|g|b: Curve | null }', properties: Object.fromEntries(CHANNELS.map(c => [c, { oneOf: [refJ('Curve'), { type: 'null' }] }])) },
      colorBalance: { type: ['object', 'null'], description: 'GIMP color balance; values -100..100 per range',
        properties: { ...Object.fromEntries(RANGES.map(r => [r, { type: ['object', 'null'], properties: { cyanRed: num(''), magentaGreen: num(''), yellowBlue: num('') } }])), preserveLuminosity: bool('Keep lightness (default true)') } },
      hueChroma: { type: ['object', 'null'], description: 'GIMP hue-chroma (CIE LCh)', properties: { hue: num('-180..180°'), chroma: num('-100..100'), lightness: num('-100..100') } },
      exposure: { type: ['object', 'null'], description: 'GIMP exposure (linear light)', properties: { stops: num('-10..10'), blackLevel: num('-0.1..0.1') } },
      shadowsHighlights: { type: ['object', 'null'], description: 'GIMP shadows-highlights', properties: {
        shadows: num('-100..100'), highlights: num('-100..100'), whitepoint: num('-10..10'), radius: num('0.1..1500 px (100)'),
        compress: num('0..100 (50)'), shadowsColor: num('0..100 (100)'), highlightsColor: num('0..100 (50)') } },
      sharpen: { type: ['object', 'null'], description: 'Unsharp mask (GIMP)', properties: { radius: num('0.1–100 px (3)'), amount: num('0–10 (0.5)'), threshold: num('0–255 (0)') } },
      denoise: { type: ['object', 'null'], description: 'Noise reduction (edge-preserving)', properties: { strength: num('0–100 (30)'), radius: num('1–10 px (2)') } },
      highPass: { type: ['object', 'null'], description: 'High pass: detail around mid-gray', properties: { radius: num('0.5–100 px (4)') } },
      pixelate: { type: ['object', 'null'], description: 'Pixelize (GIMP)', properties: { size: num('block size px 1–512 (16)') } },
      emboss: { type: ['object', 'null'], description: 'Emboss (GIMP)', properties: { azimuth: num('0–360° (30)'), elevation: num('0–180° (45)'), depth: num('1–100 (20)'), keepColor: num('0 = gray relief, 1 = bump map') } },
      posterize: { type: ['integer', 'null'], minimum: 2, maximum: 256, description: 'Levels per channel' },
      threshold: { type: ['object', 'null'], properties: { low: num('0–255'), high: num('0–255'), channel: { type: 'string', enum: CHANNELS } } },
      colorToAlpha: { type: ['object', 'null'], description: 'GIMP color to alpha', properties: { color: color(), transparency: num('0–1 (0)'), opacity: num('0–1 (1)') } },
    },
  },
  Layer: {
    type: 'object', required: ['type'], additionalProperties: true,
    description: 'A new layer. image: give "src" (a file path on the server) or "asset" (from POST /api/upload). paint: an empty layer for strokes.',
    properties: {
      type: { type: 'string', enum: ['image', 'text', 'shape', 'paint', 'fill', 'gradient', 'group', 'adjustment'],
        description: 'adjustment: holds tone/filter props (levels, curves, ...) that apply to every layer below it' },
      src: str('image: file path on the server to import'), asset: str('image: uploaded asset name'),
      fit: { type: 'string', enum: ['contain', 'cover'], description: 'image: scale to the canvas' },
      name: str('Display name'), x: num(''), y: num(''),
      text: str('text: the text (\\n for new lines)'), size: num('text: font size px'), font: str('text: font family'), color: color('text / fill color'),
      boxWidth: num('text: paragraph width px (text wraps inside it)'), italic: bool('text: italic'), lineHeight: num('text: line spacing × size (1.2)'),
      weight: str('text: normal, bold, 300, 600, ...'), align: { type: 'string', enum: ['left', 'center', 'right'] },
      shape: { type: 'string', enum: ['rect', 'ellipse'] }, w: num('shape width'), h: num('shape height'), fill: color('shape fill'),
    },
  },
  SelectionShape: {
    type: 'object', required: ['type'],
    description: 'rect/ellipse {x,y,w,h}; polygon {points}; path {subpaths}; wand {x,y,threshold?,contiguous?,layer?} (fuzzy select); color {x,y | color, threshold?, layer?} (select by color); alpha {layer}; all.',
    properties: {
      type: { type: 'string', enum: ['rect', 'ellipse', 'polygon', 'path', 'wand', 'color', 'alpha', 'all'] },
      x: num(''), y: num(''), w: num(''), h: num(''), points: { type: 'array', items: point },
      threshold: num('0–255 color distance (32)'), contiguous: bool('wand: only connected pixels (true)'), layer: ref(), color: color(),
      subpaths: refJ('Subpaths'),
    },
  },
  Subpaths: {
    type: 'array', description: 'Bezier path: anchors with optional absolute handle positions (in/out); a missing handle is a sharp corner.',
    items: { type: 'object', required: ['anchors'], properties: {
      closed: { type: 'boolean' },
      anchors: { type: 'array', minItems: 1, items: { type: 'object', required: ['x', 'y'], properties: { x: num(''), y: num(''), in: point, out: point } } } } },
  },
  Entry: {
    type: 'object', description: 'One history entry: the op as stored (names resolved to ids, files imported) and its plain-English text.',
    properties: { seq: int('Sequence number'), ts: str('ISO time'), author: str('Who made it (user, claude, cli, ...)'), op: { type: 'object' }, text: str('Plain-English description') },
  },
};

// Brush options shared by the retouching ops.
const brush = { size: num('Brush diameter px (20)'), hardness: num('0–1 edge hardness (0.75)'), sample: str('"merged" (default) or a layer to sample') };
const source = { from: point, offset: { ...point, description: '[dx, dy] = source − destination' } };

// op type → { summary, properties, required, example }
export const OPS = {
  'canvas.new': { summary: 'Start the document (written by "artifex init"; normally not sent by clients)',
    properties: { width: int(''), height: int(''), background: { type: ['string', 'null'] } }, required: ['width', 'height'], example: { width: 1200, height: 800, background: '#ffffff' } },
  'canvas.resize': { summary: 'Change the canvas size; layers keep their place relative to the anchor',
    properties: { width: int(''), height: int(''), anchor: { type: 'string', enum: ['center', 'top-left', 'top', 'top-right', 'left', 'right', 'bottom-left', 'bottom', 'bottom-right'] } },
    required: ['width', 'height'], example: { width: 1600, height: 900, anchor: 'center' } },
  'canvas.crop': { summary: 'Crop the canvas to a rectangle, or to the selection bounds',
    properties: { x: int(''), y: int(''), width: int(''), height: int(''), toSelection: bool('Crop to the selection bounds instead') }, example: { x: 0, y: 0, width: 800, height: 600 } },
  'layer.paste': { summary: 'Paste layers from another project (or this one), editable, with their masks, adjustments and images',
    properties: { from: str('Project folder name in the same workspace, or a path (default: this project)'), ids: { type: 'array', items: ref(), minItems: 1 },
      inPlace: bool('Keep coordinates (default: keep their place relative to the canvas centre)') }, required: ['ids'], example: { from: 'poster', ids: ['Logo'] } },
  'doc.import': { summary: 'Import a layered file (PSD or GIMP XCF): its layers, groups, masks, opacity and blend modes, in one step', properties: {
    src: str('Path on the server (absolute or relative to the project; POST /api/upload?name=x.psd returns one)'), resize: bool('Set the canvas to the file size (default: only when the project is empty)'), name: str('File name to show in the history') },
    required: ['src'], example: { src: 'imports/3f2a9c1b7d4e.psd' } },
  'canvas.scale': { summary: 'Image size: resample everything to a new size (a missing side keeps the aspect ratio)',
    properties: { width: int(''), height: int(''), percent: num('e.g. 50 = half size') }, example: { percent: 50 } },
  'guide.add': { summary: 'Add a guide line (x = vertical line at that x; y = horizontal line)', properties: { axis: { type: 'string', enum: ['x', 'y'] }, pos: num('px') }, required: ['axis', 'pos'], example: { axis: 'x', pos: 300 } },
  'guide.remove': { summary: 'Remove a guide (by index, or by axis + pos)', properties: { index: int('0-based'), axis: { type: 'string', enum: ['x', 'y'] }, pos: num('') }, example: { axis: 'x', pos: 300 } },
  'guide.clear': { summary: 'Remove all guides', properties: {}, example: {} },
  'canvas.background': { summary: 'Set the background color (null = transparent)', properties: { color: { type: ['string', 'null'] } }, example: { color: '#000000' } },

  'layer.add': { summary: 'Add a layer (image, text, shape, paint, fill, gradient)', properties: { layer: refJ('Layer'), index: int('Stack position (0 = bottom); default top') }, required: ['layer'],
    example: { layer: { type: 'text', text: 'Hello', size: 64, color: '#ffffff', x: 40, y: 40 } } },
  'layer.update': { summary: 'Change layer properties: position, transform, opacity, blend, adjustments, tone', properties: { id: ref(), props: refJ('LayerProps') }, required: ['id', 'props'],
    example: { id: 'L2', props: { x: 10, opacity: 0.5, levels: { value: { inLow: 20, inHigh: 235 } } } } },
  'layer.remove': { summary: 'Delete a layer (a group is deleted with its contents)', properties: { id: ref() }, required: ['id'], example: { id: 'L2' } },
  'layer.group': { summary: 'Put layers into a new group (at the position of the topmost one)', properties: { ids: { type: 'array', items: ref(), minItems: 1 }, name: str('') }, required: ['ids'], example: { ids: ['L2', 'L3'], name: 'Logo' } },
  'layer.ungroup': { summary: 'Remove a group, keeping its layers', properties: { id: ref() }, required: ['id'], example: { id: 'Logo' } },
  'layer.move': { summary: 'Move a layer, or everything in a group, by (dx, dy)', properties: { id: ref(), dx: num('px'), dy: num('px') }, required: ['id'], example: { id: 'Logo', dx: 20, dy: -10 } },
  'layer.duplicate': { summary: 'Duplicate a layer', properties: { id: ref(), name: str(''), dx: num('offset'), dy: num('offset') }, required: ['id'], example: { id: 'L2', dx: 20, dy: 0 } },
  'layer.reorder': { summary: 'Move a layer in the stack', properties: { id: ref(), index: { oneOf: [int('0 = bottom'), { type: 'string', enum: ['top', 'bottom', 'up', 'down'] }] } }, required: ['id', 'index'], example: { id: 'L2', index: 'top' } },
  'layer.merge': { summary: 'Merge layers into one image layer: ids, merge down, or flatten everything',
    properties: { ids: { type: 'array', items: ref() }, down: ref(), flatten: bool('Merge every layer and the background'), name: str('') }, example: { down: 'L3' } },
  'layer.mask': { summary: 'Add a layer mask from the selection (keep = show only the selection, hide = hide it)', properties: { id: ref(), mode: { type: 'string', enum: ['keep', 'hide'] } }, required: ['id'], example: { id: 'L2', mode: 'keep' } },
  'layer.maskStroke': { summary: 'Paint on a layer mask: hide along the stroke, or reveal (creates the mask if needed)', properties: { id: ref(), mode: { type: 'string', enum: ['hide', 'reveal'] },
    stroke: { type: 'object', required: ['points'], properties: { points, size: num('px (20)'), hardness: num('0–1 (0.75)') } } }, required: ['id', 'mode', 'stroke'],
    example: { id: 'Photo', mode: 'hide', stroke: { points: [[100, 100], [160, 140]], size: 50, hardness: 0.3 } } },
  'layer.unmask': { summary: "Remove a layer's masks", properties: { id: ref() }, required: ['id'], example: { id: 'L2' } },
  'layer.fromSelection': { summary: 'Copy (or cut) the selected part of a layer to a new layer', properties: { id: ref(), cut: bool('Remove it from the source (cut)'), name: str('') }, required: ['id'], example: { id: 'L2', cut: false } },
  'text.onPath': { summary: 'Put a text layer on a path (its own copy; rotation/scale reset); offset its start, or remove with props {path: null}',
    properties: { id: ref(), path: ref('path'), offset: num('px along the path (0)') }, required: ['id', 'path'], example: { id: 'Title', path: 'Arch', offset: 10 } },
  'layer.liquify': { summary: 'Liquify stroke (push / twirl / bloat / pinch) — non-destructive, reset with props {liquify: null}', properties: { id: ref(),
    stroke: { type: 'object', required: ['points'], properties: { mode: { type: 'string', enum: ['push', 'twirl', 'bloat', 'pinch'] }, points, size: num('px (60)'), strength: num('0–1 (0.5)') } },
    space: { type: 'string', enum: ['canvas', 'layer'], description: 'Coordinates of points/size (canvas)' } }, required: ['id', 'stroke'],
    example: { id: 'Face', stroke: { mode: 'push', points: [[200, 200], [230, 200]], size: 80, strength: 0.6 } } },
  'layer.perspective': { summary: 'Perspective transform: put the layer\'s corners at these canvas points', properties: { id: ref(),
    corners: { type: 'array', items: point, minItems: 4, maxItems: 4, description: 'Top-left, top-right, bottom-right, bottom-left (canvas px)' } }, required: ['id', 'corners'],
    example: { id: 'Poster', corners: [[120, 80], [480, 40], [500, 360], [100, 330]] } },
  'layer.warp': { summary: 'Warp: move points of a grid over the layer (creates a cols×rows grid if needed)', properties: { id: ref(), cols: int('1–8 (3)'), rows: int('1–8 (3)'),
    moves: { type: 'array', items: { type: 'object', properties: { i: int('column 0..cols'), j: int('row 0..rows'), dx: num('canvas px'), dy: num('canvas px') } } } }, required: ['id'],
    example: { id: 'Flag', cols: 3, rows: 2, moves: [{ i: 1, j: 1, dx: 0, dy: 30 }, { i: 2, j: 1, dx: 0, dy: -30 }] } },
  'layer.autoLevels': { summary: 'GIMP-style auto levels (stretch each channel, clipping 0.5%)', properties: { id: ref() }, required: ['id'], example: { id: 'L2' } },
  'layer.colorToAlpha': { summary: 'GIMP color to alpha; "at" samples the color from the layer', properties: { id: ref(), color: color(), at: point, transparency: num('0–1'), opacity: num('0–1') }, required: ['id'], example: { id: 'L2', at: [10, 10] } },

  'selection.set': { summary: 'Select (rect, ellipse, polygon, path, fuzzy/wand, by color, layer alpha, all)', properties: { mode: { type: 'string', enum: ['replace', 'add', 'subtract', 'intersect'] }, shape: refJ('SelectionShape') }, required: ['shape'],
    example: { mode: 'replace', shape: { type: 'ellipse', x: 100, y: 100, w: 300, h: 200 } } },
  'selection.all': { summary: 'Select everything', properties: {}, example: {} },
  'selection.none': { summary: 'Deselect', properties: {}, example: {} },
  'selection.invert': { summary: 'Invert the selection', properties: {}, example: {} },
  'selection.scissors': { summary: 'Intelligent scissors: an outline through these anchors that snaps to edges', properties: { anchors: { type: 'array', items: point, minItems: 3 },
    mode: { type: 'string', enum: ['replace', 'add', 'subtract', 'intersect'] }, layer: ref() }, required: ['anchors'], example: { anchors: [[120, 80], [300, 70], [320, 260], [110, 250]] } },
  'selection.foreground': { summary: 'Foreground select: separate the object from its background inside a rough outline (or the current selection)',
    properties: { outline: { type: 'array', items: point, description: 'Rough polygon around the object (default: the current selection)' },
      strokes: { type: 'array', items: { type: 'object', properties: { points, size: num('px (10)') } }, description: 'Optional: strokes painted on the object' },
      mode: { type: 'string', enum: ['replace', 'add', 'subtract', 'intersect'] }, layer: ref() },
    example: { outline: [[90, 60], [340, 50], [350, 280], [80, 290]], strokes: [{ points: [[200, 150], [240, 180]], size: 20 }] } },
  'selection.transform': { summary: 'Rotate / scale the selection outline (about its centre unless "about" is given), or apply a matrix',
    properties: { scale: num('Both axes (1 = unchanged)'), scaleX: num(''), scaleY: num(''), rotate: num('Degrees, clockwise'), about: point, matrix: { type: 'array', items: { type: 'number' }, minItems: 6, maxItems: 6, description: 'Document-space affine [a, b, c, d, e, f]' } },
    example: { rotate: 15, scale: 1.2 } },
  'channel.save': { summary: 'Save the selection as a named channel (stored with the document)', properties: { name: str('') }, required: ['name'], example: { name: 'Sky' } },
  'channel.load': { summary: 'Load a saved channel as the selection', properties: { name: str(''), mode: { type: 'string', enum: ['replace', 'add', 'subtract', 'intersect'] } }, required: ['name'], example: { name: 'Sky', mode: 'add' } },
  'channel.remove': { summary: 'Delete a saved channel', properties: { name: str('') }, required: ['name'], example: { name: 'Sky' } },
  'selection.translate': { summary: 'Move the selection outline (not the pixels)', properties: { dx: num('px'), dy: num('px') }, example: { dx: 20, dy: 0 } },
  'selection.paint': { summary: 'Quick mask: add to (or subtract from) the selection with a brush stroke', properties: { mode: { type: 'string', enum: ['add', 'subtract'] },
    stroke: { type: 'object', required: ['points'], properties: { points, size: num('px (20)'), hardness: num('0–1 (0.75)') } } }, required: ['stroke'],
    example: { mode: 'add', stroke: { points: [[100, 100], [200, 120]], size: 40 } } },
  'selection.modify': { summary: 'Feather, grow, shrink, or turn into a border', properties: { kind: { type: 'string', enum: ['feather', 'grow', 'shrink', 'border'] }, radius: num('px') }, required: ['kind', 'radius'], example: { kind: 'feather', radius: 8 } },

  'edit.clear': { summary: 'Erase the selected area of a layer', properties: { id: ref() }, required: ['id'], example: { id: 'L2' } },
  'edit.fill': { summary: 'New fill layer covering the selection (or the canvas)', properties: { color: color(), name: str('') }, example: { color: '#ff0000' } },
  'edit.bucket': { summary: 'Bucket fill: similar colors around a point, as a new fill layer', properties: { x: num(''), y: num(''), color: color(), threshold: num('0–255 (32)'), contiguous: bool('(true)'), sample: ref() }, required: ['x', 'y'], example: { x: 10, y: 10, color: '#ff0000', threshold: 32 } },
  'edit.strokeSelection': { summary: 'Stroke the selection outline (new layer)', properties: { color: color(), width: num('px (4)'), position: { type: 'string', enum: ['center', 'inside', 'outside'] }, name: str('') },
    example: { color: '#000000', width: 4, position: 'center' } },
  'edit.gradient': { summary: 'New gradient layer (limited to the selection, if any)', properties: { kind: { type: 'string', enum: ['linear', 'radial'] }, x1: num(''), y1: num(''), x2: num(''), y2: num(''), from: color(), to: color('Color or "transparent"'), name: str('') },
    required: ['x1', 'y1', 'x2', 'y2'], example: { kind: 'linear', x1: 0, y1: 0, x2: 800, y2: 0, from: '#000000', to: 'transparent' } },

  'paint.stroke': { summary: 'Brush or eraser stroke on a paint layer (limited to the selection unless clip is false)', properties: { id: ref(), stroke: { type: 'object', required: ['points'], properties: {
    points: { type: 'array', items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 3 }, minItems: 1, description: '[[x, y], ...] or [[x, y, pressure 0–1], ...]' },
    color: color(), size: num('px'), erase: bool('Erase instead of paint'), opacity: num('0–1 for the whole stroke (1)'), hardness: num('0–1 edge hardness (1)'),
    blend: { type: 'string', enum: BLEND, description: 'How the stroke mixes with the layer (normal)' }, clip: { type: 'boolean', description: 'false = ignore the selection' } } } }, required: ['id', 'stroke'],
    example: { id: 'Ink', stroke: { color: '#000000', size: 6, points: [[0, 0], [50, 50]] } } },
  'paint.clone': { summary: 'Clone pixels from a source along a stroke onto a paint layer', properties: { id: ref(), points, ...source, ...brush }, required: ['id', 'points'], example: { id: 'Fix', points: [[100, 100], [140, 100]], from: [300, 100], size: 20 } },
  'paint.heal': { summary: 'Heal (GIMP method): clone that blends into the surroundings', properties: { id: ref(), points, ...source, ...brush }, required: ['id', 'points'], example: { id: 'Fix', points: [[100, 100]], offset: [200, 0], size: 30 } },
  'paint.smudge': { summary: 'Smudge colors along a stroke (GIMP method)', properties: { id: ref(), points, rate: num('0–100 (50)'), flow: num('0–100 (0)'), color: color('Mixed in by flow'), ...brush }, required: ['id', 'points'], example: { id: 'Fix', points: [[100, 100], [160, 100]], rate: 50 } },
  'paint.blur': { summary: 'Blur along a stroke (blur brush)', properties: { id: ref(), points, strength: num('Blur radius px, 0–100 (4)'), ...brush }, required: ['id', 'points'], example: { id: 'Fix', points: [[100, 100], [160, 100]], strength: 6 } },
  'paint.sharpen': { summary: 'Sharpen along a stroke (unsharp-mask brush)', properties: { id: ref(), points, strength: num('0–100 (50)'), ...brush }, required: ['id', 'points'], example: { id: 'Fix', points: [[100, 100], [160, 100]], strength: 50 } },
  'paint.dodge': { summary: 'Lighten along a stroke (GIMP formula)', properties: { id: ref(), points, range: { type: 'string', enum: RANGES }, exposure: num('0–100 (50)'), ...brush }, required: ['id', 'points'], example: { id: 'Fix', points: [[100, 100], [160, 100]], range: 'midtones', exposure: 50 } },
  'paint.burn': { summary: 'Darken along a stroke (GIMP formula)', properties: { id: ref(), points, range: { type: 'string', enum: RANGES }, exposure: num('0–100 (50)'), ...brush }, required: ['id', 'points'], example: { id: 'Fix', points: [[100, 100], [160, 100]], range: 'highlights', exposure: 40 } },

  'path.add': { summary: 'Add a bezier path (SVG path data "d", or subpaths)', properties: { path: { type: 'object', properties: { name: str(''), d: str('SVG path data: M L H V C S Q T Z (absolute or relative)'), subpaths: refJ('Subpaths') } } }, required: ['path'],
    example: { path: { name: 'Arch', d: 'M 100 300 C 150 120 450 120 500 300 Z' } } },
  'path.update': { summary: 'Reshape, rename or move a path', properties: { id: ref('path'), props: { type: 'object', properties: { name: str(''), d: str(''), subpaths: refJ('Subpaths') } }, dx: num('Move by'), dy: num('Move by') }, required: ['id'], example: { id: 'Arch', dx: 0, dy: -50 } },
  'path.remove': { summary: 'Delete a path', properties: { id: ref('path') }, required: ['id'], example: { id: 'P1' } },
  'path.select': { summary: 'Path → selection', properties: { id: ref('path'), mode: { type: 'string', enum: ['replace', 'add', 'subtract', 'intersect'] } }, required: ['id'], example: { id: 'Arch' } },
  'path.stroke': { summary: 'Draw a line along a path (onto a paint layer, or a new one)', properties: { id: ref('path'), color: color(), size: num('px (4)'), layer: ref(), clip: { type: 'boolean' } }, required: ['id'], example: { id: 'Arch', color: '#000000', size: 4 } },
  'path.fill': { summary: 'Fill the inside of a path (new fill layer)', properties: { id: ref('path'), color: color(), name: str('') }, required: ['id'], example: { id: 'Arch', color: '#ff8800' } },

  'history.undo': { summary: 'Undo the last change', properties: {}, example: {} },
  'history.redo': { summary: 'Redo', properties: {}, example: {} },
};

const opSchema = (type, o) => ({
  type: 'object', title: type, description: o.summary, required: ['type', ...(o.required || [])],
  properties: { type: { type: 'string', const: type }, ...o.properties },
  examples: [{ type, ...o.example }],
});

export function opCatalog() {
  return Object.entries(OPS).map(([type, o]) => ({ type, summary: o.summary, schema: opSchema(type, o), example: { type, ...o.example } }));
}

export function openApiSpec({ version = '0.1.0', server = 'http://127.0.0.1:4747' } = {}) {
  const opNames = Object.keys(OPS), schemas = { ...COMPONENTS };
  for (const [type, o] of Object.entries(OPS)) schemas[`Op_${type.replace('.', '_')}`] = opSchema(type, o);
  schemas.Op = { oneOf: opNames.map(t => refJ(`Op_${t.replace('.', '_')}`)), discriminator: { propertyName: 'type',
    mapping: Object.fromEntries(opNames.map(t => [t, `#/components/schemas/Op_${t.replace('.', '_')}`])) } };
  const json = schema => ({ content: { 'application/json': { schema } } });
  const err = { description: 'The op was rejected (bad input, unknown layer, nothing selected, ...)', ...json({ type: 'object', properties: { error: { type: 'string' }, index: { type: 'integer' }, entries: { type: 'array', items: refJ('Entry') } } }) };
  const spec = {
    openapi: '3.1.0',
    info: {
      title: 'ImageArtifex API', version,
      description: [
        'Layered image editing over HTTP. Every edit is an op appended to the project history with a plain-English description;',
        'the browser editor, the CLI and API clients all share it, and edits show up live in open editors.',
        '',
        'Typical agent loop: GET /api/state (layers, selection, recent history) → POST /api/ops (one op or a batch) →',
        'GET /api/export to look at the result. Set "author" so the history shows who made each change.',
        'Layer and path references accept ids ("L3", "P1") or names. Coordinates are canvas pixels, origin top-left.',
        'The server listens on 127.0.0.1 only; reach it from elsewhere through an SSH tunnel.',
      ].join('\n'),
    },
    servers: [{ url: server, description: 'Local ImageArtifex server (artifex serve)' }],
    paths: {
      '/api/state': { get: { operationId: 'getState', summary: 'Document, undo/redo state and full history',
        responses: { 200: { description: 'Current state', ...json({ type: 'object', properties: {
          doc: { type: 'object', description: 'width, height, background, layers (bottom first), selection, paths' },
          canUndo: { type: 'boolean' }, canRedo: { type: 'boolean' },
          entries: { type: 'array', items: { type: 'object', properties: { seq: { type: 'integer' }, ts: { type: 'string' }, author: { type: 'string' }, type: { type: 'string' }, text: { type: 'string' }, undone: { type: 'boolean' } } } } } }) } } } },
      '/api/ops': { post: { operationId: 'applyOps', summary: 'Apply one op, or a batch (applied in order, stops at the first error)',
        requestBody: { required: true, ...json({ type: 'object', required: ['op'], properties: {
          op: { oneOf: [refJ('Op'), { type: 'array', items: refJ('Op') }] }, author: { type: 'string', description: 'Shown in the history (default "user"); e.g. "claude" or your agent name' } } }) },
        responses: { 200: { description: 'Applied', ...json({ type: 'object', properties: { entry: refJ('Entry'), entries: { type: 'array', items: refJ('Entry') } } }) }, 400: err } } },
      '/api/upload': { post: { operationId: 'uploadImage', summary: 'Upload an image (→ asset for layer.add {type:"image", asset}) or a .psd / .xcf (→ file for doc.import {src: file})',
        parameters: [{ name: 'name', in: 'query', schema: { type: 'string' }, description: 'File name hint (extension decides the type)' }],
        requestBody: { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } }, 'image/*': { schema: { type: 'string', format: 'binary' } } } },
        responses: { 200: { description: 'Stored (content-addressed)', ...json({ type: 'object', properties: { asset: { type: 'string' }, w: { type: 'integer' }, h: { type: 'integer' }, file: { type: 'string', description: '.psd uploads: path for doc.import' } } }) }, 400: err } } },
      '/api/export': { get: { operationId: 'exportImage', summary: 'Render the flattened image',
        parameters: [{ name: 'format', in: 'query', schema: { type: 'string', enum: ['png', 'jpeg', 'webp', 'avif', 'psd', 'xcf', 'pdf', 'svg'], default: 'png' },
          description: 'psd and xcf keep layers and groups; svg keeps shapes, text and gradients as vectors; pdf is one page' },
          { name: 'dpi', in: 'query', schema: { type: 'number', default: 72 }, description: 'pdf: page size = pixels × 72 / dpi points' }],
        responses: { 200: { description: 'The file (header x-artifex-notes lists anything that could not be kept)', content: Object.fromEntries(['image/png', 'image/jpeg', 'image/vnd.adobe.photoshop', 'application/pdf', 'image/svg+xml'].map(t => [t, { schema: { type: 'string', format: 'binary' } }])) } } } },
      '/api/pick': { get: { operationId: 'pickColor', summary: 'Color at a point: merged image, or one layer before/after its adjustments',
        parameters: [{ name: 'x', in: 'query', required: true, schema: { type: 'number' } }, { name: 'y', in: 'query', required: true, schema: { type: 'number' } },
          { name: 'layer', in: 'query', schema: { type: 'string' }, description: 'Layer id or name' }],
        responses: { 200: { description: 'Color info (hex, r, g, b, alpha, value, lightness)', ...json({ type: 'object' }) }, 400: err } } },
      '/api/histogram': { get: { operationId: 'histogram', summary: 'Per-channel stats (min, 1%, mean, 99%, max) of the image or one layer (before its own tone)',
        parameters: [{ name: 'layer', in: 'query', schema: { type: 'string' } }],
        responses: { 200: { description: 'Stats per channel (value, r, g, b) and pixel count', ...json({ type: 'object' }) }, 400: err } } },
      '/api/ops/catalog': { get: { operationId: 'opCatalog', summary: 'Every op with its summary, JSON Schema and an example', responses: { 200: { description: 'Op catalog', ...json({ type: 'array' }) } } } },
      '/api/events': { get: { operationId: 'events', summary: 'Server-Sent Events: an "change" event whenever the history changes', responses: { 200: { description: 'text/event-stream', content: { 'text/event-stream': { schema: { type: 'string' } } } } } } },
      '/api/projects': {
        get: { operationId: 'listProjects', summary: 'Projects in the workspace folder (open one with ?project=<name> on any endpoint)',
          responses: { 200: { description: 'Workspace root and its projects', ...json({ type: 'object', properties: { root: { type: 'string' }, projects: { type: 'array', items: { type: 'object', properties: {
            name: { type: 'string' }, width: { type: 'integer' }, height: { type: 'integer' }, layers: { type: 'integer' }, modified: { type: 'string' }, start: { type: 'boolean' } } } } } }) } } },
        post: { operationId: 'createProject', summary: 'Create a project in the workspace',
          requestBody: { required: true, ...json({ type: 'object', required: ['name'], properties: { name: { type: 'string' }, width: { type: 'integer', default: 1200 }, height: { type: 'integer', default: 800 }, background: { type: ['string', 'null'], default: '#ffffff' } } }) },
          responses: { 200: { description: 'Created', ...json({ type: 'object', properties: { name: { type: 'string' } } }) }, 400: err } },
      },
      '/api/openapi.json': { get: { operationId: 'openapi', summary: 'This document', responses: { 200: { description: 'OpenAPI 3.1', ...json({ type: 'object' }) } } } },
      '/assets/{file}': { get: { operationId: 'asset', summary: 'An uploaded or generated image asset', parameters: [{ name: 'file', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Image file' } } } },
    },
    components: { schemas, parameters: { project: PROJECT_PARAM } },
  };
  // Every per-project endpoint takes ?project=<name> (default: the project the server was started with).
  for (const [route, item] of Object.entries(spec.paths)) {
    if (['/api/openapi.json', '/api/ops/catalog', '/api/projects'].includes(route)) continue;
    for (const op of Object.values(item)) op.parameters = [...(op.parameters || []), { $ref: '#/components/parameters/project' }];
  }
  return spec;
}

const PROJECT_PARAM = { name: 'project', in: 'query', required: false, schema: { type: 'string' },
  description: 'Project folder name inside the server\'s workspace (GET /api/projects); default: the project the server was started with' };
