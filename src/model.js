import { TONE_CHANNELS, BALANCE_RANGES, BALANCE_AXES, C2A_DEFAULT, PARAM_SETS, paramDefaults } from './tone.js';
import { validatePath, translatePath, anchorCount, mapPath } from './paths.js';

// Document model + operations. Shared by the browser editor, the server and the CLI.
// A project is an append-only log of operations; the document is the result of replaying it.

export const BLEND_MODES = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn',
  'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'];

export const ADJUST_DEFAULTS = { brightness: 100, contrast: 100, saturate: 100, hue: 0, blur: 0, grayscale: 0, sepia: 0, invert: 0 };
export const ADJUST_UNITS = { brightness: '%', contrast: '%', saturate: '%', hue: '°', blur: 'px', grayscale: '%', sepia: '%', invert: '%' };

const TYPE_DEFAULTS = {
  image: { asset: null, w: 0, h: 0 },
  text: { text: 'Text', font: 'sans-serif', size: 48, weight: 'normal', color: '#000000', align: 'left' },
  shape: { shape: 'rect', w: 200, h: 120, fill: '#3b82f6', stroke: null, strokeWidth: 0, radius: 0 },
  paint: { w: 0, h: 0, strokes: [] },
  fill: { w: 0, h: 0, color: '#000000' },
  gradient: { w: 0, h: 0, kind: 'linear', x1: 0, y1: 0, x2: 0, y2: 0, stops: [[0, '#000000'], [1, '#ffffff']] },
  group: { w: 0, h: 0 },
  adjustment: { w: 0, h: 0 }, // tone/filters applied to everything below it (in its group)
};
export const GRADIENT_KINDS = ['linear', 'radial'];

export const SELECTION_MODES = ['replace', 'add', 'subtract', 'intersect'];
const SELECTION_SHAPES = ['rect', 'ellipse', 'polygon', 'path', 'stroke', 'mask', 'all'];
export const LAYER_TYPES = Object.keys(TYPE_DEFAULTS);

// doc.selection: null, or { items: [{ mode: add|subtract|intersect|xor, shape, dx, dy }] } in document
// coordinates. Shapes: rect/ellipse {x,y,w,h}, polygon {points}, mask {asset, bbox, via}, all.
// layer.mask: [{ mode: keep|hide, sel, w, h, x0, y0 }]; it follows the layer as it moves (offset = layer.x - x0).
export function newDoc({ width = 1200, height = 800, background = '#ffffff' } = {}) {
  return { width, height, background, layers: [], selection: null, nextId: 1, paths: [], nextPathId: 1 };
}

// doc.paths: bezier paths (Pen tool), see paths.js. Found by id ("P2") or name.
export function findPath(doc, ref) {
  const s = String(ref ?? ''), paths = doc.paths || [];
  const p = paths.find(p => p.id === s) || paths.find(p => p.name === s) || paths.find(p => p.name.toLowerCase() === s.toLowerCase());
  if (!p) throw new Error(`No path "${s}". Paths: ${paths.map(p => `${p.id} "${p.name}"`).join(', ') || '(none)'}`);
  return p;
}

function shiftPaths(doc, dx, dy) {
  for (const p of doc.paths || []) p.subpaths = translatePath(p.subpaths, dx, dy);
}

export function makeLayer(spec, doc) {
  if (!TYPE_DEFAULTS[spec.type]) throw new Error(`Unknown layer type "${spec.type}" (expected ${LAYER_TYPES.join(', ')})`);
  const layer = {
    name: `${spec.type} ${spec.id}`, visible: true, opacity: 1, blend: 'normal',
    x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1,
    ...structuredClone(TYPE_DEFAULTS[spec.type]), ...spec,
    adjust: { ...ADJUST_DEFAULTS, ...(spec.adjust || {}) },
  };
  if (['paint', 'fill', 'gradient', 'adjustment'].includes(layer.type)) { layer.w ||= doc.width; layer.h ||= doc.height; }
  if (!BLEND_MODES.includes(layer.blend)) throw new Error(`Unknown blend mode "${layer.blend}"`);
  return layer;
}

// Resolve a layer by id ("L3") or name (exact, then case-insensitive).
export function findLayer(doc, ref) {
  if (ref == null || ref === '') throw new Error('A layer id or name is required');
  const s = String(ref);
  const l = doc.layers.find(l => l.id === s) || doc.layers.find(l => l.name === s)
    || doc.layers.find(l => l.name.toLowerCase() === s.toLowerCase());
  if (!l) throw new Error(`No layer "${s}". Layers: ${doc.layers.map(l => `${l.id} "${l.name}"`).join(', ') || '(none)'}`);
  return l;
}

function byId(doc, id) {
  const l = doc.layers.find(l => l.id === id);
  if (!l) throw new Error(`No layer with id "${id}"`);
  return l;
}

// ---- Layer tree, clipping and locks ---------------------------------------------------------------
// Groups are layers of type "group"; members carry `parent: <group id>` and stay in doc.layers (flat), so a
// group's children are the layers whose parent is it, in stack order. `clip: true` clips a layer to the nearest
// unclipped sibling below. `locks: { position, pixels, alpha }` are enforced here, for every client.
export const isGroup = l => l?.type === 'group';
export function descendants(doc, id) {
  const out = [], walk = pid => { for (const l of doc.layers) if (l.parent === pid) { out.push(l); if (isGroup(l)) walk(l.id); } };
  walk(id);
  return out;
}
export const ancestors = (doc, l) => { const out = []; for (let p = l.parent; p; p = byId(doc, p).parent) out.push(p); return out; };
const POSITION_PROPS = ['x', 'y', 'rotation', 'scaleX', 'scaleY'];
function checkLocks(l, what) {
  const k = l.locks || {};
  if (what === 'position' && k.position) throw new Error(`Layer "${l.name}" is locked (position) — unlock it first`);
  if (what === 'pixels' && k.pixels) throw new Error(`Layer "${l.name}" is locked (pixels) — unlock it first`);
}
function setParent(doc, l, parent) {
  if (parent == null) { delete l.parent; return; }
  const g = byId(doc, parent);
  if (!isGroup(g)) throw new Error(`"${g.name}" is not a group`);
  if (g === l || ancestors(doc, g).includes(l.id)) throw new Error('A group cannot go inside itself');
  l.parent = g.id;
}

function bumpId(doc, id) {
  const n = Number(String(id).replace(/^L/, ''));
  if (Number.isFinite(n)) doc.nextId = Math.max(doc.nextId, n + 1);
}

function shiftSelection(doc, dx, dy) {
  for (const it of [...(doc.selection?.items || []), ...(doc.channels || []).map(c => c.item)]) { it.dx = (it.dx || 0) + dx; it.dy = (it.dy || 0) + dy; }
}

