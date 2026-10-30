// Node-only project storage. A project directory contains:
//   history.jsonl  append-only log, one {seq, ts, author, op, text} entry per line (source of truth)
//   assets/        content-addressed image files referenced by image layers
//   state.json     cached current document (for humans and tools; regenerated on every commit)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { replay, describe, applyOp, findLayer, findPath, selectionText, GRADIENT_KINDS } from './model.js';
import { parseSvgPath, mapPath, validatePath, flatten } from './paths.js';
import { histogram, histogramStats, percentile, withoutTone, dodgeBurnLUT, hexRgb } from './tone.js';
import { render, preload, selectionMask, strokePath, layerMatrix, invert, apply, paintOrder, layerSize, defaultMesh, assetsOf } from './render.js';
import { heal } from './heal.js';
import { edgeCost, scissorsOutline, foregroundMask } from './smartselect.js';
import { toPsd, fromPsd, toPdf, toSvg, toXcf, fromXcf } from './formats.js';
import { smudge } from './smudge.js';

export const historyFile = dir => path.join(dir, 'history.jsonl');
export const isProject = dir => fs.existsSync(historyFile(dir));

export function readEntries(dir) {
  return fs.readFileSync(historyFile(dir), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

export function loadState(dir) {
  const entries = readEntries(dir);
  return { entries, ...replay(entries) };
}

// Entries that are currently undone (not part of the document).
export function undoneSeqs(state) {
  const live = new Set(state.active.map(e => e.seq));
  return new Set(state.entries.filter(e => !e.op.type.startsWith('history.') && !live.has(e.seq)).map(e => e.seq));
}

export async function importAsset(dir, input, nameHint) {
  const buf = Buffer.isBuffer(input) ? input : fs.readFileSync(input);
  const img = await loadImage(buf);
  const ext = (path.extname(nameHint || (Buffer.isBuffer(input) ? '' : input)) || '.png').toLowerCase();
  const asset = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12) + ext;
  const file = path.join(dir, 'assets', asset);
  if (!fs.existsSync(file)) fs.writeFileSync(file, buf);
  return { asset, w: img.width, h: img.height };
}

export function nodeEnv(dir) {
  return {
    images: new Map(),
    paintCache: new Map(),
    makeCanvas: (w, h) => createCanvas(w, h),
    loadAsset: a => loadImage(path.join(dir, 'assets', a)),
  };
}

export async function renderCanvas(dir, doc, opts = {}) {
  const canvas = createCanvas(doc.width, doc.height);
  const env = nodeEnv(dir);
  await preload(doc, env);
  render(canvas.getContext('2d'), doc, env, opts);
  return canvas;
}

export async function encode(canvas, format = 'png', quality = 92) {
  const f = format === 'jpg' ? 'jpeg' : format;
  if (!['png', 'jpeg', 'webp', 'avif'].includes(f)) throw new Error(`Unsupported export format "${format}"`);
  return canvas.encode(f, quality);
}

// Render the document to a file format: png/jpeg/webp/avif, psd (layers), pdf, svg. Returns { buffer, notes }.
export async function exportBuffer(dir, format, { layers, quality, transparent, dpi } = {}) {
  const { doc } = loadState(dir), f = format === 'jpg' ? 'jpeg' : format;
  if (f === 'psd' || f === 'xcf') {
    const r = await (f === 'psd' ? toPsd : toXcf)(renderCanvas, dir, doc);
    return { buffer: r.buffer, notes: r.skipped.length ? [`adjustment layers left out: ${r.skipped.join(', ')}`] : [] };
  }
  if (f === 'svg') { const r = await toSvg(renderCanvas, dir, doc); return { buffer: Buffer.from(r.svg), notes: r.notes }; }
  const only = layers ? layers.map(ref => findLayer(doc, ref).id) : null;
  const canvas = await renderCanvas(dir, doc, { only, background: !transparent });
  if (f === 'pdf') return { buffer: toPdf(canvas, { dpi }), notes: [] };
  return { buffer: await encode(canvas, f, quality), notes: [] };
}

export async function exportImage(dir, out, opts = {}) {
  const { doc } = loadState(dir);
  const { buffer, notes } = await exportBuffer(dir, path.extname(out).slice(1).toLowerCase() || 'png', opts);
  fs.writeFileSync(out, buffer);
  return { width: doc.width, height: doc.height, bytes: buffer.length, notes };
}

const cap = s => s[0].toUpperCase() + s.slice(1);

// ---- Selection rasters (Node side of fuzzy select, grow/shrink, crop to selection) ---------

export async function selectionCanvas(dir, doc, sel) {
  const env = nodeEnv(dir);
  await preload(sel, env);
  return selectionMask(sel, doc.width, doc.height, env);
}

const alphaOf = canvas => {
  const { width: w, height: h } = canvas, d = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  const bin = new Uint8Array(w * h);
  for (let i = 0; i < bin.length; i++) bin[i] = d[i * 4 + 3] >= 128 ? 1 : 0;
  return bin;
};

function binaryCanvas(bin, w, h) {
  const c = createCanvas(w, h), x = c.getContext('2d'), img = x.createImageData(w, h);
  for (let i = 0; i < bin.length; i++) if (bin[i]) img.data.set([255, 255, 255, 255], i * 4);
  x.putImageData(img, 0, 0);
  return c;
}

export function maskStats(canvas) {
  const { width: w, height: h } = canvas, d = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1, area = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (d[(y * w + x) * 4 + 3] < 128) continue;
    area++;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { bbox: x1 < 0 ? null : [x0, y0, x1 - x0 + 1, y1 - y0 + 1], area };
}

// Square dilation by r px (separable sliding window).
function dilate(bin, w, h, r) {
  const pass = (src, len, count, idx) => {
    const out = new Uint8Array(src.length), pre = new Int32Array(len + 1);
    for (let k = 0; k < count; k++) {
      for (let i = 0; i < len; i++) pre[i + 1] = pre[i] + src[idx(k, i)];
      for (let i = 0; i < len; i++) out[idx(k, i)] = pre[Math.min(len, i + r + 1)] - pre[Math.max(0, i - r)] > 0 ? 1 : 0;
    }
    return out;
  };
  const rows = pass(bin, w, h, (y, x) => y * w + x);
  return pass(rows, h, w, (x, y) => y * w + x);
}
const invertBin = bin => bin.map(v => 1 - v);

async function maskShape(dir, canvas, via) {
  const { width: w, height: h } = canvas, x = canvas.getContext('2d'), img = x.getImageData(0, 0, w, h);
  for (let i = 0; i < img.data.length; i += 4) img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
  const c = createCanvas(w, h);
  c.getContext('2d').putImageData(img, 0, 0);
  const { asset } = await importAsset(dir, await encode(c, 'png'), 'mask.png');
  return { type: 'mask', asset, via, ...maskStats(c) };
}

// Fuzzy select (contiguous) / select by color (all matching pixels). Samples the merged image or one layer.
async function wandCanvas(dir, doc, { x, y, threshold = 32, contiguous = true, layer, color }) {
  const src = await renderCanvas(dir, doc, layer ? { only: [layer], background: false } : {});
  const { width: w, height: h } = src, d = src.getContext('2d').getImageData(0, 0, w, h).data;
  let seed;
  if (color) {
    const hex = String(color).replace('#', '');
    seed = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16)).concat(255);
    contiguous = false;
  } else {
    x = Math.floor(x); y = Math.floor(y);
    if (!(x >= 0 && y >= 0 && x < w && y < h)) throw new Error(`Point (${x}, ${y}) is outside the ${w}×${h} canvas`);
    seed = [...d.slice((y * w + x) * 4, (y * w + x) * 4 + 4)];
  }
  const match = i => Math.max(Math.abs(d[i * 4] - seed[0]), Math.abs(d[i * 4 + 1] - seed[1]), Math.abs(d[i * 4 + 2] - seed[2]), Math.abs(d[i * 4 + 3] - seed[3])) <= threshold;
  const bin = new Uint8Array(w * h);
  if (!contiguous) for (let i = 0; i < bin.length; i++) bin[i] = match(i) ? 1 : 0;
  else {
    const stack = [y * w + x];
    bin[stack[0]] = 1;
    while (stack.length) {
      const i = stack.pop(), px = i % w;
      for (const n of [px > 0 ? i - 1 : -1, px < w - 1 ? i + 1 : -1, i - w, i + w]) {
        if (n >= 0 && n < bin.length && !bin[n] && match(n)) { bin[n] = 1; stack.push(n); }
      }
    }
  }
  return binaryCanvas(bin, w, h);
}

