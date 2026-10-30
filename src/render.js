// Canvas 2D renderer. Runs unchanged in the browser and in Node (@napi-rs/canvas),
// so the editor preview and CLI exports produce the same pixels.
import { ADJUST_DEFAULTS } from './model.js';
import { hasTone, toneProgram, applyTone, TONE_KEYS } from './tone.js';
import { tracePath, flatten, pointAt } from './paths.js';

export const LINE_HEIGHT = 1.2;

export function filterString(adjust = {}) {
  const a = { ...ADJUST_DEFAULTS, ...adjust }, f = [];
  if (a.brightness !== 100) f.push(`brightness(${a.brightness}%)`);
  if (a.contrast !== 100) f.push(`contrast(${a.contrast}%)`);
  if (a.saturate !== 100) f.push(`saturate(${a.saturate}%)`);
  if (a.hue !== 0) f.push(`hue-rotate(${a.hue}deg)`);
  if (a.blur !== 0) f.push(`blur(${a.blur}px)`);
  if (a.grayscale !== 0) f.push(`grayscale(${a.grayscale}%)`);
  if (a.sepia !== 0) f.push(`sepia(${a.sepia}%)`);
  if (a.invert !== 0) f.push(`invert(${a.invert}%)`);
  return f.join(' ') || 'none';
}