// Apply a document-space affine matrix [a,b,c,d,e,f] to selection items (folds their offset into it.m).
const mul = ([a, b, c, d, e, f], [A, B, C, D, E, F]) => [a * A + c * B, b * A + d * B, a * C + c * D, b * C + d * D, a * E + c * F + e, b * E + d * F + f];
function transformItems(items, T) {
  for (const it of items) {
    if (it.shape.type === 'all') continue;
    it.m = mul(T, mul([1, 0, 0, 1, it.dx || 0, it.dy || 0], it.m || [1, 0, 0, 1, 0, 0]));
    it.dx = 0; it.dy = 0;
  }
}

// levels/curves updates merge per channel; null resets a channel (or, for the whole value, everything).
function setTone(l, key, v) {
  if (v === null) { delete l[key]; return; }
  const merged = { ...(l[key] || {}) };
  for (const [ch, cv] of Object.entries(v)) {
    if (!TONE_CHANNELS.includes(ch)) throw new Error(`Unknown ${key} channel "${ch}" (expected ${TONE_CHANNELS.join(', ')})`);
    if (cv === null) { delete merged[ch]; continue; }
    if (key === 'curves' && !(Array.isArray(cv) && cv.length >= 2 && cv.every(p => p.length === 2 && p.every(Number.isFinite)))) {
      throw new Error('A curve needs at least two [input, output] points, e.g. [[0,0],[128,160],[255,255]]');
    }
    if (key === 'levels') {
      for (const [lk, lv] of Object.entries(cv)) if (!['inLow', 'inHigh', 'gamma', 'outLow', 'outHigh'].includes(lk) || !Number.isFinite(lv)) {
        throw new Error(`Invalid levels setting ${lk}=${lv} (use inLow, inHigh, gamma, outLow, outHigh)`);
      }
      if (cv.gamma !== undefined && !(cv.gamma > 0)) throw new Error('gamma must be greater than 0');
    }
    merged[ch] = cv;
  }
  if (Object.keys(merged).length) l[key] = merged;
  else delete l[key];
}

// colorBalance: { shadows|midtones|highlights: { cyanRed, magentaGreen, yellowBlue } (-100..100), preserveLuminosity }
function setBalance(l, v) {
  if (v === null) { delete l.colorBalance; return; }
  const cb = structuredClone(l.colorBalance || { preserveLuminosity: true });
  for (const [k, rv] of Object.entries(v)) {
    if (k === 'preserveLuminosity') { cb.preserveLuminosity = !!rv; continue; }
    if (!BALANCE_RANGES.includes(k)) throw new Error(`Unknown color balance range "${k}" (expected ${BALANCE_RANGES.join(', ')}, preserveLuminosity)`);
    if (rv === null) { delete cb[k]; continue; }
    for (const [a, n] of Object.entries(rv)) {
      if (!BALANCE_AXES.includes(a)) throw new Error(`Unknown color balance axis "${a}" (expected ${BALANCE_AXES.join(', ')})`);
      if (!(Number.isFinite(n) && n >= -100 && n <= 100)) throw new Error(`Color balance ${a} must be between -100 and 100`);
    }
    cb[k] = { ...(cb[k] || {}), ...rv };
  }
  l.colorBalance = cb;
}

// shadowsHighlights / exposure / hueChroma: flat numeric settings (ranges in PARAM_SETS) merged into the current ones.
const PARAM_LABELS = { shadowsHighlights: 'Shadows-highlights', exposure: 'Exposure', hueChroma: 'Hue-chroma', sharpen: 'Unsharp mask', denoise: 'Noise reduction', highPass: 'High pass',
  pixelate: 'Pixelate', emboss: 'Emboss' };
function setParams(l, key, v) {
  if (v === null) { delete l[key]; return; }
  const params = PARAM_SETS[key];
  for (const [k, n] of Object.entries(v)) {
    if (!(k in params)) throw new Error(`Unknown ${PARAM_LABELS[key].toLowerCase()} setting "${k}" (expected ${Object.keys(params).join(', ')})`);
    const [, min, max] = params[k];
    if (!(Number.isFinite(n) && n >= min && n <= max)) throw new Error(`${PARAM_LABELS[key]} ${k} must be between ${min} and ${max}`);
  }
  l[key] = { ...paramDefaults(params), ...(l[key] || {}), ...v };
}

// colorToAlpha: { color: '#rrggbb', transparency: 0–1, opacity: 0–1 } — GIMP's thresholds.
function setColorToAlpha(l, v) {
  if (v === null) { delete l.colorToAlpha; return; }
  const c = { ...C2A_DEFAULT, ...(l.colorToAlpha || {}), ...v };
  if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c.color)) throw new Error('Color to alpha color must be #rgb or #rrggbb');
  if (!(c.transparency >= 0 && c.opacity <= 1 && c.transparency < c.opacity)) {
    throw new Error('Color to alpha needs 0 ≤ transparency threshold < opacity threshold ≤ 1');
  }
  for (const k of Object.keys(c)) if (!(k in C2A_DEFAULT)) throw new Error(`Unknown color to alpha setting "${k}" (expected color, transparency, opacity)`);
  l.colorToAlpha = c;
}

function brushStroke(s) {
  if (!Array.isArray(s?.points) || !s.points.length || !s.points.every(p => Number.isFinite(p?.[0]) && Number.isFinite(p?.[1]))) throw new Error('stroke needs points: [[x, y], ...]');
  const size = s.size ?? 20, hardness = s.hardness ?? 0.75;
  if (!(size > 0)) throw new Error('size must be positive');
  if (!(hardness >= 0 && hardness <= 1)) throw new Error('hardness must be between 0 and 1');
  return { points: s.points, size, hardness };
}

function addMask(l, entry) {
  l.mask = [...(l.mask || []), entry];
}

function anchorFactor(anchor = 'center') {
  const fx = anchor.includes('left') ? 0 : anchor.includes('right') ? 1 : 0.5;
  const fy = anchor.includes('top') ? 0 : anchor.includes('bottom') ? 1 : 0.5;
  return [fx, fy];
}