// Histogram of one layer's pixels (before its own tone adjustments), or of the merged image.
export async function layerHistogram(dir, doc, ref) {
  let d = doc, only;
  const adj = ref && findLayer(doc, ref);
  if (adj?.type === 'adjustment') { // what the adjustment acts on: everything painted below it
    const order = paintOrder(doc);
    return histogram((await renderCanvas(dir, doc, { only: order.slice(0, order.indexOf(adj)).map(l => l.id) })).getContext('2d').getImageData(0, 0, doc.width, doc.height));
  }
  if (ref) {
    const l = findLayer(doc, ref);
    d = { ...doc, layers: doc.layers.map(x => (x.id === l.id ? { ...withoutTone(x), opacity: 1, blend: 'normal', visible: true } : x)) };
    only = [l.id];
  }
  const c = await renderCanvas(dir, d, only ? { only, background: false } : {});
  return histogram(c.getContext('2d').getImageData(0, 0, c.width, c.height));
}

export { histogramStats };

// Smudge: run GIMP's smudge over the stroke's region of the source (merged image or one layer) and keep
// the pixels the brush touched.
async function smudgePatch(dir, doc, { points, size, hardness, rate, flow, color, sample }) {
  const pad = Math.ceil(size / 2) + 2, xs = points.map(p => p[0]), ys = points.map(p => p[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs) - pad)), y0 = Math.max(0, Math.floor(Math.min(...ys) - pad));
  const x1 = Math.min(doc.width, Math.ceil(Math.max(...xs) + pad)), y1 = Math.min(doc.height, Math.ceil(Math.max(...ys) + pad));
  const w = x1 - x0, h = y1 - y0;
  if (w <= 0 || h <= 0) throw new Error('The stroke is outside the canvas');
  const solo = sample && { ...doc, layers: doc.layers.map(l => (l.id === sample ? { ...l, opacity: 1, blend: 'normal', visible: true } : l)) };
  const full = sample ? await renderCanvas(dir, solo, { only: [sample], background: false }) : await renderCanvas(dir, doc);
  const reg = createCanvas(w, h), rc = reg.getContext('2d');
  rc.drawImage(full, -x0, -y0);
  const img = rc.getImageData(0, 0, w, h), d = img.data, work = new Float32Array(w * h * 4);
  for (let i = 0; i < d.length; i++) work[i] = d[i] / 255;
  let limit = null;
  if (doc.selection) {
    const sel = createCanvas(w, h), sc = sel.getContext('2d');
    sc.drawImage(await selectionCanvas(dir, doc, doc.selection), -x0, -y0);
    const sd = sc.getImageData(0, 0, w, h).data;
    limit = new Float32Array(w * h).map((_, i) => sd[i * 4 + 3] / 255);
  }
  const coverage = smudge(work, w, h, points.map(([x, y]) => [x - x0, y - y0]), { size, hardness, rate, flow, color: [...hexRgb(color), 1], limit });
  let any = false;
  for (let i = 0; i < w * h; i++) {
    const on = coverage[i] > 0;
    for (let c = 0; c < 3; c++) d[i * 4 + c] = Math.round(work[i * 4 + c] * 255);
    d[i * 4 + 3] = on ? Math.round(work[i * 4 + 3] * 255) : 0;
    if (on && d[i * 4 + 3]) any = true;
  }
  if (!any) throw new Error(`Nothing to smudge there${doc.selection ? ' (the stroke is outside the selection)' : ''}`);
  rc.putImageData(img, 0, 0);
  return { x: x0, y: y0, w, h, png: await reg.encode('png') };
}

// Like GIMP, painting is limited to the active selection unless clip is explicitly false.
function clipToSelection(doc, l, stroke, clip = stroke.clip) {
  delete stroke.clip;
  if (clip !== false && doc.selection) stroke.clip = { sel: doc.selection, w: doc.width, h: doc.height, dx: -l.x, dy: -l.y };
}