const GENERIC_FONTS = ['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui'];
const family = f => (GENERIC_FONTS.includes(f) || /^["']/.test(f) || !/\s/.test(f) ? f : `"${f}"`);
export const fontOf = l => `${l.italic ? 'italic ' : ''}${l.weight} ${l.size}px ${family(l.font)}`;

// Lines of a text layer: its own line breaks, plus word wrap when it has a paragraph width (boxWidth).
export function textLines(layer, ctx) {
  const paras = String(layer.text).split('\n');
  if (!layer.boxWidth) return paras;
  ctx.save();
  ctx.font = fontOf(layer);
  const out = [], fits = t => ctx.measureText(t).width <= layer.boxWidth;
  for (const para of paras) {
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      const next = line + word;
      if (fits(next) || !line.trim()) {
        if (fits(next)) { line = next; continue; }
        // a single word wider than the box: break it by characters
        for (const ch of word) { if (fits(line + ch) || !line) line += ch; else { out.push(line); line = ch; } }
        continue;
      }
      out.push(line.trimEnd());
      line = word.trimStart();
    }
    out.push(line);
  }
  ctx.restore();
  return out;
}
const lineHeightOf = l => l.size * (l.lineHeight ?? LINE_HEIGHT);

// Unscaled content size of a layer.
export function layerSize(layer, ctx) {
  if (layer.type !== 'text') return { w: layer.w, h: layer.h };
  if (layer.path) return { w: layer.path.box[0], h: layer.path.box[1] }; // text on a path: the path's box
  const lines = textLines(layer, ctx);
  ctx.save();
  ctx.font = fontOf(layer);
  const w = layer.boxWidth || Math.max(1, ...lines.map(s => ctx.measureText(s).width));
  ctx.restore();
  return { w: Math.ceil(w), h: Math.ceil(lines.length * lineHeightOf(layer)) };
}

// Affine matrix [a,b,c,d,e,f] mapping layer-local coords to document coords.
// (x, y) is the top-left of the scaled box; rotation is about the box centre.
export function layerMatrix(layer, { w, h }) {
  const { x, y, scaleX: sx, scaleY: sy } = layer;
  const W = w * Math.abs(sx), H = h * Math.abs(sy);
  const rad = (layer.rotation * Math.PI) / 180, cos = Math.cos(rad), sin = Math.sin(rad);
  const a = cos * sx, b = sin * sx, c = -sin * sy, d = cos * sy;
  return [a, b, c, d, x + W / 2 - a * w / 2 - c * h / 2, y + H / 2 - b * w / 2 - d * h / 2];
}

export function invert([a, b, c, d, e, f]) {
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

export function apply([a, b, c, d, e, f], x, y) {
  return [a * x + c * y + e, b * x + d * y + f];
}

// Reusable offscreen canvas per purpose.
function scratch(env, key, w, h) {
  env.scratch ||= new Map();
  let c = env.scratch.get(key);
  if (!c || c.width !== w || c.height !== h) env.scratch.set(key, (c = env.makeCanvas(w, h)));
  const x = c.getContext('2d');
  x.setTransform(1, 0, 0, 1, 0, 0);
  Object.assign(x, { globalAlpha: 1, globalCompositeOperation: 'source-over', filter: 'none' });
  x.clearRect(0, 0, w, h);
  return c;
}

const SELECTION_COMPOSITE = { add: 'source-over', subtract: 'destination-out', intersect: 'destination-in', xor: 'xor' };

function shapePath(m, s) {
  m.beginPath();
  if (s.type === 'rect') m.rect(s.x, s.y, s.w, s.h);
  else if (s.type === 'ellipse') m.ellipse(s.x + s.w / 2, s.y + s.h / 2, Math.abs(s.w) / 2, Math.abs(s.h) / 2, 0, 0, Math.PI * 2);
  else if (s.type === 'polygon') { s.points.forEach(([x, y], i) => (i ? m.lineTo(x, y) : m.moveTo(x, y))); m.closePath(); }
  else if (s.type === 'path') tracePath(m, s.subpaths.map(sp => ({ ...sp, closed: true }))); // a selection is always closed
}

// A brush stroke with soft edges (hardness 1 = hard), for masks and quick-mask selections.
function softStroke(ctx, s, color) {
  // solid core, edge fading over ~size × (1 − hardness) / 2
  const blur = (s.size * (1 - (s.hardness ?? 0.75))) / 6;
  ctx.save();
  if (blur >= 0.3) ctx.filter = `blur(${blur}px)`;
  strokePath(ctx, { color, size: blur >= 0.3 ? Math.max(1, s.size - blur) : s.size, points: s.points, subpaths: s.subpaths });
  ctx.restore();
}

// Rasterize a selection to a w×h canvas whose alpha is the selection strength (cached).
export function selectionMask(sel, w, h, env) {
  env.maskCache ||= new Map();
  const key = `${w}x${h}:${JSON.stringify(sel)}`;
  const hit = env.maskCache.get(key);
  if (hit) return hit;
  const c = env.makeCanvas(w, h), m = c.getContext('2d');
  m.fillStyle = '#fff';
  for (const it of sel.items) {
    m.globalCompositeOperation = SELECTION_COMPOSITE[it.mode];
    const s = it.shape;
    m.save();
    if (s.type === 'all') m.fillRect(0, 0, w, h);
    else {
      m.translate(it.dx || 0, it.dy || 0);
      if (it.m) m.transform(...it.m); // rotated / scaled selection outline
      if (s.type === 'mask') {
        const img = env.images.get(s.asset);
        if (img) m.drawImage(img, 0, 0);
        else if (it.mode === 'intersect') m.clearRect(-(it.dx || 0), -(it.dy || 0), w, h);
      } else if (s.type === 'stroke') softStroke(m, s, '#fff');
      else { shapePath(m, s); m.fill(s.type === 'path' ? 'evenodd' : 'nonzero'); }
    }
    m.restore();
  }
  if (env.maskCache.size > 40) env.maskCache.clear();
  env.maskCache.set(key, c);
  return c;
}

export function strokePath(ctx, s) {
  ctx.strokeStyle = ctx.fillStyle = s.color || '#000';
  ctx.lineWidth = s.size;
  ctx.lineCap = ctx.lineJoin = 'round';
  ctx.beginPath();
  if (s.subpaths) { tracePath(ctx, s.subpaths); ctx.stroke(); return; } // a stroked bezier path (Pen tool)
  if (s.points.length > 1 && s.points[0].length > 2) { // pen pressure [x, y, p]: width follows pressure
    for (let i = 1; i < s.points.length; i++) {
      const [x0, y0, p0] = s.points[i - 1], [x1, y1, p1] = s.points[i];
      ctx.beginPath();
      ctx.lineWidth = s.size * Math.max(0.05, ((p0 ?? 1) + (p1 ?? 1)) / 2);
      ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    }
    return;
  }
  if (s.points.length === 1) {
    ctx.arc(s.points[0][0], s.points[0][1], s.size / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  s.points.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
  ctx.stroke();
}

// stroke.clip = { sel, w, h, dx, dy } limits a stroke to the selection active when it was painted.
function drawStrokes(ctx, layer, env) {
  for (const s of layer.strokes) {
    if (s.patch) {
      // clone / heal strokes are baked into an image patch (selection already applied)
      const img = env.images.get(s.asset);
      ctx.globalCompositeOperation = s.atop ? 'source-atop' : 'source-over';
      if (img) ctx.drawImage(img, s.x, s.y);
      continue;
    }
    // atop: alpha-locked layer; blend: the stroke's own blend mode against the layer's pixels
    const op = s.erase ? 'destination-out' : s.atop ? 'source-atop' : s.blend && s.blend !== 'normal' ? s.blend : 'source-over';
    const opacity = s.opacity ?? 1, soft = (s.hardness ?? 1) < 1;
    if (!s.clip && opacity === 1 && !soft) { ctx.globalCompositeOperation = op; strokePath(ctx, s); continue; }
    // Drawn whole on its own first, so opacity applies to the stroke as a whole (no build-up where it overlaps itself).
    const tmp = scratch(env, 'stroke', layer.w, layer.h), t = tmp.getContext('2d');
    if (soft) softStroke(t, s, s.color || '#000'); else strokePath(t, s);
    if (s.clip) {
      t.globalCompositeOperation = 'destination-in';
      t.drawImage(selectionMask(s.clip.sel, s.clip.w, s.clip.h, env), s.clip.dx, s.clip.dy);
    }
    ctx.save();
    ctx.globalCompositeOperation = op;
    ctx.globalAlpha *= opacity;
    ctx.drawImage(tmp, 0, 0);
    ctx.restore();
  }
}

// Paint layers are rasterized into their own canvas so the eraser only affects that layer.
// Paint layers keep two cached canvases: `base` (every stroke but the last) and `canvas` (all strokes).
// While a stroke grows, or right after one is added, only that stroke is drawn again.
const paintKey = (layer, strokes) => `${layer.w}x${layer.h}:${strokesKey(strokes)}`;
const paintEntry = (layer, env) => env.paintCache.get(layer.id) ?? env.paintCache.set(layer.id, {}).get(layer.id);
const fits = (c, layer) => c && c.width === layer.w && c.height === layer.h;

function paintBase(layer, env) {
  const e = paintEntry(layer, env), n = layer.strokes.length, baseKey = paintKey(layer, layer.strokes.slice(0, n - 1));
  if (e.baseKey === baseKey) return e.base;
  const target = fits(e.base, layer) ? e.base : env.makeCanvas(layer.w, layer.h);
  if (n > 0 && e.key === baseKey) copyCanvas(e.canvas, target); // the previous full canvas is exactly this base
  else {
    const b = target.getContext('2d');
    b.globalCompositeOperation = 'source-over';
    b.clearRect(0, 0, layer.w, layer.h);
    drawStrokes(b, { ...layer, strokes: layer.strokes.slice(0, Math.max(0, n - 1)) }, env);
  }
  Object.assign(e, { base: target, baseKey });
  return target;
}

export function paintCanvas(layer, env) {
  const e = paintEntry(layer, env), key = paintKey(layer, layer.strokes);
  if (e.key === key) return e.canvas;
  const base = paintBase(layer, env), n = layer.strokes.length;
  const canvas = fits(e.canvas, layer) && e.canvas !== base ? e.canvas : env.makeCanvas(layer.w, layer.h);
  copyCanvas(base, canvas);
  if (n) drawStrokes(canvas.getContext('2d'), { ...layer, strokes: layer.strokes.slice(n - 1) }, env);
  Object.assign(e, { canvas, key });
  return canvas;
}

// Draw a paint layer. While its last stroke is changing (a live brush stroke) and the layer composites
// plainly, draw the cached base and then that stroke straight onto ctx — same pixels, one less full copy.
function drawPaint(ctx, layer, env) {
  const last = layer.strokes.at(-1), e = env.paintCache.get(layer.id);
  const plain = ctx.globalAlpha === 1 && ctx.globalCompositeOperation === 'source-over' && ctx.filter === 'none';
  if (last && !last.erase && !last.atop && (last.blend ?? 'normal') === 'normal' && plain && e?.key !== paintKey(layer, layer.strokes)) { // erase/atop need the layer's own pixels
    ctx.drawImage(paintBase(layer, env), 0, 0);
    drawStrokes(ctx, { ...layer, strokes: [last] }, env);
  } else ctx.drawImage(paintCanvas(layer, env), 0, 0);
}

function copyCanvas(from, to) {
  const t = to.getContext('2d');
  t.globalCompositeOperation = 'copy';
  t.drawImage(from, 0, 0);
  t.globalCompositeOperation = 'source-over';
  return to;
}

// "transparent" stops fade the neighbouring stop's color to alpha 0 (avoids fading through black).
function stopColor(stops, i) {
  const c = stops[i][1];
  if (c !== 'transparent') return c;
  const near = stops[i - 1]?.[1] !== 'transparent' && stops[i - 1] ? stops[i - 1][1] : stops[i + 1]?.[1];
  const hex = /^#[0-9a-f]{6}$/i.test(near || '') ? near : '#000000';
  return `rgba(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)}, 0)`;
}

// Integer doc-space rectangle covered by a layer, clipped to the canvas.
function layerBounds(layer, ctx, doc) {
  const size = layerSize(layer, ctx), m = layerMatrix(layer, size);
  const pts = layerOutline(layer, size).map(([x, y]) => apply(m, x, y));
  const x0 = Math.max(0, Math.floor(Math.min(...pts.map(p => p[0])) - 2)), y0 = Math.max(0, Math.floor(Math.min(...pts.map(p => p[1])) - 2));
  const x1 = Math.min(doc.width, Math.ceil(Math.max(...pts.map(p => p[0])) + 2)), y1 = Math.min(doc.height, Math.ceil(Math.max(...pts.map(p => p[1])) + 2));
  return x1 > x0 && y1 > y0 ? [x0, y0, x1 - x0, y1 - y0] : null;
}

function drawContent(ctx, layer, size, env) {
  switch (layer.type) {
    case 'image': {
      const img = env.images.get(layer.asset);
      ctx.imageSmoothingQuality = 'high';
      if (img) ctx.drawImage(img, 0, 0, layer.w, layer.h);
      break;
    }
    case 'text': {
      ctx.font = fontOf(layer);
      ctx.fillStyle = layer.color;
      ctx.textBaseline = 'top';
      ctx.textAlign = layer.align;
      const ox = layer.align === 'center' ? size.w / 2 : layer.align === 'right' ? size.w : 0;
      if (layer.path) { drawTextOnPath(ctx, layer); break; }
      textLines(layer, ctx).forEach((line, i) => ctx.fillText(line, ox, i * lineHeightOf(layer)));
      break;
    }
    case 'shape': {
      ctx.beginPath();
      if (layer.shape === 'ellipse') ctx.ellipse(layer.w / 2, layer.h / 2, layer.w / 2, layer.h / 2, 0, 0, Math.PI * 2);
      else if (layer.radius && ctx.roundRect) ctx.roundRect(0, 0, layer.w, layer.h, layer.radius);
      else ctx.rect(0, 0, layer.w, layer.h);
      if (layer.fill) { ctx.fillStyle = layer.fill; ctx.fill(); }
      if (layer.stroke && layer.strokeWidth > 0) { ctx.strokeStyle = layer.stroke; ctx.lineWidth = layer.strokeWidth; ctx.stroke(); }
      break;
    }
    case 'paint':
      drawPaint(ctx, layer, env);
      break;
    case 'fill':
      ctx.fillStyle = layer.color;
      ctx.fillRect(0, 0, layer.w, layer.h);
      break;
    case 'gradient': {
      const { x1, y1, x2, y2 } = layer;
      const g = layer.kind === 'radial'
        ? ctx.createRadialGradient(x1, y1, 0, x1, y1, Math.max(0.5, Math.hypot(x2 - x1, y2 - y1)))
        : ctx.createLinearGradient(x1, y1, x2, y2);
      layer.stops.forEach(([offset, color], i) => g.addColorStop(offset, stopColor(layer.stops, i)));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, layer.w, layer.h);
      break;
    }
  }
}

// Layers that are drawn through a content stage (untransformed canvas first): mesh, liquify, distort.
export const hasContentStage = l => !!(l.mesh || l.liquify?.length || l.distort);

function drawTransformed(ctx, layer, env) {
  const size = layerSize(layer, ctx);
  if (!hasContentStage(layer)) {
    ctx.filter = filterString(layer.adjust);
    ctx.transform(...layerMatrix(layer, size));
    drawContent(ctx, layer, size, env);
    return;
  }
  // Content stage: the layer's own pixels, untransformed; displaced (liquify / distort); then placed (mesh or matrix).
  const C = env.makeCanvas(Math.max(1, Math.ceil(size.w)), Math.max(1, Math.ceil(size.h))), cc = C.getContext('2d');
  cc.filter = filterString(layer.adjust);
  drawContent(cc, layer, size, env);
  cc.filter = 'none';
  if (layer.liquify?.length || layer.distort) displaceContent(cc, layer);
  ctx.transform(...layerMatrix(layer, size));
  if (layer.mesh) drawMesh(ctx, C, layer.mesh, size);
  else ctx.drawImage(C, 0, 0);
}

// Text along a path: each character sits on the path (baseline), turned to its direction. align and
// offset (px) place the run along the path; newlines become spaces.
function drawTextOnPath(ctx, layer) {
  const line = String(layer.text).replace(/\n/g, ' '), f = flatten(layer.path.subpaths[0]);
  const widths = [...line].map(ch => ctx.measureText(ch).width), total = widths.reduce((a, b) => a + b, 0);
  let s = (layer.path.offset ?? 0) + (layer.align === 'center' ? (f.total - total) / 2 : layer.align === 'right' ? f.total - total : 0);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  [...line].forEach((ch, i) => {
    const mid = s + widths[i] / 2;
    s += widths[i];
    if (mid < 0 || mid > f.total) return; // past the ends of the path
    const p = pointAt(f, mid);
    ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.angle); ctx.fillText(ch, 0, 0); ctx.restore();
  });
}

// ---- Perspective / warp: a mesh of points in the layer's own (untransformed) coordinates --------------------
// perspective: 4 corners (TL, TR, BR, BL) → projective map; warp: (cols+1)×(rows+1) grid → bilinear patches.
export function defaultMesh(kind, size, cols = 3, rows = 3) {
  if (kind === 'perspective') return { kind, cols: 1, rows: 1, points: [[0, 0], [size.w, 0], [size.w, size.h], [0, size.h]] };
  const points = [];
  for (let j = 0; j <= rows; j++) for (let i = 0; i <= cols; i++) points.push([(i / cols) * size.w, (j / rows) * size.h]);
  return { kind, cols, rows, points };
}

// Projective map of the unit square onto a quad (Heckbert): (0,0)→p0, (1,0)→p1, (1,1)→p2, (0,1)→p3.
export function squareToQuad([[x0, y0], [x1, y1], [x2, y2], [x3, y3]]) {
  const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2, sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
  let g = 0, h = 0;
  if (sx || sy) { const den = dx1 * dy2 - dx2 * dy1 || 1e-9; g = (sx * dy2 - dx2 * sy) / den; h = (dx1 * sy - sx * dy1) / den; }
  const a = x1 - x0 + g * x1, b = x3 - x0 + h * x3, d = y1 - y0 + g * y1, e = y3 - y0 + h * y3;
  return (u, v) => { const w = g * u + h * v + 1; return [(a * u + b * v + x0) / w, (d * u + e * v + y0) / w]; };
}

// Where content point (u, v) (in [0..w]×[0..h]) lands under the mesh.
export function meshMap(mesh, size) {
  if (mesh.kind === 'perspective') { const H = squareToQuad(mesh.points); return (u, v) => H(u / size.w, v / size.h); }
  const { cols, rows, points } = mesh, P = (i, j) => points[j * (cols + 1) + i];
  return (u, v) => {
    const fx = Math.min(cols - 1e-9, Math.max(0, (u / size.w) * cols)), fy = Math.min(rows - 1e-9, Math.max(0, (v / size.h) * rows));
    const i = Math.floor(fx), j = Math.floor(fy), s = fx - i, t = fy - j;
    const [a, b, c, d] = [P(i, j), P(i + 1, j), P(i + 1, j + 1), P(i, j + 1)];
    return [0, 1].map(k => (1 - s) * (1 - t) * a[k] + s * (1 - t) * b[k] + s * t * c[k] + (1 - s) * t * d[k]);
  };
}

function drawMesh(ctx, img, mesh, size) {
  const map = meshMap(mesh, size), n = mesh.kind === 'perspective' ? 16 : 8 * Math.max(mesh.cols, mesh.rows);
  const src = (i, j) => [(i / n) * size.w, (j / n) * size.h], dst = (i, j) => map(...src(i, j));
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const s = [src(i, j), src(i + 1, j), src(i + 1, j + 1), src(i, j + 1)], d = [dst(i, j), dst(i + 1, j), dst(i + 1, j + 1), dst(i, j + 1)];
    drawTriangle(ctx, img, [s[0], s[1], s[2]], [d[0], d[1], d[2]]);
    drawTriangle(ctx, img, [s[0], s[2], s[3]], [d[0], d[2], d[3]]);
  }
}

// Draw the part of img inside source triangle s onto destination triangle d (affine), slightly enlarged so
// neighbouring triangles overlap instead of leaving hairline seams.
function drawTriangle(ctx, img, [s0, s1, s2], [d0, d1, d2]) {
  const den = (s1[0] - s0[0]) * (s2[1] - s0[1]) - (s2[0] - s0[0]) * (s1[1] - s0[1]);
  if (!den) return;
  const cx = (d0[0] + d1[0] + d2[0]) / 3, cy = (d0[1] + d1[1] + d2[1]) / 3;
  const grow = ([x, y]) => { const dx = x - cx, dy = y - cy, l = Math.hypot(dx, dy) || 1; return [x + (dx / l) * 1.2, y + (dy / l) * 1.2]; };
  ctx.save();
  ctx.beginPath(); ctx.moveTo(...grow(d0)); ctx.lineTo(...grow(d1)); ctx.lineTo(...grow(d2)); ctx.closePath(); ctx.clip();
  const m = k => [((d1[k] - d0[k]) * (s2[1] - s0[1]) - (d2[k] - d0[k]) * (s1[1] - s0[1])) / den, ((d2[k] - d0[k]) * (s1[0] - s0[0]) - (d1[k] - d0[k]) * (s2[0] - s0[0])) / den];
  const [a, c] = m(0), [b, dd] = m(1);
  ctx.transform(a, b, c, dd, d0[0] - a * s0[0] - c * s0[1], d0[1] - b * s0[0] - dd * s0[1]);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

// Outline of a layer in its own coordinates (mesh points when warped).
export const layerOutline = (l, size) => (l.mesh ? l.mesh.points : [[0, 0], [size.w, 0], [size.w, size.h], [0, size.h]]);

// ---- Liquify and distort: inverse displacement in the layer's own coordinates --------------------------------
// Output pixel p shows content at distortSrc(p) + D(distortSrc(p)), where D is the liquify field built from the
// layer's strokes (each dab composed with the field so far) and distortSrc is the distort filter's inverse map.
export const LIQUIFY_MODES = ['push', 'twirl', 'bloat', 'pinch'];
export const DISTORT_KINDS = ['twirl', 'pinch', 'ripple', 'waves', 'lens'];

function liquifyField(w, h, strokes) {
  const D = new Float32Array(w * h * 2);
  const sample = (F, x, y) => { // bilinear sample of the field (clamped)
    x = Math.min(w - 1, Math.max(0, x)); y = Math.min(h - 1, Math.max(0, y));
    const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1), fx = x - x0, fy = y - y0;
    const at = (xx, yy, k) => F[(yy * w + xx) * 2 + k];
    return [0, 1].map(k => (at(x0, y0, k) * (1 - fx) + at(x1, y0, k) * fx) * (1 - fy) + (at(x0, y1, k) * (1 - fx) + at(x1, y1, k) * fx) * fy);
  };
  for (const st of strokes) {
    const r = st.size / 2, k = st.strength ?? 0.5, pts = st.points;
    // dabs every quarter radius along the stroke
    const dabs = [];
    for (let i = 0; i < pts.length; i++) {
      if (!i) { dabs.push([...pts[0], 0, 0]); continue; }
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], len = Math.hypot(x1 - x0, y1 - y0), n = Math.max(1, Math.ceil(len / Math.max(1, r / 4)));
      for (let t = 1; t <= n; t++) dabs.push([x0 + ((x1 - x0) * t) / n, y0 + ((y1 - y0) * t) / n, (x1 - x0) / n, (y1 - y0) / n]);
    }
    for (const [cx, cy, vx, vy] of dabs) {
      const xa = Math.max(0, Math.floor(cx - r)), xb = Math.min(w - 1, Math.ceil(cx + r)), ya = Math.max(0, Math.floor(cy - r)), yb = Math.min(h - 1, Math.ceil(cy + r));
      if (xa > xb || ya > yb) continue;
      const old = D.slice(); // compose: new D(p) = δ(p) + D_old(p + δ(p))
      for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) {
        const dx = x - cx, dy = y - cy, q = (dx * dx + dy * dy) / (r * r);
        if (q >= 1) continue;
        const wgt = (1 - q) * (1 - q) * k;
        let sx = 0, sy = 0;
        if (st.mode === 'push') { sx = -vx * wgt; sy = -vy * wgt; }
        else if (st.mode === 'twirl') { const a = -0.35 * wgt, c = Math.cos(a), s2 = Math.sin(a); sx = cx + c * dx - s2 * dy - x; sy = cy + s2 * dx + c * dy - y; }
        else { const f = st.mode === 'bloat' ? 1 - 0.5 * wgt : 1 + 0.5 * wgt; sx = dx * f - dx; sy = dy * f - dy; }
        const [ox, oy] = sample(old, x + sx, y + sy), i = (y * w + x) * 2;
        D[i] = sx + ox; D[i + 1] = sy + oy;
      }
    }
  }
  return D;
}