// Apply a (materialized) op to doc in place.
export function applyOpMut(doc, op) {
  switch (op.type) {
    case 'canvas.new':
      Object.assign(doc, { width: op.width, height: op.height, background: op.background ?? null, layers: [], selection: null });
      break;
    case 'canvas.resize': {
      const [fx, fy] = anchorFactor(op.anchor);
      const dx = Math.round((op.width - doc.width) * fx), dy = Math.round((op.height - doc.height) * fy);
      for (const l of doc.layers) { l.x += dx; l.y += dy; }
      for (const g of doc.guides || []) g.pos += g.axis === 'x' ? dx : dy;
      shiftSelection(doc, dx, dy);
      shiftPaths(doc, dx, dy);
      doc.width = op.width; doc.height = op.height;
      break;
    }
    case 'canvas.scale': {
      // Image size: resample the whole image. Layers stay non-destructive (their scale changes, source pixels
      // are kept); masks, painted masks, paths, guides, the selection and saved channels scale with them.
      if (!(Number.isInteger(op.width) && op.width > 0 && Number.isInteger(op.height) && op.height > 0)) throw new Error('width and height must be positive whole numbers');
      const sx = op.width / doc.width, sy = op.height / doc.height;
      for (const l of doc.layers) {
        l.x *= sx; l.y *= sy; l.scaleX *= sx; l.scaleY *= sy;
        for (const m of l.mask || []) {
          m.x0 *= sx; m.y0 *= sy;
          if (m.stroke) m.stroke = { ...m.stroke, points: m.stroke.points.map(([x, y]) => [x * sx, y * sy]), size: m.stroke.size * Math.sqrt(sx * sy) };
          else { m.sx = (m.sx ?? 1) * sx; m.sy = (m.sy ?? 1) * sy; }
        }
      }
      for (const p of doc.paths || []) p.subpaths = mapPath(p.subpaths, ([x, y]) => [x * sx, y * sy]);
      for (const g of doc.guides || []) g.pos *= g.axis === 'x' ? sx : sy;
      transformItems([...(doc.selection?.items || []), ...(doc.channels || []).map(c => c.item)], [sx, 0, 0, sy, 0, 0]);
      doc.width = op.width; doc.height = op.height;
      break;
    }
    case 'doc.import': {
      if (op.width) { doc.width = op.width; doc.height = op.height; }
      // add every layer first, then connect parents (a group can come after its contents in the list)
      const added = [];
      for (const spec of op.layers) {
        const { parent, ...rest } = spec, layer = makeLayer(rest, doc);
        if (doc.layers.some(l => l.id === layer.id)) throw new Error(`Layer id "${layer.id}" already exists`);
        doc.layers.push(layer);
        bumpId(doc, layer.id);
        added.push([layer, parent]);
      }
      for (const [layer, parent] of added) if (parent) setParent(doc, layer, parent);
      break;
    }
    case 'guide.add': {
      if (!['x', 'y'].includes(op.axis) || !Number.isFinite(op.pos)) throw new Error('A guide needs axis "x" (vertical line) or "y" (horizontal line) and a position');
      doc.guides = [...(doc.guides || []), { axis: op.axis, pos: op.pos }];
      break;
    }
    case 'guide.remove': {
      const i = op.index ?? (doc.guides || []).findIndex(g => g.axis === op.axis && Math.abs(g.pos - op.pos) < 0.5);
      if (!doc.guides?.[i]) throw new Error('No such guide');
      doc.guides = doc.guides.filter((_, j) => j !== i);
      break;
    }
    case 'guide.clear':
      doc.guides = [];
      break;
    case 'canvas.crop':
      for (const g of doc.guides || []) g.pos -= g.axis === 'x' ? op.x : op.y;
      for (const l of doc.layers) { l.x -= op.x; l.y -= op.y; }
      shiftSelection(doc, -op.x, -op.y);
      shiftPaths(doc, -op.x, -op.y);
      doc.width = op.width; doc.height = op.height;
      break;
    case 'canvas.background':
      doc.background = op.color ?? null;
      break;
    case 'layer.add': case 'edit.fill': {
      const layer = makeLayer(op.layer, doc);
      if (doc.layers.some(l => l.id === layer.id)) throw new Error(`Layer id "${layer.id}" already exists`);
      if (layer.parent) setParent(doc, layer, layer.parent);
      doc.layers.splice(op.index ?? doc.layers.length, 0, layer);
      bumpId(doc, layer.id);
      break;
    }
    case 'layer.update': {
      const l = byId(doc, op.id);
      if (Object.keys(op.props).some(k => POSITION_PROPS.includes(k) && op.props[k] !== l[k])) checkLocks(l, 'position');
      for (const [k, v] of Object.entries(op.props)) {
        if (k === 'id' || k === 'type') throw new Error(`Cannot change layer ${k}`);
        if (k === 'adjust') {
          for (const a of Object.keys(v)) if (!(a in ADJUST_DEFAULTS)) throw new Error(`Unknown adjustment "${a}" (expected ${Object.keys(ADJUST_DEFAULTS).join(', ')})`);
          l.adjust = { ...l.adjust, ...v };
        } else if (k === 'blend' && !BLEND_MODES.includes(v)) {
          throw new Error(`Unknown blend mode "${v}" (expected ${BLEND_MODES.join(', ')})`);
        } else if (k === 'kind' && l.type === 'gradient' && !GRADIENT_KINDS.includes(v)) {
          throw new Error(`Unknown gradient type "${v}" (expected ${GRADIENT_KINDS.join(', ')})`);
        } else if (k === 'levels' || k === 'curves') {
          setTone(l, k, v);
        } else if (k === 'colorBalance') {
          setBalance(l, v);
        } else if (k === 'path') {
          if (v === null) { delete l.path; continue; }
          if (l.type !== 'text') throw new Error('Only text layers can follow a path');
          const pv = { ...(l.path || {}), ...v };
          validatePath(pv.subpaths);
          if (!(Array.isArray(pv.box) && pv.box.length === 2 && pv.box.every(n => n > 0))) throw new Error('path text needs box [w, h]');
          l.path = { subpaths: pv.subpaths, offset: pv.offset ?? 0, box: pv.box };
        } else if (k === 'liquify') {
          if (v !== null) throw new Error('liquify can only be reset (null); add strokes with layer.liquify');
          delete l.liquify;
        } else if (k === 'distort') {
          if (v === null) { delete l.distort; continue; }
          const dv = { ...(l.distort || {}), ...v };
          if (!['twirl', 'pinch', 'ripple', 'waves', 'lens'].includes(dv.kind)) throw new Error('distort kind must be twirl, pinch, ripple, waves or lens');
          for (const [dk, dn] of Object.entries(dv)) if (!['kind', 'orientation'].includes(dk) && !Number.isFinite(dn)) throw new Error(`distort ${dk} must be a number`);
          l.distort = dv;
        } else if (k === 'mesh') {
          if (v === null) { delete l.mesh; continue; }
          const n = v?.kind === 'perspective' ? 4 : (v?.cols + 1) * (v?.rows + 1);
          if (!['perspective', 'warp'].includes(v?.kind)) throw new Error('mesh kind must be "perspective" or "warp"');
          if (v.kind === 'warp' && !(Number.isInteger(v.cols) && Number.isInteger(v.rows) && v.cols >= 1 && v.rows >= 1 && v.cols <= 8 && v.rows <= 8)) throw new Error('warp grid needs 1–8 cols and rows');
          if (!Array.isArray(v.points) || v.points.length !== n || !v.points.every(q => q.length === 2 && q.every(Number.isFinite))) throw new Error(`mesh needs ${n} points [x, y]`);
          l.mesh = { kind: v.kind, cols: v.kind === 'perspective' ? 1 : v.cols, rows: v.kind === 'perspective' ? 1 : v.rows, points: v.points };
        } else if (k === 'parent') {
          setParent(doc, l, v);
        } else if (k === 'clip') {
          if (v) l.clip = true; else delete l.clip;
        } else if (k === 'locks') {
          const locks = { ...(l.locks || {}) };
          for (const [lk, lv] of Object.entries(v || {})) {
            if (!['position', 'pixels', 'alpha'].includes(lk)) throw new Error(`Unknown lock "${lk}" (expected position, pixels, alpha)`);
            if (lv) locks[lk] = true; else delete locks[lk];
          }
          if (v === null || !Object.keys(locks).length) delete l.locks; else l.locks = locks;
        } else if (k in PARAM_SETS) {
          setParams(l, k, v);
        } else if (k === 'colorToAlpha') {
          setColorToAlpha(l, v);
        } else if (k === 'posterize') {
          if (v === null) delete l.posterize;
          else if (Number.isInteger(v) && v >= 2 && v <= 256) l.posterize = v;
          else throw new Error('posterize must be a whole number of levels from 2 to 256 (or null to remove)');
        } else if (k === 'threshold') {
          if (v === null) { delete l.threshold; continue; }
          const t = { low: 127, high: 255, channel: 'value', ...(l.threshold || {}), ...v };
          if (!TONE_CHANNELS.includes(t.channel)) throw new Error(`threshold channel must be one of ${TONE_CHANNELS.join(', ')}`);
          if (!(t.low >= 0 && t.high <= 255 && t.low <= t.high)) throw new Error('threshold needs 0 ≤ low ≤ high ≤ 255');
          l.threshold = t;
        } else l[k] = v;
      }
      break;
    }
    case 'layer.remove': {
      const gone = new Set([op.id, ...descendants(doc, op.id).map(l => l.id)]); // a group takes its contents with it
      byId(doc, op.id);
      doc.layers = doc.layers.filter(l => !gone.has(l.id));
      break;
    }
    case 'layer.group': {
      // New group at the stack position of the topmost member; members keep their order inside it.
      const members = op.ids.map(id => byId(doc, id));
      const top = members.reduce((a, b) => (doc.layers.indexOf(b) > doc.layers.indexOf(a) ? b : a));
      const group = makeLayer({ type: 'group', id: op.newId, name: op.name ?? 'Group', ...(top.parent ? { parent: top.parent } : {}) }, doc);
      doc.layers.splice(doc.layers.indexOf(top) + 1, 0, group);
      bumpId(doc, op.newId);
      for (const m of members) setParent(doc, m, group.id);
      break;
    }
    case 'layer.ungroup': {
      const g = byId(doc, op.id);
      if (!isGroup(g)) throw new Error(`"${g.name}" is not a group`);
      for (const l of doc.layers) if (l.parent === g.id) { if (g.parent) l.parent = g.parent; else delete l.parent; }
      doc.layers = doc.layers.filter(l => l !== g);
      break;
    }
    case 'layer.move': {
      // Move a layer, or every layer in a group, by (dx, dy).
      const l = byId(doc, op.id), targets = isGroup(l) ? descendants(doc, l.id).filter(x => !isGroup(x)) : [l];
      for (const t of targets) checkLocks(t, 'position');
      for (const t of targets) { t.x += op.dx || 0; t.y += op.dy || 0; }
      break;
    }
    case 'layer.reorder': {
      const l = byId(doc, op.id);
      doc.layers = doc.layers.filter(x => x !== l);
      doc.layers.splice(Math.max(0, Math.min(op.index, doc.layers.length)), 0, l);
      break;
    }
    case 'layer.duplicate': {
      const l = byId(doc, op.id);
      const copy = { ...structuredClone(l), id: op.newId, name: op.name ?? `${l.name} copy`, x: l.x + (op.dx ?? 0), y: l.y + (op.dy ?? 0) };
      doc.layers.splice(doc.layers.indexOf(l) + 1, 0, copy);
      bumpId(doc, op.newId);
      break;
    }
    case 'layer.merge': {
      for (const id of op.ids) byId(doc, id);
      const top = Math.max(...op.ids.map(id => doc.layers.findIndex(l => l.id === id)));
      const at = top - (op.ids.length - 1);
      doc.layers = doc.layers.filter(l => !op.ids.includes(l.id));
      doc.layers.splice(at, 0, makeLayer({ id: op.newId, name: op.name, type: 'image', asset: op.asset, w: op.w, h: op.h }, doc));
      bumpId(doc, op.newId);
      break;
    }
    case 'paint.stroke': {
      const l = byId(doc, op.id);
      if (l.type !== 'paint') throw new Error(`Layer "${l.name}" is a ${l.type} layer; strokes need a paint layer`);
      checkLocks(l, 'pixels');
      const st = op.stroke;
      if (st.blend != null && !BLEND_MODES.includes(st.blend)) throw new Error(`Unknown blend mode "${st.blend}"`);
      if (st.opacity != null && !(st.opacity >= 0 && st.opacity <= 1)) throw new Error('stroke opacity must be 0–1');
      if (st.hardness != null && !(st.hardness >= 0 && st.hardness <= 1)) throw new Error('stroke hardness must be 0–1');
      // alpha lock: the new stroke only lands where the layer already has pixels
      l.strokes.push(l.locks?.alpha ? { ...op.stroke, atop: true } : op.stroke);
      break;
    }
    case 'selection.set': {
      const mode = op.mode ?? 'replace';
      if (!SELECTION_MODES.includes(mode)) throw new Error(`Unknown selection mode "${mode}" (expected ${SELECTION_MODES.join(', ')})`);
      if (!SELECTION_SHAPES.includes(op.shape?.type)) throw new Error(`Selection shape must be one of ${SELECTION_SHAPES.join(', ')} (got "${op.shape?.type}")`);
      const item = { mode: 'add', shape: op.shape, dx: 0, dy: 0 };
      if (mode === 'replace' || (mode === 'add' && !doc.selection)) doc.selection = { items: [item] };
      else if (doc.selection) doc.selection.items.push({ ...item, mode }); // subtracting from / intersecting nothing leaves nothing
      break;
    }
    case 'selection.all':
      doc.selection = { items: [{ mode: 'add', shape: { type: 'all' }, dx: 0, dy: 0 }] };
      break;
    case 'selection.none':
      doc.selection = null;
      break;
    case 'selection.transform': {
      // Rotate / scale (any affine matrix, document space) the selection outline.
      if (!doc.selection) throw new Error('Nothing is selected');
      if (!Array.isArray(op.matrix) || op.matrix.length !== 6 || !op.matrix.every(Number.isFinite)) throw new Error('matrix must be [a, b, c, d, e, f]');
      transformItems(doc.selection.items, op.matrix);
      break;
    }
    case 'channel.save': {
      // A saved selection (GIMP: Save to Channel): stored rasterized, so it does not change when it is loaded.
      if (!op.name) throw new Error('A channel needs a name');
      doc.channels = [...(doc.channels || []).filter(c => c.name !== op.name), { name: op.name, item: { mode: 'add', shape: op.shape, dx: 0, dy: 0 } }];
      break;
    }
    case 'channel.remove': {
      if (!(doc.channels || []).some(c => c.name === op.name)) throw new Error(`No channel "${op.name}"`);
      doc.channels = doc.channels.filter(c => c.name !== op.name);
      break;
    }
    case 'selection.translate':
      if (!doc.selection) throw new Error('Nothing is selected');
      shiftSelection(doc, op.dx || 0, op.dy || 0);
      break;
    case 'selection.paint': {
      // Quick mask painting: a brush stroke added to (or subtracted from) the selection.
      const item = { mode: op.mode === 'subtract' ? 'subtract' : 'add', shape: { type: 'stroke', ...brushStroke(op.stroke) }, dx: 0, dy: 0 };
      if (doc.selection) doc.selection.items.push(item);
      else if (item.mode === 'add') doc.selection = { items: [item] };
      break;
    }
    case 'layer.liquify': {
      // A liquify stroke in the layer's own coordinates (the server converts canvas points; see materialize).
      const l = byId(doc, op.id), st = op.stroke || {};
      checkLocks(l, 'pixels');
      if (!['push', 'twirl', 'bloat', 'pinch'].includes(st.mode)) throw new Error('liquify mode must be push, twirl, bloat or pinch');
      if (!Array.isArray(st.points) || !st.points.length || !(st.size > 0) || !(st.strength > 0 && st.strength <= 1)) throw new Error('liquify stroke needs points, size > 0 and strength 0–1');
      l.liquify = [...(l.liquify || []), { mode: st.mode, points: st.points, size: st.size, strength: st.strength }];
      break;
    }
    case 'layer.maskStroke': {
      // Paint on a layer mask: "hide" removes along the stroke, "reveal" brings back. Follows the layer like other masks.
      const l = byId(doc, op.id);
      if (!['hide', 'reveal'].includes(op.mode)) throw new Error('mask stroke mode must be "hide" or "reveal"');
      addMask(l, { mode: op.mode, stroke: brushStroke(op.stroke), x0: l.x, y0: l.y });
      break;
    }
    case 'selection.invert':
      if (!doc.selection) doc.selection = { items: [{ mode: 'add', shape: { type: 'all' }, dx: 0, dy: 0 }] };
      else doc.selection.items.push({ mode: 'xor', shape: { type: 'all' }, dx: 0, dy: 0 });
      break;
    case 'selection.modify':
      doc.selection = op.shape.bbox ? { items: [{ mode: 'add', shape: op.shape, dx: 0, dy: 0 }] } : null;
      break;
    case 'edit.clear': {
      const l = byId(doc, op.id);
      checkLocks(l, 'pixels');
      addMask(l, { mode: 'hide', sel: op.sel, w: op.w, h: op.h, x0: l.x, y0: l.y });
      break;
    }
    case 'layer.mask': {
      const l = byId(doc, op.id);
      addMask(l, { mode: op.mode ?? 'keep', sel: op.sel, w: op.w, h: op.h, x0: l.x, y0: l.y });
      break;
    }
    case 'layer.unmask':
      delete byId(doc, op.id).mask;
      break;
    case 'layer.fromSelection': {
      const l = byId(doc, op.id), entry = { sel: op.sel, w: op.w, h: op.h, x0: l.x, y0: l.y };
      const copy = { ...structuredClone(l), id: op.newId, name: op.name };
      addMask(copy, { ...entry, mode: 'keep' });
      if (op.cut) addMask(l, { ...entry, mode: 'hide' });
      doc.layers.splice(doc.layers.indexOf(l) + 1, 0, copy);
      bumpId(doc, op.newId);
      break;
    }
    case 'path.add': {
      const p = op.path;
      validatePath(p.subpaths);
      doc.paths ||= [];
      if (doc.paths.some(q => q.id === p.id)) throw new Error(`Path id "${p.id}" already exists`);
      doc.paths.push({ id: p.id, name: p.name, subpaths: p.subpaths });
      doc.nextPathId = Math.max(doc.nextPathId || 1, Number(String(p.id).slice(1)) + 1 || 1);
      break;
    }
    case 'path.update': {
      const p = findPath(doc, op.id);
      if (op.props.subpaths) { validatePath(op.props.subpaths); p.subpaths = op.props.subpaths; }
      if (op.props.name != null) p.name = String(op.props.name);
      break;
    }
    case 'path.remove':
      findPath(doc, op.id);
      doc.paths = doc.paths.filter(p => p.id !== op.id);
      break;
    default:
      throw new Error(`Unknown op type "${op.type}"`);
  }
  return doc;
}