// Clone / heal: bake one stroke into an image patch in canvas coordinates. The source is the merged image
// (or one layer as it looks) shifted by offset; heal then blends it into what is under the stroke.
async function clonePatch(dir, doc, { points, size, hardness, offset: [dx, dy], sample, healing, lut, verb, focus }) {
  const sigma = (size * (1 - hardness)) / 4, pad = Math.ceil(size / 2 + 3 * sigma) + 2;
  const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs) - pad)), y0 = Math.max(0, Math.floor(Math.min(...ys) - pad));
  const x1 = Math.min(doc.width, Math.ceil(Math.max(...xs) + pad)), y1 = Math.min(doc.height, Math.ceil(Math.max(...ys) + pad));
  const w = x1 - x0, h = y1 - y0;
  if (w <= 0 || h <= 0) throw new Error('The stroke is outside the canvas');

  // Brush mask: the stroke, softened by hardness, limited to the selection.
  const stroke = createCanvas(w, h), sc = stroke.getContext('2d');
  sc.translate(-x0, -y0);
  strokePath(sc, { color: '#fff', size, points });
  const mask = createCanvas(w, h), mc = mask.getContext('2d');
  if (sigma >= 0.3) mc.filter = `blur(${sigma}px)`;
  mc.drawImage(stroke, 0, 0);
  mc.filter = 'none';
  if (doc.selection) {
    mc.globalCompositeOperation = 'destination-in';
    mc.drawImage(await selectionCanvas(dir, doc, doc.selection), -x0, -y0);
  }
  const m = mc.getImageData(0, 0, w, h).data;

  const region = (c, sx, sy) => {
    const o = createCanvas(w, h);
    o.getContext('2d').drawImage(c, -sx, -sy);
    return o.getContext('2d').getImageData(0, 0, w, h);
  };
  const solo = sample && { ...doc, layers: doc.layers.map(l => (l.id === sample ? { ...l, opacity: 1, blend: 'normal', visible: true } : l)) };
  const merged = await renderCanvas(dir, doc);
  const srcCanvas = sample ? await renderCanvas(dir, solo, { only: [sample], background: false }) : merged;
  const src = region(srcCanvas, x0 + dx, y0 + dy);
  if (focus) { // blur / sharpen brush: filter a margin-padded region so its edges don't pull in transparency
    const m = Math.ceil(focus.radius * 3) + 1, big = createCanvas(w + 2 * m, h + 2 * m), bc = big.getContext('2d');
    bc.filter = `blur(${focus.radius}px)`;
    bc.drawImage(srcCanvas, -(x0 - m), -(y0 - m));
    const blurred = bc.getImageData(m, m, w, h).data, d = src.data;
    for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) {
      d[i + c] = focus.kind === 'blur' ? blurred[i + c] : Math.max(0, Math.min(255, Math.round(d[i + c] + focus.amount * (d[i + c] - blurred[i + c]))));
    }
  }
  let px = src.data;
  if (healing) {
    const inside = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) inside[i] = m[i * 4 + 3] > 0 ? 1 : 0;
    px = heal(src.data, region(merged, x0, y0).data, inside, w, h);
  }
  if (lut) for (let i = 0; i < w * h * 4; i += 4) { px[i] = lut[px[i]]; px[i + 1] = lut[px[i + 1]]; px[i + 2] = lut[px[i + 2]]; }
  let any = false;
  for (let i = 0; i < w * h; i++) {
    px[i * 4 + 3] = Math.round((px[i * 4 + 3] * m[i * 4 + 3]) / 255);
    if (px[i * 4 + 3]) any = true;
  }
  if (!any) throw new Error(`Nothing to ${verb} there (the source area is empty${doc.selection ? ' or outside the selection' : ''})`);
  const out = createCanvas(w, h);
  if (px !== src.data) src.data.set(px);
  out.getContext('2d').putImageData(src, 0, 0);
  return { x: x0, y: y0, w, h, png: await out.encode('png') };
}

const hex2 = n => n.toString(16).padStart(2, '0');
const pixel = c => {
  const [r, g, b, a] = c.getContext('2d').getImageData(0, 0, 1, 1).data;
  return { hex: `#${hex2(r)}${hex2(g)}${hex2(b)}`, r, g, b, alpha: Math.round((a / 255) * 1000) / 1000,
    value: Math.max(r, g, b), lightness: Math.round((Math.max(r, g, b) + Math.min(r, g, b)) / 2) };
};

// Color at a canvas point: of the merged image, or of one layer drawn alone both before and after its
// own tone adjustments (skip = tone keys to leave out of "after", e.g. ['colorToAlpha']).
export async function pickColor(dir, doc, x, y, { layer: ref, skip = [] } = {}) {
  x = Math.floor(x); y = Math.floor(y);
  if (!(x >= 0 && y >= 0 && x < doc.width && y < doc.height)) throw new Error(`(${x}, ${y}) is outside the ${doc.width}×${doc.height} canvas`);
  const at = async (d, opts) => {
    const c = await renderCanvas(dir, d, opts), o = createCanvas(1, 1);
    o.getContext('2d').drawImage(c, x, y, 1, 1, 0, 0, 1, 1);
    return pixel(o);
  };
  if (!ref) return { x, y, image: await at(doc) };
  const l = findLayer(doc, ref), solo = props => ({ ...doc, layers: doc.layers.map(q => (q.id === l.id ? { ...q, ...props, opacity: 1, blend: 'normal', visible: true } : q)) });
  const opts = { only: [l.id], background: false };
  const before = solo(withoutTone(l)), after = solo(Object.fromEntries(skip.map(k => [k, undefined])));
  return { x, y, layer: { id: l.id, name: l.name }, before: await at(before, opts), after: await at(after, opts) };
}

function requireSelection(doc) {
  if (!doc.selection) throw new Error('Nothing is selected. Make a selection first (e.g. "select rect x y w h").');
  return doc.selection;
}

async function modifySelection(dir, doc, kind, r) {
  const cur = await selectionCanvas(dir, doc, requireSelection(doc));
  const { width: w, height: h } = cur;
  if (kind === 'feather') {
    const c = createCanvas(w, h), x = c.getContext('2d');
    x.filter = `blur(${r / 2}px)`;
    x.drawImage(cur, 0, 0);
    return c;
  }
  const bin = alphaOf(cur);
  const grown = () => dilate(bin, w, h, r), shrunk = () => invertBin(dilate(invertBin(bin), w, h, r));
  if (kind === 'grow') return binaryCanvas(grown(), w, h);
  if (kind === 'shrink') return binaryCanvas(shrunk(), w, h);
  if (kind === 'border') { const g = grown(), s = shrunk(); return binaryCanvas(g.map((v, i) => v & (1 - s[i])), w, h); }
  throw new Error(`Unknown selection modification "${kind}" (expected feather, grow, shrink, border)`);
}

// New image layers: fit: "contain" | "cover" scales to the canvas; otherwise centre when no position is given.
function placeImage(l, doc) {
  if (l.fit) {
    const s = (l.fit === 'cover' ? Math.max : Math.min)(doc.width / l.w, doc.height / l.h);
    Object.assign(l, { scaleX: s, scaleY: s, x: Math.round((doc.width - l.w * s) / 2), y: Math.round((doc.height - l.h * s) / 2) });
  } else if (l.x === undefined && l.y === undefined) {
    Object.assign(l, { x: Math.round((doc.width - l.w) / 2), y: Math.round((doc.height - l.h) / 2) });
  }
  delete l.fit;
}