// Inverse map of a distort filter (GIMP Filters → Distorts), centre and radius relative to the layer.
function distortSrc(dist, w, h) {
  const cx = (dist.centerX ?? 0.5) * w, cy = (dist.centerY ?? 0.5) * h, R = (dist.radius ?? 1) * Math.min(w, h) / 2, a = dist.amount ?? 0;
  const lambda = dist.wavelength ?? 20, amp = dist.amplitude ?? 5;
  switch (dist.kind) {
    case 'twirl': return (x, y) => {
      const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy);
      if (d >= R) return [x, y];
      const t = ((a * Math.PI) / 180) * (1 - d / R) ** 2, c = Math.cos(-t), s = Math.sin(-t);
      return [cx + c * dx - s * dy, cy + s * dx + c * dy];
    };
    case 'pinch': return (x, y) => { // amount > 0 pinches toward the centre, < 0 bulges out
      const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy);
      if (d >= R || d === 0) return [x, y];
      const f = Math.sin((Math.PI / 2) * (d / R)) ** -a;
      return [cx + dx * f, cy + dy * f];
    };
    case 'ripple': return dist.orientation === 'vertical'
      ? (x, y) => [x, y + amp * Math.sin((2 * Math.PI * x) / lambda)]
      : (x, y) => [x + amp * Math.sin((2 * Math.PI * y) / lambda), y];
    case 'waves': return (x, y) => {
      const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy) || 1, o = amp * Math.sin((2 * Math.PI * d) / lambda);
      return [x + (dx / d) * o, y + (dy / d) * o];
    };
    case 'lens': { // GIMP Lens Distortion (GEGL): main (barrel/pincushion), edge, zoom, shift x/y, brighten (−100…100)
      const norm = 4 / (w * w + h * h), lx = (w * (100 + (dist.xShift ?? 0))) / 200, ly = (h * (100 + (dist.yShift ?? 0))) / 200;
      const sq = (dist.main ?? 0) / 200, qd = (dist.edge ?? 0) / 200, rescale = 2 ** (-(dist.zoom ?? 0) / 100), bright = -(dist.brighten ?? 0) / 10;
      const f = (x, y) => {
        const ox = x - lx, oy = y - ly, r = (ox * ox + oy * oy) * norm, mag = r * sq + r * r * qd, k = rescale * (1 + mag);
        return [lx + k * ox, ly + k * oy, Math.max(1 + mag * bright, 0)]; // 3rd value: brightness factor at this point
      };
      return f;
    }
    default: return (x, y) => [x, y];
  }
}