export function applyOp(doc, op) {
  return applyOpMut(structuredClone(doc), op);
}

// Replay a history log. Undo/redo entries move ops between the active and redo stacks.
export function replay(entries) {
  const active = [], redo = [];
  for (const e of entries) {
    if (e.op.type === 'history.undo') { const x = active.pop(); if (x) redo.push(x); }
    else if (e.op.type === 'history.redo') { const x = redo.pop(); if (x) active.push(x); }
    else { active.push(e); redo.length = 0; }
  }
  const doc = newDoc();
  for (const e of active) applyOpMut(doc, e.op);
  return { doc, active, redo };
}

// ---- Human-readable descriptions ---------------------------------------------------------

const RANGE = pts => {
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  return `(${r1(Math.min(...xs))}, ${r1(Math.min(...ys))})–(${r1(Math.max(...xs))}, ${r1(Math.max(...ys))})`;
};
const r1 = n => (typeof n === 'number' ? Math.round(n * 10) / 10 : n);
const pct = n => `${Math.round(n * 100)}%`;

let nameOf = id => `"${id}"`; // set by describe() to look names up in the current doc
function describeProps(l, props) {
  const parts = [];
  if ('x' in props || 'y' in props) parts.push(`moved (${r1(l.x)}, ${r1(l.y)}) → (${r1(props.x ?? l.x)}, ${r1(props.y ?? l.y)})`);
  for (const [k, v] of Object.entries(props)) {
    const old = l[k];
    if (k === 'x' || k === 'y') continue;
    else if (k === 'adjust') for (const [a, av] of Object.entries(v)) parts.push(`${a} ${r1(l.adjust[a])}${ADJUST_UNITS[a]} → ${r1(av)}${ADJUST_UNITS[a]}`);
    else if (k === 'opacity') parts.push(`opacity ${pct(old)} → ${pct(v)}`);
    else if (k === 'liquify') parts.push('liquify reset');
    else if (k === 'path') parts.push(v === null ? 'text no longer follows a path' : v.subpaths ? 'text follows a path' : `text offset along the path ${r1(old?.offset ?? 0)} → ${r1(v.offset ?? 0)}px`);
    else if (k === 'distort') parts.push(v ? `distort ${v.kind ?? old?.kind}: ${Object.entries(v).filter(([dk]) => dk !== 'kind').map(([dk, dn]) => `${dk} ${typeof dn === 'number' ? r1(dn) : dn}`).join(', ') || 'on'}` : 'distort removed');
    else if (k === 'mesh') parts.push(v ? `${v.kind === 'perspective' ? 'perspective (4 corners)' : `warp (${v.cols}×${v.rows} grid)`}` : 'perspective/warp removed');
    else if (k === 'parent') parts.push(v ? `moved into group ${nameOf(v)}` : `moved out of group ${nameOf(old)}`);
    else if (k === 'clip') parts.push(v ? 'clipped to the layer below' : 'no longer clipped');
    else if (k === 'locks') parts.push(v === null ? 'unlocked' : Object.entries(v).map(([lk, lv]) => `${lv ? 'locked' : 'unlocked'} ${lk}`).join(', '));
    else if (k === 'visible') parts.push(v ? 'shown' : 'hidden');
    else if (k === 'rotation') parts.push(`rotation ${r1(old)}° → ${r1(v)}°`);
    else if (k === 'scaleX' || k === 'scaleY') parts.push(`${k === 'scaleX' ? 'width' : 'height'} scale ${pct(old)} → ${pct(v)}`);
    else if (k === 'name') parts.push(`renamed "${old}" → "${v}"`);
    else if (k === 'text') parts.push(`text "${old}" → "${v}"`);
    else if (k === 'levels' || k === 'curves') {
      const fmt = k === 'levels' ? levelsText : curveText;
      if (v === null) parts.push(`reset all ${k}`);
      else for (const [ch, cv] of Object.entries(v)) if (cv !== null || old?.[ch]) parts.push(`${k} (${ch}) ${fmt(old?.[ch])} → ${fmt(cv)}`);
    }
    else if (k === 'colorBalance') {
      if (v === null) { parts.push('reset color balance'); continue; }
      for (const [r, rv] of Object.entries(v)) {
        if (r === 'preserveLuminosity') parts.push(`color balance preserve luminosity ${rv ? 'on' : 'off'}`);
        else parts.push(`color balance (${r}) ${balanceText(old?.[r])} → ${balanceText(rv === null ? null : { ...(old?.[r] || {}), ...rv })}`);
      }
    }
    else if (k in PARAM_SETS) parts.push(`${PARAM_LABELS[k].toLowerCase()} ${settingsDiff(old, v, paramDefaults(PARAM_SETS[k]), PARAM_NAMES)}`);
    else if (k === 'colorToAlpha') parts.push(`color to alpha ${settingsDiff(old, v, C2A_DEFAULT, C2A_NAMES)}`);
    else if (k === 'posterize') parts.push(`posterize ${old ? `${old} levels` : 'off'} → ${v ? `${v} levels` : 'off'}`);
    else if (k === 'threshold') {
      const merged = v && { low: 127, high: 255, channel: 'value', ...(old || {}), ...v };
      parts.push(`threshold ${thresholdText(old)} → ${thresholdText(merged)}`);
    }
    else if (k === 'stops') parts.push(`colors ${stopsText(old)} → ${stopsText(v)}`);
    else parts.push(`${k} ${JSON.stringify(r1(old))} → ${JSON.stringify(r1(v))}`);
  }
  return parts.join('; ') || 'no change';
}