// Turn a user/CLI op (names, file paths, "top") into a concrete, replayable op.
async function materialize(dir, input, state) {
  const op = structuredClone(input), { doc } = state;
  const ref = r => findLayer(doc, r).id;
  switch (op.type) {
    case 'layer.add': {
      const l = op.layer ||= {};
      if (l.src) {
        Object.assign(l, await importAsset(dir, path.resolve(l.src)));
        l.name ??= path.basename(l.src);
        delete l.src;
      }
      if (l.type === 'image' && !l.asset) throw new Error('Image layers need "src" (a file path) or "asset"');
      if (l.type === 'image') placeImage(l, doc);
      l.id = `L${doc.nextId}`;
      if (l.type === 'text') l.name ??= String(l.text ?? 'Text').split('\n')[0].slice(0, 40);
      l.name ??= `${cap(l.type || 'layer')} ${doc.layers.filter(x => x.type === l.type).length + 1}`;
      break;
    }
    case 'layer.update': case 'layer.remove': case 'layer.unmask':
      op.id = ref(op.id);
      break;
    case 'paint.stroke': {
      op.id = ref(op.id);
      clipToSelection(doc, findLayer(doc, op.id), op.stroke);
      break;
    }
    case 'path.add': {
      const p = op.path ||= {};
      if (p.d != null) { p.subpaths = parseSvgPath(p.d); delete p.d; }
      validatePath(p.subpaths);
      p.id = `P${doc.nextPathId ?? 1}`;
      p.name ??= `Path ${(doc.paths?.length ?? 0) + 1}`;
      break;
    }
    case 'path.update': {
      op.id = findPath(doc, op.id).id;
      if (op.props?.d != null) { op.props.subpaths = parseSvgPath(op.props.d); delete op.props.d; }
      if (op.dx || op.dy) { // move the whole path
        op.props = { ...(op.props || {}), subpaths: mapPath(op.props?.subpaths ?? findPath(doc, op.id).subpaths, ([x, y]) => [x + (op.dx || 0), y + (op.dy || 0)]) };
        op.via = `moved by (${op.dx || 0}, ${op.dy || 0})`;
        delete op.dx; delete op.dy;
      }
      op.props ||= {};
      break;
    }
    case 'path.remove':
      op.id = findPath(doc, op.id).id;
      break;
    case 'path.select': {
      // Path → selection (GIMP: Selection from Path); mode replace|add|subtract|intersect.
      const p = findPath(doc, op.id);
      return { type: 'selection.set', mode: op.mode ?? 'replace', shape: { type: 'path', name: p.name, subpaths: p.subpaths } };
    }
    case 'path.fill': {
      // Fill the inside of the path with a color, as a new fill layer masked by the path.
      const p = findPath(doc, op.id), color = op.color || '#000000';
      const sel = { items: [{ mode: 'add', shape: { type: 'path', name: p.name, subpaths: p.subpaths }, dx: 0, dy: 0 }] };
      const layer = { type: 'fill', id: `L${doc.nextId}`, name: op.name ?? `Fill ${p.name}`, color, w: doc.width, h: doc.height,
        mask: [{ mode: 'keep', sel, w: doc.width, h: doc.height, x0: 0, y0: 0 }] };
      return { type: 'edit.fill', layer, via: `Filled path "${p.name}" with ${color}`, selText: selectionText(sel) };
    }
    case 'path.stroke': {
      // Stroke the path with a brush line: onto an existing paint layer (`layer`), or as a new paint layer.
      const p = findPath(doc, op.id), color = op.color || '#000000', size = op.size ?? 4;
      if (!(size > 0)) throw new Error('size must be positive');
      const via = `Stroked path "${p.name}" with ${color}, ${size}px`;
      if (op.layer) {
        const l = findLayer(doc, op.layer);
        if (l.type !== 'paint') throw new Error(`Layer "${l.name}" is a ${l.type} layer; strokes need a paint layer (or leave out the layer to make a new one)`);
        const inv = invert(layerMatrix(l, { w: l.w, h: l.h })), stroke = { color, size, subpaths: mapPath(p.subpaths, ([x, y]) => apply(inv, x, y)) };
        clipToSelection(doc, l, stroke, op.clip);
        return { type: 'paint.stroke', id: l.id, stroke, via };
      }
      const layer = { type: 'paint', id: `L${doc.nextId}`, name: op.name ?? `Stroke ${p.name}`, w: doc.width, h: doc.height, x: 0, y: 0, strokes: [] };
      const stroke = { color, size, subpaths: p.subpaths };
      clipToSelection(doc, layer, stroke, op.clip);
      layer.strokes.push(stroke);
      return { type: 'edit.fill', layer, via, selText: '' };
    }
    case 'canvas.crop':
      if (op.toSelection) {
        const { bbox } = maskStats(await selectionCanvas(dir, doc, requireSelection(doc)));
        if (!bbox) throw new Error('The selection is empty');
        Object.assign(op, { x: bbox[0], y: bbox[1], width: bbox[2], height: bbox[3], via: 'selection' });
        delete op.toSelection;
      }
      break;
    case 'selection.set': {
      const s = op.shape ||= {};
      if (s.type === 'wand' || s.type === 'color') {
        const id = s.layer ? ref(s.layer) : null, on = id ? ` on layer "${findLayer(doc, id).name}"` : '';
        const threshold = s.threshold ?? 32, contiguous = s.type === 'wand' && s.contiguous !== false;
        const via = s.color ? `pixels matching ${s.color}${on}, threshold ${threshold}`
          : `${contiguous ? 'fuzzy select' : 'select by color'} at (${Math.floor(s.x)}, ${Math.floor(s.y)})${on}, threshold ${threshold}`;
        op.shape = await maskShape(dir, await wandCanvas(dir, doc, { ...s, threshold, contiguous, layer: id }), via);
      } else if (s.type === 'alpha') {
        const l = findLayer(doc, s.layer);
        op.shape = await maskShape(dir, await renderCanvas(dir, doc, { only: [l.id], background: false }), `opaque pixels of layer "${l.name}"`);
      } else if (s.type === 'rect' || s.type === 'ellipse') {
        for (const k of ['x', 'y', 'w', 'h']) s[k] = Math.round(Number(s[k]));
        if (s.w < 0) { s.x += s.w; s.w = -s.w; }
        if (s.h < 0) { s.y += s.h; s.h = -s.h; }
        if (!(s.w > 0 && s.h > 0)) throw new Error('Selection width and height must be positive');
      } else if (s.type === 'polygon') {
        if (!(s.points?.length >= 3)) throw new Error('A free selection needs at least 3 points');
      }
      break;
    }
    case 'selection.modify': {
      const r = Number(op.radius);
      if (!(r > 0)) throw new Error('radius must be a positive number of pixels');
      op.radius = r;
      op.shape = await maskShape(dir, await modifySelection(dir, doc, op.kind, r), `${op.kind} ${r}px`);
      break;
    }
    case 'edit.clear': case 'layer.mask':
      op.id = ref(op.id);
      Object.assign(op, { sel: requireSelection(doc), w: doc.width, h: doc.height });
      break;
    case 'layer.fromSelection': {
      const l = findLayer(doc, op.id);
      Object.assign(op, { id: l.id, sel: requireSelection(doc), w: doc.width, h: doc.height, newId: `L${doc.nextId}`, name: op.name ?? `${l.name} (${op.cut ? 'cut' : 'copy'})` });
      break;
    }
    case 'edit.gradient': {
      const kind = op.kind ?? 'linear';
      if (!GRADIENT_KINDS.includes(kind)) throw new Error(`Unknown gradient type "${kind}" (expected ${GRADIENT_KINDS.join(', ')})`);
      const pts = ['x1', 'y1', 'x2', 'y2'].map(k => Number(op[k]));
      if (!pts.every(Number.isFinite)) throw new Error('A gradient needs start and end points x1 y1 x2 y2');
      if (pts[0] === pts[2] && pts[1] === pts[3]) throw new Error('Gradient start and end points must differ');
      const from = op.from || '#000000', to = op.to || '#ffffff', sel = doc.selection;
      const layer = { type: 'gradient', id: `L${doc.nextId}`, name: op.name ?? `${cap(kind)} gradient`, kind,
        x1: pts[0], y1: pts[1], x2: pts[2], y2: pts[3], stops: [[0, from], [1, to]], w: doc.width, h: doc.height };
      if (sel) layer.mask = [{ mode: 'keep', sel, w: doc.width, h: doc.height, x0: 0, y0: 0 }];
      const via = `Drew a ${kind} gradient ${from} → ${to} from (${pts[0]}, ${pts[1]}) to (${pts[2]}, ${pts[3]}) in ${sel ? selectionText(sel) : 'the whole canvas'}`;
      return { type: 'edit.fill', layer, via };
    }
    case 'layer.autoLevels': {
      // GIMP-style auto: stretch each of r, g, b so 0.5% of pixels clip at either end.
      const l = findLayer(doc, op.id), h = await layerHistogram(dir, doc, l.id);
      if (!h.count) throw new Error(`Layer "${l.name}" has no visible pixels`);
      const levels = { value: null };
      for (const c of ['r', 'g', 'b']) {
        const lo = percentile(h[c], h.count, 0.005), hi = Math.max(lo + 1, percentile(h[c], h.count, 0.995));
        levels[c] = { inLow: lo, inHigh: hi };
      }
      return { type: 'layer.update', id: l.id, props: { levels }, via: 'Auto levels' };
    }
    case 'paint.clone': case 'paint.heal': case 'paint.dodge': case 'paint.burn': case 'paint.smudge': case 'paint.blur': case 'paint.sharpen': {
      // Retouching strokes onto a paint layer, baked into an image patch. Points are canvas coordinates.
      // clone/heal sample at `from` (where the first point samples) or `offset` (source − destination).
      const verb = op.type.slice(6), l = findLayer(doc, op.id);
      if (l.type !== 'paint') throw new Error(`Layer "${l.name}" is a ${l.type} layer; ${verb} paints on a paint layer (add one with "add paint")`);
      if (l.rotation || l.scaleX !== 1 || l.scaleY !== 1) throw new Error(`Layer "${l.name}" is rotated or scaled; ${verb} needs an untransformed paint layer`);
      const points = op.points;
      if (!Array.isArray(points) || !points.length || !points.every(p => Number.isFinite(p?.[0]) && Number.isFinite(p?.[1]))) throw new Error(`${verb} needs points: [[x, y], ...]`);
      const size = op.size ?? 20, hardness = op.hardness ?? 0.75;
      if (!(size > 0)) throw new Error('size must be positive');
      if (!(hardness >= 0 && hardness <= 1)) throw new Error('hardness must be between 0 and 1');
      const sample = op.sample && op.sample !== 'merged' ? ref(op.sample) : null;
      const stroke = { patch: verb, points: points.map(([x, y]) => [x - l.x, y - l.y]), size, hardness, sample: sample ?? 'merged' };
      let p;
      if (verb === 'clone' || verb === 'heal') {
        const offset = op.offset ?? (op.from && [op.from[0] - points[0][0], op.from[1] - points[0][1]]);
        if (!offset || !offset.every(Number.isFinite)) throw new Error(`${verb} needs a source: from [x, y] or offset [dx, dy]`);
        p = await clonePatch(dir, doc, { points, size, hardness, offset, sample, healing: verb === 'heal', verb });
        stroke.offset = offset;
      } else if (verb === 'smudge') {
        const rate = op.rate ?? 50, flow = op.flow ?? 0, color = op.color ?? '#000000';
        if (!(rate >= 0 && rate <= 100 && flow >= 0 && flow <= 100)) throw new Error('smudge rate and flow must be 0–100');
        p = await smudgePatch(dir, doc, { points, size, hardness, rate: rate / 100, flow: flow / 100, color, sample });
        Object.assign(stroke, { rate, flow }, flow ? { color } : {});
      } else if (verb === 'blur' || verb === 'sharpen') {
        // strength: blur radius in px (blur), or how strongly edges are boosted (sharpen, 0–100, radius 1.5px)
        const strength = op.strength ?? (verb === 'blur' ? 4 : 50);
        if (!(strength > 0 && (verb === 'blur' ? strength <= 100 : strength <= 100))) throw new Error(`${verb} strength must be 0–100`);
        const focus = verb === 'blur' ? { kind: 'blur', radius: strength } : { kind: 'sharpen', radius: 1.5, amount: strength / 25 };
        p = await clonePatch(dir, doc, { points, size, hardness, offset: [0, 0], sample, focus, verb });
        stroke.strength = strength;
      } else {
        const range = op.range ?? 'midtones', exposure = op.exposure ?? 50;
        if (!(exposure >= 0 && exposure <= 100)) throw new Error(`${verb} exposure must be 0–100`);
        const lut = dodgeBurnLUT(verb, range, exposure);
        p = await clonePatch(dir, doc, { points, size, hardness, offset: [0, 0], sample, lut, verb });
        Object.assign(stroke, { range, exposure });
      }
      const { asset } = await importAsset(dir, p.png, `${verb}.png`);
      return { type: 'paint.stroke', id: l.id, stroke: { ...stroke, asset, x: p.x - l.x, y: p.y - l.y, w: p.w, h: p.h } };
    }
    case 'layer.colorToAlpha': {
      // GIMP's Color to Alpha; `at: [x, y]` samples the color from the layer (as it looks before this step).
      const l = findLayer(doc, op.id), props = {};
      let via;
      if (op.at) {
        const p = await pickColor(dir, doc, op.at[0], op.at[1], { layer: l.id, skip: ['colorToAlpha'] });
        if (!p.after.alpha) throw new Error(`Layer "${l.name}" has no pixel at (${p.x}, ${p.y}) to sample`);
        props.color = p.after.hex;
        via = `Color to alpha (color ${p.after.hex} picked at (${p.x}, ${p.y}))`;
      } else if (op.color) props.color = op.color;
      if (op.transparency !== undefined) props.transparency = op.transparency;
      if (op.opacity !== undefined) props.opacity = op.opacity;
      return { type: 'layer.update', id: l.id, props: { colorToAlpha: props }, via };
    }
    case 'edit.fill': case 'edit.bucket': {
      const color = op.color || '#000000';
      let sel = doc.selection, via;
      if (op.type === 'edit.bucket') {
        // Bucket fill = fuzzy select at the point, limited to the current selection, filled with color.
        const id = op.sample ? ref(op.sample) : null, threshold = op.threshold ?? 32, contiguous = op.contiguous !== false;
        const area = await wandCanvas(dir, doc, { x: op.x, y: op.y, threshold, contiguous, layer: id });
        if (sel) {
          const ax = area.getContext('2d');
          ax.globalCompositeOperation = 'destination-in';
          ax.drawImage(await selectionCanvas(dir, doc, sel), 0, 0);
        }
        via = `Bucket-filled at (${Math.floor(op.x)}, ${Math.floor(op.y)}) (threshold ${threshold}${contiguous ? '' : ', all matching pixels'}${sel ? ', inside the selection' : ''}) with ${color}`;
        sel = { items: [{ mode: 'add', shape: await maskShape(dir, area, 'bucket fill area'), dx: 0, dy: 0 }] };
      }
      const layer = { type: 'fill', id: `L${doc.nextId}`, name: op.name ?? `Fill ${color}`, color, w: doc.width, h: doc.height };
      if (sel) layer.mask = [{ mode: 'keep', sel, w: doc.width, h: doc.height, x0: 0, y0: 0 }];
      return { type: 'edit.fill', layer, via, selText: sel ? selectionText(sel) : 'the whole canvas' };
    }
    case 'layer.group': {
      const ids = (op.ids || []).map(ref);
      if (!ids.length) throw new Error('Give the layers to group: ids [...]');
      const parents = new Set(ids.map(id => findLayer(doc, id).parent ?? null));
      if (parents.size > 1) throw new Error('Layers to group must be in the same group (or none)');
      Object.assign(op, { ids, newId: `L${doc.nextId}`, name: op.name ?? `Group ${doc.layers.filter(l => l.type === 'group').length + 1}` });
      break;
    }
    case 'layer.ungroup': case 'layer.move': case 'layer.maskStroke':
      op.id = ref(op.id);
      break;
    case 'selection.transform': {
      // Friendly form: scale / scaleX / scaleY / rotate (degrees) about a point (default: the selection's centre).
      if (op.matrix) break;
      const sel = requireSelection(doc), { bbox } = maskStats(await selectionCanvas(dir, doc, sel));
      if (!bbox) throw new Error('The selection is empty');
      const [cx, cy] = op.about ?? [bbox[0] + bbox[2] / 2, bbox[1] + bbox[3] / 2];
      const sx = op.scaleX ?? op.scale ?? 1, sy = op.scaleY ?? op.scale ?? 1, r = ((op.rotate ?? 0) * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
      // T = translate(c) · rotate · scale · translate(−c)
      const a = cos * sx, b = sin * sx, c = -sin * sy, d = cos * sy;
      const parts = [sx !== 1 || sy !== 1 ? `scaled ${sx === sy ? `${Math.round(sx * 100)}%` : `${Math.round(sx * 100)}% × ${Math.round(sy * 100)}%`}` : '', op.rotate ? `rotated ${op.rotate}°` : ''].filter(Boolean);
      return { type: 'selection.transform', matrix: [a, b, c, d, cx - a * cx - c * cy, cy - b * cx - d * cy], via: `${parts.join(', ') || 'unchanged'} about (${Math.round(cx)}, ${Math.round(cy)})` };
    }
    case 'channel.save': {
      const sel = requireSelection(doc);
      return { type: 'channel.save', name: op.name, shape: await maskShape(dir, await selectionCanvas(dir, doc, sel), `channel "${op.name}"`) };
    }
    case 'channel.load': {
      // → a normal selection.set with the stored mask (replace / add / subtract / intersect)
      const ch = (doc.channels || []).find(c => c.name === op.name);
      if (!ch) throw new Error(`No channel "${op.name}". Channels: ${(doc.channels || []).map(c => `"${c.name}"`).join(', ') || '(none)'}`);
      const item = ch.item;
      return { type: 'selection.set', mode: op.mode ?? 'replace', shape: item.m || item.dx || item.dy
        ? await maskShape(dir, await selectionCanvas(dir, doc, { items: [item] }), `channel "${op.name}"`)
        : { ...item.shape, via: `channel "${op.name}"` } };
    }
    case 'channel.remove': break;
    case 'selection.translate': case 'selection.paint': case 'guide.add': case 'guide.remove': case 'guide.clear':
      break;
    case 'text.onPath': {
      // Put a text layer on a Pen-tool path: the layer moves to the path's box (rotation/scale reset) and keeps
      // its own copy of the path, so it can be moved, rotated and scaled with the text.
      const l = findLayer(doc, op.id), p = findPath(doc, op.path);
      if (l.type !== 'text') throw new Error(`Layer "${l.name}" is not a text layer`);
      const pts = flatten(p.subpaths[0]).pts, pad = Math.ceil(l.size * 1.2);
      const x0 = Math.min(...pts.map(q => q[0])) - pad, y0 = Math.min(...pts.map(q => q[1])) - pad;
      const box = [Math.ceil(Math.max(...pts.map(q => q[0])) + pad - x0), Math.ceil(Math.max(...pts.map(q => q[1])) + pad - y0)];
      const place = Object.fromEntries(Object.entries({ x: Math.round(x0), y: Math.round(y0), rotation: 0, scaleX: 1, scaleY: 1 }).filter(([k, v]) => l[k] !== v));
      return { type: 'layer.update', id: l.id, via: `Put the text on path "${p.name}"`,
        props: { ...place, path: { subpaths: mapPath(p.subpaths.slice(0, 1), ([x, y]) => [x - Math.round(x0), y - Math.round(y0)]), offset: op.offset ?? 0, box } } };
    }
    case 'layer.liquify': {
      // canvas points → the layer's own coordinates (unless sent as space: "layer", as the editor does)
      const l = findLayer(doc, op.id);
      op.id = l.id;
      if (op.space !== 'layer') {
        const size = layerSize(l, createCanvas(1, 1).getContext('2d')), inv = invert(layerMatrix(l, size)), k = Math.sqrt(Math.abs(inv[0] * inv[3] - inv[1] * inv[2]));
        op.stroke = { ...op.stroke, mode: op.stroke?.mode ?? 'push', strength: op.stroke?.strength ?? 0.5,
          points: (op.stroke?.points || []).map(([x, y]) => apply(inv, x, y).map(v => Math.round(v * 10) / 10)), size: Math.round((op.stroke?.size ?? 60) * k * 10) / 10 };
      }
      delete op.space;
      break;
    }
    case 'selection.scissors': case 'selection.foreground': {
      // Smart selections computed on the image (merged, or one layer as it looks): see smartselect.js.
      const id = op.layer ? ref(op.layer) : null;
      const c = await renderCanvas(dir, doc, id ? { only: [id], background: false } : {}), w = doc.width, h = doc.height;
      const rgba = c.getContext('2d').getImageData(0, 0, w, h).data, on = id ? ` on layer "${findLayer(doc, id).name}"` : '';
      if (op.type === 'selection.scissors') {
        const anchors = op.anchors || [];
        if (anchors.length < 3) throw new Error('Intelligent scissors need at least 3 anchor points around the object');
        const points = scissorsOutline(edgeCost(rgba, w, h), w, h, anchors);
        return { type: 'selection.set', mode: op.mode ?? 'replace', shape: { type: 'polygon', points, via: `intelligent scissors through ${anchors.length} anchors${on}` } };
      }
      // foreground: the rough area is the outline polygon, or the current selection
      const area = createCanvas(w, h), ac = area.getContext('2d');
      if (op.outline?.length >= 3) { ac.fillStyle = '#fff'; ac.beginPath(); op.outline.forEach(([x, y], i) => (i ? ac.lineTo(x, y) : ac.moveTo(x, y))); ac.closePath(); ac.fill(); }
      else if (doc.selection) ac.drawImage(await selectionCanvas(dir, doc, doc.selection), 0, 0);
      else throw new Error('Foreground select needs a rough outline (or a selection) around the object');
      const region = alphaOf(area);
      let fg = null;
      if (op.strokes?.length) {
        const fc = createCanvas(w, h), fx = fc.getContext('2d');
        for (const st of op.strokes) strokePath(fx, { color: '#fff', size: st.size ?? 10, points: st.points });
        fg = alphaOf(fc);
      }
      const mask = foregroundMask(rgba, w, h, region, fg);
      if (!mask.some(Boolean)) throw new Error('Foreground select found nothing — paint over the object to help it');
      const shape = await maskShape(dir, binaryCanvas(mask, w, h), `foreground select${op.strokes?.length ? ` (${op.strokes.length} object strokes)` : ''}${on}`);
      return { type: 'selection.set', mode: op.mode ?? 'replace', shape };
    }
    case 'edit.strokeSelection': {
      // GIMP Edit → Stroke Selection: a band along the selection edge (centered, inside or outside), as a fill layer.
      const width = op.width ?? 4, pos = op.position ?? 'center', color = op.color || '#000000';
      if (!(width > 0)) throw new Error('width must be positive');
      if (!['center', 'inside', 'outside'].includes(pos)) throw new Error('position must be center, inside or outside');
      const cur = await selectionCanvas(dir, doc, requireSelection(doc)), { width: w, height: h } = cur, bin = alphaOf(cur);
      const grow = r => dilate(bin, w, h, r), shrink = r => invertBin(dilate(invertBin(bin), w, h, r));
      const [outer, inner] = pos === 'center' ? [grow(Math.max(1, Math.round(width / 2))), shrink(Math.max(1, Math.round(width / 2)))]
        : pos === 'inside' ? [bin, shrink(Math.round(width))] : [grow(Math.round(width)), bin];
      const band = binaryCanvas(outer.map((v, i) => v & (1 - inner[i])), w, h);
      const shape = await maskShape(dir, band, `${width}px stroke along the selection`);
      const sel = { items: [{ mode: 'add', shape, dx: 0, dy: 0 }] };
      const layer = { type: 'fill', id: `L${doc.nextId}`, name: op.name ?? 'Selection stroke', color, w: doc.width, h: doc.height,
        mask: [{ mode: 'keep', sel, w: doc.width, h: doc.height, x0: 0, y0: 0 }] };
      return { type: 'edit.fill', layer, via: `Stroked the selection outline with ${color}, ${width}px ${pos === 'center' ? 'centered on the edge' : pos}`, selText: '' };
    }
    case 'layer.perspective': case 'layer.warp': {
      // Friendly forms in canvas pixels → layer.update { mesh } in the layer's own coordinates.
      const l = findLayer(doc, op.id), size = layerSize(l, createCanvas(1, 1).getContext('2d')), inv = invert(layerMatrix(l, size));
      if (l.locks?.position) throw new Error(`Layer "${l.name}" is locked (position) — unlock it first`);
      if (op.type === 'layer.perspective') {
        if (!Array.isArray(op.corners) || op.corners.length !== 4) throw new Error('perspective needs corners: [[x, y] × 4] (top-left, top-right, bottom-right, bottom-left)');
        return { type: 'layer.update', id: l.id, props: { mesh: { kind: 'perspective', cols: 1, rows: 1, points: op.corners.map(([x, y]) => apply(inv, x, y).map(v => Math.round(v * 10) / 10)) } }, via: 'Perspective' };
      }
      const cols = op.cols ?? l.mesh?.cols ?? 3, rows = op.rows ?? l.mesh?.rows ?? 3;
      const mesh = l.mesh?.kind === 'warp' && l.mesh.cols === cols && l.mesh.rows === rows ? structuredClone(l.mesh) : defaultMesh('warp', size, cols, rows);
      const lin = [inv[0], inv[1], inv[2], inv[3]]; // canvas offsets → layer offsets (no translation)
      for (const { i, j, dx = 0, dy = 0 } of op.moves || []) {
        const pt = mesh.points[j * (cols + 1) + i];
        if (!pt) throw new Error(`No grid point (${i}, ${j}) in a ${cols}×${rows} warp (i 0–${cols}, j 0–${rows})`);
        pt[0] = Math.round((pt[0] + lin[0] * dx + lin[2] * dy) * 10) / 10; pt[1] = Math.round((pt[1] + lin[1] * dx + lin[3] * dy) * 10) / 10;
      }
      return { type: 'layer.update', id: l.id, props: { mesh }, via: 'Warp' };
    }
    case 'layer.paste': {
      // Copy layers (a group brings its contents) from another project — or this one — keeping them editable:
      // masks, adjustments, strokes and the image files they use come along. One history entry.
      const from = !op.from ? dir : path.isAbsolute(op.from) ? op.from : path.resolve(dir, '..', op.from);
      if (!isProject(from)) throw new Error(`No project "${op.from}"`);
      const src = loadState(from).doc, ids = new Set();
      for (const r of op.ids || []) {
        const l = findLayer(src, r);
        ids.add(l.id);
        const walk = pid => { for (const c of src.layers) if (c.parent === pid) { ids.add(c.id); walk(c.id); } };
        if (l.type === 'group') walk(l.id);
      }
      if (!ids.size) throw new Error('Give the layers to paste: ids [...]');
      const picked = src.layers.filter(l => ids.has(l.id)), map = new Map();
      let next = doc.nextId;
      for (const l of picked) map.set(l.id, `L${next++}`);
      // centered (default) keeps the layers' place relative to the canvas centre; inPlace keeps their coordinates
      const dx = op.inPlace ? 0 : Math.round((doc.width - src.width) / 2), dy = op.inPlace ? 0 : Math.round((doc.height - src.height) / 2);
      const layers = picked.map(l => {
        const c = { ...structuredClone(l), id: map.get(l.id), x: l.x + dx, y: l.y + dy };
        if (c.parent && map.has(c.parent)) c.parent = map.get(c.parent); else delete c.parent;
        for (const m of c.mask || []) { m.x0 += dx; m.y0 += dy; }
        return c;
      });
      if (from !== dir) for (const a of assetsOf(layers)) { // bring the image files along (content-addressed)
        const to = path.join(dir, 'assets', a);
        if (!fs.existsSync(to)) fs.copyFileSync(path.join(from, 'assets', a), to);
      }
      const name = from === dir ? 'this project' : `project "${path.basename(from)}"`;
      return { type: 'doc.import', verb: 'Pasted', source: `${op.ids.length === 1 ? `"${picked.find(l => l.id === findLayer(src, op.ids[0]).id).name}"` : `${op.ids.length} layers`} from ${name}`, layers };
    }
    case 'doc.import': {
      // A layered file (PSD or GIMP XCF) → all its layers in one op. An empty project takes the file's canvas size.
      const file = path.resolve(dir, op.src || '');
      if (!op.src || !fs.existsSync(file)) throw new Error(`No file "${op.src}"`);
      if (!/\.(psd|xcf)$/i.test(file)) throw new Error('doc.import reads .psd and .xcf files (use layer.add for images)');
      const r = await (/\.xcf$/i.test(file) ? fromXcf : fromPsd)(fs.readFileSync(file), { nextId: doc.nextId, store: buf => importAsset(dir, buf, 'layer.png'), maskShape: (c, via) => maskShape(dir, c, via) });
      const resize = op.resize ?? !doc.layers.length;
      return { type: 'doc.import', source: op.name ?? path.basename(file), ...(resize ? { width: r.width, height: r.height } : {}), layers: r.layers, notes: r.notes };
    }
    case 'canvas.scale': {
      // width and/or height, or percent; a missing side keeps the aspect ratio
      const k = op.percent != null ? Number(op.percent) / 100 : null;
      let w = op.width ?? (k ? doc.width * k : null), h = op.height ?? (k ? doc.height * k : null);
      if (w == null && h == null) throw new Error('Give width, height, or percent');
      if (w == null) w = (doc.width * h) / doc.height;
      if (h == null) h = (doc.height * w) / doc.width;
      Object.assign(op, { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) });
      delete op.percent;
      break;
    }
    case 'layer.reorder': {
      op.id = ref(op.id);
      const i = doc.layers.findIndex(l => l.id === op.id), last = doc.layers.length - 1, me = doc.layers[i];
      // up/down/top/bottom move among the layer's siblings (same group), stepping over whole groups
      const sib = doc.layers.map((l, j) => [l, j]).filter(([l]) => (l.parent ?? null) === (me.parent ?? null)).map(([, j]) => j), k = sib.indexOf(i);
      const named = { top: sib.at(-1), bottom: sib[0], up: sib[Math.min(sib.length - 1, k + 1)], down: sib[Math.max(0, k - 1)] }[op.index];
      op.index = named ?? Number(op.index);
      if (op.index > last) op.index = last;
      if (!Number.isInteger(op.index)) throw new Error('index must be a number or top/bottom/up/down');
      break;
    }
    case 'layer.duplicate':
      op.id = ref(op.id);
      op.newId = `L${doc.nextId}`;
      break;
    case 'layer.merge': {
      if (op.down != null) {
        const i = doc.layers.findIndex(l => l.id === ref(op.down));
        if (i === 0) throw new Error('Nothing below that layer to merge into');
        op.ids = [doc.layers[i - 1].id, doc.layers[i].id];
        delete op.down;
      }
      op.ids = op.flatten ? doc.layers.map(l => l.id) : (op.ids || []).map(ref);
      if (op.flatten ? op.ids.length === 0 : op.ids.length < 2) throw new Error(op.flatten ? 'No layers to flatten' : 'Merging needs at least two layers');
      const canvas = await renderCanvas(dir, doc, { only: op.ids, background: !!op.flatten });
      const { asset } = await importAsset(dir, await encode(canvas, 'png'), 'merged.png');
      const top = doc.layers.filter(l => op.ids.includes(l.id)).at(-1);
      Object.assign(op, { asset, w: doc.width, h: doc.height, newId: `L${doc.nextId}`, name: op.name ?? (op.flatten ? 'Flattened' : `${top.name} (merged)`) });
      break;
    }
    case 'history.undo': case 'history.redo': {
      // The project's initial canvas.new is never undoable.
      const t = op.type === 'history.undo' ? (state.active.length > 1 ? state.active.at(-1) : null) : state.redo.at(-1);
      if (!t) throw new Error(op.type === 'history.undo' ? 'Nothing to undo' : 'Nothing to redo');
      Object.assign(op, { target: t.seq, targetText: t.text });
      break;
    }
  }
  return op;
}

export async function commit(dir, input, author = 'cli') {
  const state = loadState(dir);
  const op = await materialize(dir, input, state);
  if (!op.type.startsWith('history.')) applyOp(state.doc, op); // validate before writing
  const entry = { seq: (state.entries.at(-1)?.seq ?? 0) + 1, ts: new Date().toISOString(), author, op, text: describe(op, state.doc) };
  fs.appendFileSync(historyFile(dir), JSON.stringify(entry) + '\n');
  writeCache(dir);
  return entry;
}

function writeCache(dir) {
  const { doc } = loadState(dir);
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(doc, null, 2));
}

export async function initProject(dir, { width, height, background }) {
  if (isProject(dir)) throw new Error(`${dir} is already an ImageArtifex project`);
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(historyFile(dir), '');
  return commit(dir, { type: 'canvas.new', width, height, background }, 'cli');
}