function displaceContent(cc, layer) {
  const { width: w, height: h } = cc.canvas, src = cc.getImageData(0, 0, w, h), S = src.data, out = cc.createImageData(w, h), O = out.data;
  const D = layer.liquify?.length ? liquifyField(w, h, layer.liquify) : null, dsrc = layer.distort ? distortSrc(layer.distort, w, h) : null;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let [sx, sy, gain = 1] = dsrc ? dsrc(x + 0.5, y + 0.5) : [x + 0.5, y + 0.5];
    if (D) {
      const ix = Math.min(w - 1, Math.max(0, Math.round(sx - 0.5))), iy = Math.min(h - 1, Math.max(0, Math.round(sy - 0.5))), i = (iy * w + ix) * 2;
      sx += D[i]; sy += D[i + 1];
    }
    // bilinear sample of the content at (sx, sy); outside is transparent
    const fx = sx - 0.5, fy = sy - 0.5, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0, o = (y * w + x) * 4;
    for (let c = 0; c < 4; c++) {
      let v = 0;
      for (const [xx, yy, wt] of [[x0, y0, (1 - tx) * (1 - ty)], [x0 + 1, y0, tx * (1 - ty)], [x0, y0 + 1, (1 - tx) * ty], [x0 + 1, y0 + 1, tx * ty]]) {
        if (xx >= 0 && yy >= 0 && xx < w && yy < h && wt) v += S[(yy * w + xx) * 4 + c] * wt;
      }
      O[o + c] = c < 3 ? v * gain : v;
    }
  }
  cc.putImageData(out, 0, 0);
}