const pathSummary = sps => `${anchorCount(sps)} anchors${sps.length > 1 ? ` in ${sps.length} parts` : ''}${sps.every(sp => sp.closed) ? ', closed' : sps.some(sp => sp.closed) ? ', partly closed' : ', open'}`;
const levelsText = lv => (lv ? `input ${lv.inLow ?? 0}–${lv.inHigh ?? 255}, gamma ${r1(lv.gamma ?? 1)}, output ${lv.outLow ?? 0}–${lv.outHigh ?? 255}` : 'default');
const curveText = pts => (pts ? `[${pts.map(p => p.map(Math.round).join(',')).join(' ')}]` : 'linear');
const balanceText = b => (b ? BALANCE_AXES.map(a => `${{ cyanRed: 'cyan–red', magentaGreen: 'magenta–green', yellowBlue: 'yellow–blue' }[a]} ${b[a] || 0}`).join(', ') : 'neutral');
const PARAM_NAMES = { shadows: 'shadows', highlights: 'highlights', whitepoint: 'white point', radius: 'radius',
  compress: 'compress', shadowsColor: 'shadows color', highlightsColor: 'highlights color',
  stops: 'stops', blackLevel: 'black level', hue: 'hue', chroma: 'chroma', lightness: 'lightness', amount: 'amount', threshold: 'threshold', strength: 'strength',
  size: 'block size', azimuth: 'azimuth', elevation: 'elevation', depth: 'depth', keepColor: 'keep color' };