const strokesKey = strokes => `${strokes.length}:${strokes.at(-1)?.points?.length ?? 0}`;
// Identity of everything that affects a layer's processed pixels (paint strokes are summarized, since
// they only grow or shrink at the end). Placement-only props are left out by the caller.
const IGNORED = new Set(['name', 'visible', 'opacity', 'blend']);
function layerKey(layer, env, extra) {
  const loaded = [...assetsOf(layer)].every(a => env.images.has(a));
  return `${extra}:${env.epoch || 0}:${loaded}:` + JSON.stringify(layer, (k, v) => (k === 'strokes' ? strokesKey(v) : IGNORED.has(k) ? undefined : v));
}

// Draw the layer alone onto o (already cleared and transformed), apply tone over box and its masks.
function processInto(o, layer, env, box, maskShift, scale = 1) {
  o.save();
  drawTransformed(o, layer, env);
  o.restore();
  o.setTransform(1, 0, 0, 1, 0, 0);
  if (box && hasTone(layer)) {
    env.toneCache ||= new Map();
    const key = JSON.stringify(TONE_KEYS.map(k => layer[k]));
    if (!env.toneCache.has(key)) { if (env.toneCache.size > 20) env.toneCache.clear(); env.toneCache.set(key, toneProgram(layer)); }
    // In the browser, env.gpuTone (web/gpu.js) runs the same pipeline as a WebGL shader when it can.
    const whole = box[0] === 0 && box[1] === 0 && box[2] === o.canvas.width && box[3] === o.canvas.height;
    const gpu = whole && env.gpuTone?.apply(o.canvas, env.toneCache.get(key));
    if (gpu) {
      o.globalCompositeOperation = 'copy';
      o.drawImage(gpu, 0, 0);
      o.globalCompositeOperation = 'source-over';
    } else o.putImageData(applyTone(o.getImageData(...box), env.toneCache.get(key)), box[0], box[1]);
  }
  if (layer.mask?.length) {
    // Build the mask (white = visible): selection masks keep/hide, painted strokes hide/reveal; then apply it.
    const M = scratch(env, 'maskbuf', o.canvas.width, o.canvas.height), mc = M.getContext('2d');
    mc.fillStyle = '#fff'; mc.fillRect(0, 0, M.width, M.height);
    for (const m of layer.mask) {
      if (m.stroke) {
        mc.save();
        mc.globalCompositeOperation = m.mode === 'reveal' ? 'source-over' : 'destination-out';
        mc.setTransform(scale, 0, 0, scale, maskShift[0] - m.x0 * scale, maskShift[1] - m.y0 * scale);
        softStroke(mc, m.stroke, '#fff');
        mc.restore();
        continue;
      }
      mc.globalCompositeOperation = m.mode === 'keep' ? 'destination-in' : 'destination-out';
      mc.drawImage(selectionMask(m.sel, m.w, m.h, env), maskShift[0] - m.x0 * scale, maskShift[1] - m.y0 * scale, m.w * scale * (m.sx ?? 1), m.h * scale * (m.sy ?? 1));
    }
    o.globalCompositeOperation = 'destination-in';
    o.drawImage(M, 0, 0);
  }
  o.globalCompositeOperation = 'source-over';
}