const C2A_NAMES = { color: 'color', transparency: 'transparency threshold', opacity: 'opacity threshold' };
const r3 = n => (typeof n === 'number' ? Math.round(n * 1000) / 1000 : n);
// Settings objects merged into defaults: "off → on (a 1, b 2)", "a 1 → 3", or "on → off".
function settingsDiff(old, v, defaults, names) {
  if (v === null) return old ? 'removed' : 'already off';
  const next = { ...defaults, ...(old || {}), ...v }, all = k => `${names[k]} ${r3(next[k])}`;
  if (!old) return `on (${Object.keys(defaults).map(all).join(', ')})`;
  const changed = Object.keys(defaults).filter(k => next[k] !== old[k]);
  return changed.map(k => `${names[k]} ${r3(old[k])} → ${r3(next[k])}`).join(', ') || 'no change';
}
const thresholdText = t => (t ? `${t.low}–${t.high} (${t.channel}) → white, rest black` : 'off');
const stopsText = stops => (stops || []).map(s => s[1]).join(' → ');

function layerSummary(l) {
  switch (l.type) {
    case 'image': return `image ${l.w}×${l.h}`;
    case 'text': return `text "${l.text}" (${l.size ?? 48}px ${l.color ?? '#000000'})`;
    case 'shape': {
      const fill = 'fill' in l ? l.fill ?? 'none' : TYPE_DEFAULTS.shape.fill;
      return `${l.shape ?? 'rect'} ${l.w ?? 200}×${l.h ?? 120} fill ${fill}${l.stroke ? `, stroke ${l.stroke}` : ''}`;
    }
    case 'paint': return 'paint layer';
    case 'fill': return `fill layer ${l.color}`;
    case 'gradient': return `${l.kind ?? 'linear'} gradient ${stopsText(l.stops)} from (${r1(l.x1)}, ${r1(l.y1)}) to (${r1(l.x2)}, ${r1(l.y2)})`;
    default: return l.type;
  }
}