const freshCanvas = (env, hit, w, h) => {
  const c = hit && hit.canvas.width === w && hit.canvas.height === h ? hit.canvas : env.makeCanvas(w, h);
  const o = c.getContext('2d');
  o.setTransform(1, 0, 0, 1, 0, 0);
  Object.assign(o, { globalAlpha: 1, globalCompositeOperation: 'source-over', filter: 'none' });
  o.clearRect(0, 0, w, h);
  return c;
};

// Processed (masked / tone-mapped) pixels of a layer and where to draw them. Processing happens in the
// layer's own space, so moving the layer by whole pixels — or changing its opacity or blend mode —
// reuses the cached result. Huge transformed layers fall back to a canvas-sized buffer.
function processedLayer(layer, env, doc) {
  env.processed ||= new Map();
  const hit = env.processed.get(layer.id), store = (key, canvas, x, y) => {
    if (!hit && env.processed.size >= 16) env.processed.delete(env.processed.keys().next().value);
    env.processed.set(layer.id, { key, canvas, x, y });
    return { canvas, x, y };
  };
  const ix = Math.floor(layer.x), iy = Math.floor(layer.y), local = { ...layer, x: layer.x - ix, y: layer.y - iy };
  const size = layerSize(local, scratch(env, 'measure', 1, 1).getContext('2d')), m = layerMatrix(local, size);
  const pts = layerOutline(local, size).map(([x, y]) => apply(m, x, y));
  const pad = 2 + Math.ceil(3 * (layer.adjust?.blur || 0));
  const bx = Math.floor(Math.min(...pts.map(p => p[0]))) - pad, by = Math.floor(Math.min(...pts.map(p => p[1]))) - pad;
  const w = Math.ceil(Math.max(...pts.map(p => p[0]))) + pad - bx, h = Math.ceil(Math.max(...pts.map(p => p[1]))) + pad - by;

  if (w > 0 && h > 0 && w * h <= Math.max(4 * doc.width * doc.height, 4e6) && w * h <= 32e6) {
    // env.draft (live slider previews in the browser): big layers are processed at half resolution.
    const k = env.draft && w * h > 1.5e6 ? 0.5 : 1, cw = Math.ceil(w * k), ch = Math.ceil(h * k);
    const key = layerKey(local, env, `local ${w}x${h}@${k}`);
    if (hit?.key === key) return { canvas: hit.canvas, x: ix + bx, y: iy + by, w, h };
    const c = freshCanvas(env, hit, cw, ch), o = c.getContext('2d');
    o.scale(k, k);
    o.translate(-bx, -by);
    processInto(o, local, env, [0, 0, cw, ch], [(local.x - bx) * k, (local.y - by) * k], k);
    const r = store(key, c, ix + bx, iy + by);
    return { ...r, w, h };
  }
  const key = layerKey(layer, env, `doc ${doc.width}x${doc.height}`);
  if (hit?.key === key) return { canvas: hit.canvas, x: 0, y: 0 };
  const c = freshCanvas(env, hit, doc.width, doc.height);
  processInto(c.getContext('2d'), layer, env, layerBounds(layer, c.getContext('2d'), doc), [layer.x, layer.y]);
  return store(key, c, 0, 0);
}

export function drawLayer(ctx, layer, env, doc) {
  if (!layer.visible) return;
  const blend = layer.blend === 'normal' ? 'source-over' : layer.blend;
  ctx.save();
  if (layer.mask?.length || hasTone(layer) || hasContentStage(layer)) {
    // Masked / tone-mapped layers are processed alone (cached), then composited with opacity and mode.
    const p = processedLayer(layer, env, doc);
    ctx.globalAlpha *= layer.opacity;
    ctx.globalCompositeOperation = blend;
    if (p.w) ctx.drawImage(p.canvas, p.x, p.y, p.w, p.h);
    else ctx.drawImage(p.canvas, p.x, p.y);
  } else {
    ctx.globalAlpha *= layer.opacity;
    ctx.globalCompositeOperation = blend;
    drawTransformed(ctx, layer, env);
  }
  ctx.restore();
}

// env: { images: Map<asset, image>, paintCache: Map, makeCanvas(w, h) }
// opts.only: array of layer ids to draw; opts.background: draw the canvas background (default true)
export function render(ctx, doc, env, { only = null, background = true } = {}) {
  ctx.save();
  if (background && doc.background) { ctx.fillStyle = doc.background; ctx.fillRect(0, 0, doc.width, doc.height); }
  // `only`: draw just these layers (a group brings its contents); their groups still apply opacity and blend.
  let show = null;
  if (only) {
    show = new Set(only);
    for (const l of doc.layers) for (let p = l.parent; p; p = doc.layers.find(q => q.id === p)?.parent) if (show.has(p)) { show.add(l.id); break; }
  }
  const kids = new Map();
  for (const l of doc.layers) { const k = l.parent ?? null; if (!kids.has(k)) kids.set(k, []); kids.get(k).push(l); }
  drawList(ctx, kids.get(null) || [], { env, doc, kids, show, depth: 0 });
  ctx.restore();
}

// Siblings bottom-to-top. A layer followed by clipped layers forms a clipping stack drawn together.
function drawList(ctx, list, t) {
  for (let i = 0; i < list.length; i++) {
    const l = list[i];
    if (l.clip && i > 0) continue; // drawn with its base below
    const clipped = [];
    for (let j = i + 1; j < list.length && list[j].clip; j++) clipped.push(list[j]);
    if (!shown(l, t)) continue;
    if (clipped.some(c => c.visible && shown(c, t))) drawClipStack(ctx, l, clipped, t);
    else drawNode(ctx, l, t);
  }
}

// Every non-group layer in the order it is painted (bottom first), following groups.
export function paintOrder(doc) {
  const kids = new Map(), out = [];
  for (const l of doc.layers) { const k = l.parent ?? null; if (!kids.has(k)) kids.set(k, []); kids.get(k).push(l); }
  const walk = pid => { for (const l of kids.get(pid) || []) l.type === 'group' ? walk(l.id) : out.push(l); };
  walk(null);
  return out;
}

const shown = (l, t) => !t.show || t.show.has(l.id) || (l.type === 'group' && (t.kids.get(l.id) || []).some(c => shown(c, t)));

function drawNode(ctx, l, t) {
  if (l.type === 'adjustment') return drawAdjustment(ctx, l, t);
  if (l.type !== 'group') return drawLayer(ctx, l, t.env, t.doc);
  if (!l.visible) return;
  // A group is composited from its own buffer, then drawn with the group's opacity and blend mode.
  const buf = scratch(t.env, `group${t.depth}`, t.doc.width, t.doc.height);
  drawList(buf.getContext('2d'), t.kids.get(l.id) || [], { ...t, depth: t.depth + 1 });
  ctx.save();
  ctx.globalAlpha *= l.opacity;
  ctx.globalCompositeOperation = l.blend === 'normal' ? 'source-over' : l.blend;
  ctx.drawImage(buf, 0, 0);
  ctx.restore();
}