export function shapeText(s) {
  switch (s.type) {
    case 'rect': return `rectangle ${r1(s.w)}×${r1(s.h)} at (${r1(s.x)}, ${r1(s.y)})`;
    case 'ellipse': return `ellipse ${r1(s.w)}×${r1(s.h)} at (${r1(s.x)}, ${r1(s.y)})`;
    case 'polygon': return `${s.via ? `${s.via}: ` : ''}free-form area (${s.points.length} points) spanning ${RANGE(s.points)}`;
    case 'path': return `path${s.name ? ` "${s.name}"` : ''} (${anchorCount(s.subpaths)} anchors)`;
    case 'stroke': return `brush stroke (${s.points.length} points, ${s.size}px)`;
    case 'mask': return `${s.via ?? 'mask'} — ${s.bbox ? `${s.bbox[2]}×${s.bbox[3]} area at (${s.bbox[0]}, ${s.bbox[1]})` : 'empty'}`;
    case 'all': return 'the whole canvas';
    default: return s.type;
  }
}

export function selectionText(sel) {
  if (!sel) return 'nothing';
  if (sel.items.length === 1) return shapeText(sel.items[0].shape);
  return `a combined selection (${sel.items.map((it, i) => (i ? `${it.mode === 'xor' ? 'invert' : it.mode} ` : '') + it.shape.type).join(', ')})`;
}