// Adjustment layer: re-draw what is already on ctx through the layer's filters and tone, then put that back over
// it with the layer's opacity, blend mode and masks. `limit` (clipped adjustment) restricts it to a base's pixels.
function drawAdjustment(ctx, l, t, limit = null) {
  if (!l.visible) return;
  const { doc, env } = t, a = scratch(env, `adjust${t.depth}`, doc.width, doc.height), ac = a.getContext('2d');
  ac.filter = filterString(l.adjust);
  ac.drawImage(ctx.canvas, 0, 0);
  ac.filter = 'none';
  if (hasTone(l)) {
    env.toneCache ||= new Map();
    const key = JSON.stringify(TONE_KEYS.map(k => l[k]));
    if (!env.toneCache.has(key)) { if (env.toneCache.size > 20) env.toneCache.clear(); env.toneCache.set(key, toneProgram(l)); }
    const gpu = env.gpuTone?.apply(a, env.toneCache.get(key));
    if (gpu) { ac.globalCompositeOperation = 'copy'; ac.drawImage(gpu, 0, 0); ac.globalCompositeOperation = 'source-over'; }
    else ac.putImageData(applyTone(ac.getImageData(0, 0, doc.width, doc.height), env.toneCache.get(key)), 0, 0);
  }
  if (l.mask?.length) {
    const M = scratch(env, 'maskbuf', doc.width, doc.height), mc = M.getContext('2d');
    mc.fillStyle = '#fff'; mc.fillRect(0, 0, doc.width, doc.height);
    for (const m of l.mask) {
      if (m.stroke) {
        mc.save(); mc.globalCompositeOperation = m.mode === 'reveal' ? 'source-over' : 'destination-out';
        mc.translate(l.x - m.x0, l.y - m.y0); softStroke(mc, m.stroke, '#fff'); mc.restore();
      } else {
        mc.globalCompositeOperation = m.mode === 'keep' ? 'destination-in' : 'destination-out';
        mc.drawImage(selectionMask(m.sel, m.w, m.h, env), l.x - m.x0, l.y - m.y0, m.w * (m.sx ?? 1), m.h * (m.sy ?? 1));
      }
    }
    ac.globalCompositeOperation = 'destination-in';
    ac.drawImage(M, 0, 0);
  }
  if (limit) { ac.globalCompositeOperation = 'destination-in'; ac.drawImage(limit, 0, 0); }
  ctx.save();
  ctx.globalAlpha *= l.opacity;
  ctx.globalCompositeOperation = l.blend === 'normal' ? 'source-atop' : l.blend; // never adds pixels where there were none
  ctx.drawImage(a, 0, 0);
  ctx.restore();
}

// Clipping stack: the clipped layers only show where the base has pixels; the base's opacity and blend mode
// apply to the whole stack (as in Photoshop / Affinity).
function drawClipStack(ctx, base, clipped, t) {
  if (!base.visible) return;
  const { doc, env } = t, d = t.depth;
  const stack = scratch(env, `clip${d}`, doc.width, doc.height), sc = stack.getContext('2d');
  drawNode(sc, { ...base, opacity: 1, blend: 'normal' }, { ...t, depth: d + 1 });
  const alpha = scratch(env, `clipAlpha${d}`, doc.width, doc.height);
  alpha.getContext('2d').drawImage(stack, 0, 0);
  for (const c of clipped) {
    if (!c.visible || !shown(c, t)) continue;
    if (c.type === 'adjustment') { drawAdjustment(sc, c, { ...t, depth: d + 1 }, alpha); continue; } // adjusts just this stack
    const tmp = scratch(env, `clipLayer${d}`, doc.width, doc.height), tc = tmp.getContext('2d');
    drawNode(tc, { ...c, opacity: 1, blend: 'normal' }, { ...t, depth: d + 1 });
    tc.globalCompositeOperation = 'destination-in';
    tc.drawImage(alpha, 0, 0);
    sc.save();
    sc.globalAlpha = c.opacity;
    sc.globalCompositeOperation = c.blend === 'normal' ? 'source-atop' : c.blend;
    sc.drawImage(tmp, 0, 0);
    sc.restore();
  }
  ctx.save();
  ctx.globalAlpha *= base.opacity;
  ctx.globalCompositeOperation = base.blend === 'normal' ? 'source-over' : base.blend;
  ctx.drawImage(stack, 0, 0);
  ctx.restore();
}

// Every image/mask asset referenced anywhere inside obj (a doc, a selection, an op).
export function assetsOf(obj, out = new Set()) {
  if (Array.isArray(obj)) for (const v of obj) assetsOf(v, out);
  else if (obj && typeof obj === 'object') {
    if ((obj.type === 'image' || obj.type === 'mask' || obj.patch) && typeof obj.asset === 'string') out.add(obj.asset);
    for (const v of Object.values(obj)) if (v && typeof v === 'object') assetsOf(v, out);
  }
  return out;
}

// Make sure every asset referenced by obj is loaded into env.images.
export async function preload(obj, env) {
  const missing = [...assetsOf(obj)].filter(a => !env.images.has(a));
  await Promise.all(missing.map(async a => env.images.set(a, await env.loadAsset(a))));
}

// Topmost visible layer under document point (x, y). Paint layers count only where painted.
export function hitTest(doc, ctx, env, x, y) {
  const hidden = id => { for (let p = id; p; ) { const g = doc.layers.find(q => q.id === p); if (!g) return false; if (!g.visible) return true; p = g.parent; } return false; };
  const order = paintOrder(doc);
  for (let i = order.length - 1; i >= 0; i--) {
    const l = order[i];
    if (!l.visible || l.type === 'adjustment' || hidden(l.parent)) continue;
    const size = layerSize(l, ctx);
    const [lx, ly] = apply(invert(layerMatrix(l, size)), x, y);
    if (!hasContentStage(l) && (lx < 0 || ly < 0 || lx >= size.w || ly >= size.h)) continue;
    const opaqueAt = layer => {
      const c = scratch(env, 'hit', doc.width, doc.height), cx = c.getContext('2d');
      drawLayer(cx, { ...layer, opacity: 1, blend: 'normal', adjust: {}, visible: true }, env, doc);
      return cx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data[3] > 0;
    };
    // Pixel-accurate: only count it where the layer actually shows.
    if ((['paint', 'fill', 'gradient'].includes(l.type) || l.mask?.length || hasContentStage(l)) && !opaqueAt(l)) continue;
    if (l.clip) { // a clipped layer only shows where its base (nearest unclipped sibling below) has pixels
      const sibs = doc.layers.filter(q => (q.parent ?? null) === (l.parent ?? null)), base = sibs.slice(0, sibs.indexOf(l)).reverse().find(q => !q.clip);
      if (base && base.type !== 'group' && !opaqueAt(base)) continue;
    }
    return l;
  }
  return null;
}