// Describe an op in plain English, given the document *before* the op.
export function describe(op, doc) {
  const nm = id => { const l = doc.layers.find(l => l.id === id); return l ? `"${l.name}"` : id; };
  nameOf = nm;
  switch (op.type) {
    case 'canvas.new': return `New canvas ${op.width}×${op.height}, background ${op.background ?? 'transparent'}`;
    case 'canvas.resize': return `Resized canvas ${doc.width}×${doc.height} → ${op.width}×${op.height} (anchor ${op.anchor || 'center'})`;
    case 'canvas.crop': return `Cropped canvas${op.via === 'selection' ? ' to the selection bounds' : ''} to ${op.width}×${op.height} starting at (${op.x}, ${op.y})`;
    case 'canvas.scale': return `Image size ${doc.width}×${doc.height} → ${op.width}×${op.height} (everything resampled)`;
    case 'doc.import': {
      const g = op.layers.filter(l => l.type === 'group').length;
      if (op.verb === 'Pasted') return `Pasted ${op.source}: ${op.layers.length - g} layer${op.layers.length - g === 1 ? '' : 's'}${g ? ` in ${g} group${g > 1 ? 's' : ''}` : ''}`;
      return `Imported "${op.source}": ${op.layers.length - g} layer${op.layers.length - g === 1 ? '' : 's'}${g ? ` in ${g} group${g > 1 ? 's' : ''}` : ''}`
        + `${op.width ? `, canvas set to ${op.width}×${op.height}` : ''}${op.notes?.length ? ` (${op.notes.join('; ')})` : ''}`;
    }
    case 'guide.add': return `Added a ${op.axis === 'x' ? 'vertical' : 'horizontal'} guide at ${op.axis} = ${r1(op.pos)}`;
    case 'guide.remove': { const g = op.index != null ? doc.guides?.[op.index] : op; return `Removed the ${g?.axis === 'x' ? 'vertical' : 'horizontal'} guide at ${g?.axis} = ${r1(g?.pos)}`; }
    case 'guide.clear': return `Removed all guides (${doc.guides?.length ?? 0})`;
    case 'canvas.background': return `Canvas background ${doc.background ?? 'transparent'} → ${op.color ?? 'transparent'}`;
    case 'layer.add': {
      const l = op.layer, scale = (l.scaleX ?? 1) !== 1 || (l.scaleY ?? 1) !== 1 ? `, scale ${pct(l.scaleX ?? 1)}` : '';
      return `Added ${layerSummary(l)} as layer "${l.name}" (${l.id}) at (${r1(l.x ?? 0)}, ${r1(l.y ?? 0)})${scale}`;
    }
    case 'layer.update': return `Layer ${nm(op.id)}: ${op.via ? `${op.via} — ` : ''}${describeProps(byId(doc, op.id), op.props)}`;
    case 'layer.remove': {
      const n = descendants(doc, op.id).length;
      return `Deleted ${isGroup(byId(doc, op.id)) ? 'group' : 'layer'} ${nm(op.id)}${n ? ` and the ${n} layer${n > 1 ? 's' : ''} in it` : ''}`;
    }
    case 'layer.group': return `Grouped ${op.ids.map(nm).join(', ')} into group "${op.name ?? 'Group'}" (${op.newId})`;
    case 'layer.ungroup': return `Ungrouped ${nm(op.id)} (its layers stay where they are)`;
    case 'layer.move': return `Moved ${isGroup(byId(doc, op.id)) ? 'group' : 'layer'} ${nm(op.id)} by (${r1(op.dx || 0)}, ${r1(op.dy || 0)})`;
    case 'layer.reorder': {
      const from = doc.layers.findIndex(l => l.id === op.id) + 1;
      return `Moved layer ${nm(op.id)} in the stack from position ${from} to ${op.index + 1} of ${doc.layers.length} (1 = bottom)`;
    }
    case 'layer.duplicate': {
      const offset = op.dx || op.dy ? `, offset by (${op.dx ?? 0}, ${op.dy ?? 0})` : '';
      return `Duplicated layer ${nm(op.id)} as "${op.name ?? byId(doc, op.id).name + ' copy'}" (${op.newId})${offset}`;
    }
    case 'layer.merge': return op.flatten
      ? `Flattened all layers and background into "${op.name}" (${op.newId})`
      : `Merged layers ${op.ids.map(nm).join(', ')} into "${op.name}" (${op.newId})`;
    case 'paint.stroke': {
      if (op.stroke.subpaths) return `${op.via ?? 'Stroked a path'} on ${nm(op.id)}${op.stroke.clip ? ', limited to the selection' : ''}`;
      const s = op.stroke, xs = s.points.map(p => p[0]), ys = s.points.map(p => p[1]);
      const box = `(${r1(Math.min(...xs))}, ${r1(Math.min(...ys))})–(${r1(Math.max(...xs))}, ${r1(Math.max(...ys))})`;
      if (s.patch) {
        const from = s.sample === 'merged' ? 'the image' : `layer ${nm(s.sample)}`, base = `a ${s.points.length}-point stroke on ${nm(op.id)}`;
        const brush = `size ${s.size}px, hardness ${s.hardness}, spanning ${box}`;
        if (s.patch === 'smudge') return `Smudged ${base} (rate ${s.rate}${s.flow ? `, flow ${s.flow} with ${s.color}` : ''}${s.sample === 'merged' ? '' : `, sampling ${from}`}), ${brush}`;
        if (s.patch === 'blur' || s.patch === 'sharpen') return `${s.patch === 'blur' ? 'Blurred' : 'Sharpened'} along ${base} (strength ${s.strength}), ${brush}`;
        if (s.patch === 'dodge' || s.patch === 'burn') return `${s.patch === 'dodge' ? 'Dodged' : 'Burned'} the ${s.range} along ${base} (exposure ${s.exposure}${s.sample === 'merged' ? '' : `, from ${from}`}), ${brush}`;
        return `${s.patch === 'heal' ? 'Healed' : 'Cloned'} ${base} from ${from} ${r1(Math.abs(s.offset[0]))}px ${s.offset[0] < 0 ? 'left' : 'right'}, `
          + `${r1(Math.abs(s.offset[1]))}px ${s.offset[1] < 0 ? 'up' : 'down'}, ${brush}`;
      }
      const extra = [(s.opacity ?? 1) !== 1 ? `opacity ${pct(s.opacity)}` : '', (s.hardness ?? 1) !== 1 ? `hardness ${s.hardness}` : '',
        s.blend && s.blend !== 'normal' ? `blend ${s.blend}` : '', s.points[0]?.length > 2 ? 'pen pressure' : ''].filter(Boolean).join(', ');
      return `${s.erase ? 'Erased with' : 'Painted'} a ${s.points.length}-point stroke on ${nm(op.id)}${s.erase ? '' : `, color ${s.color}`}, size ${s.size}px${extra ? `, ${extra}` : ''}, spanning ${box}${s.clip ? ', limited to the selection' : ''}`;
    }
    case 'selection.set': {
      const verb = { replace: 'Selected', add: 'Added to selection:', subtract: 'Subtracted from selection:', intersect: 'Intersected selection with' }[op.mode ?? 'replace'];
      return `${verb} ${shapeText(op.shape)}`;
    }
    case 'selection.all': return 'Selected all';
    case 'selection.none': return 'Selected none (cleared the selection)';
    case 'selection.invert': return 'Inverted the selection';
    case 'selection.transform': return `Transformed the selection outline (${op.via ?? 'matrix'})`;
    case 'channel.save': return `Saved the selection as channel "${op.name}" (${op.shape.bbox ? `${op.shape.bbox[2]}×${op.shape.bbox[3]} area` : 'empty'})`;
    case 'channel.remove': return `Deleted channel "${op.name}"`;
    case 'selection.translate': return `Moved the selection outline by (${r1(op.dx || 0)}, ${r1(op.dy || 0)})`;
    case 'selection.paint': return `${op.mode === 'subtract' ? 'Removed from' : 'Added to'} the selection with a ${op.stroke.points.length}-point brush stroke (quick mask), size ${op.stroke.size ?? 20}px`;
    case 'layer.liquify': return `Liquify (${op.stroke.mode}) on ${nm(op.id)}: a ${op.stroke.points.length}-point stroke, size ${r1(op.stroke.size)}px, strength ${op.stroke.strength}`;
    case 'layer.maskStroke': return `${op.mode === 'hide' ? 'Hid' : 'Revealed'} part of layer ${nm(op.id)} by painting its mask (${op.stroke.points.length}-point stroke, size ${op.stroke.size ?? 20}px)`;
    case 'selection.modify': return op.kind === 'border'
      ? `Turned the selection into a ${op.radius}px border`
      : `${{ feather: 'Feathered', grow: 'Grew', shrink: 'Shrank' }[op.kind]} the selection by ${op.radius}px`;
    case 'edit.clear': return `Cleared ${selectionText(op.sel)} on layer ${nm(op.id)} (hidden with a layer mask, undoable)`;
    case 'edit.fill': return `${op.via ?? `Filled ${op.selText} with ${op.layer.color}`} as new layer "${op.layer.name}" (${op.layer.id})`;
    case 'layer.mask': return `Added a layer mask to ${nm(op.id)} from ${selectionText(op.sel)} (${(op.mode ?? 'keep') === 'keep' ? 'showing only the selection' : 'hiding the selection'})`;
    case 'layer.unmask': return `Removed the layer mask from ${nm(op.id)}`;
    case 'layer.fromSelection': return `${op.cut ? 'Cut' : 'Copied'} ${selectionText(op.sel)} from ${nm(op.id)} to new layer "${op.name}" (${op.newId})`;
    case 'path.add': return `Added path "${op.path.name}" (${op.path.id}): ${pathSummary(op.path.subpaths)}`;
    case 'path.update': {
      const p = findPath(doc, op.id), parts = [];
      if (op.props.subpaths) parts.push(`reshaped ${pathSummary(p.subpaths)} → ${pathSummary(op.props.subpaths)}`);
      if (op.props.name != null) parts.push(`renamed "${p.name}" → "${op.props.name}"`);
      return `Path "${p.name}" (${p.id}): ${op.via ? `${op.via} — ` : ''}${parts.join('; ') || 'no change'}`;
    }
    case 'path.remove': return `Deleted path "${findPath(doc, op.id).name}" (${op.id})`;
    case 'history.undo': return `Undo #${op.target}: ${op.targetText}`;
    case 'history.redo': return `Redo #${op.target}: ${op.targetText}`;
    default: return op.type;
  }
}
