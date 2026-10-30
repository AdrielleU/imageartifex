// Browser editor. Edits are previewed locally and committed to the server as ops on release;
// CLI edits arrive over SSE so Claude's changes appear live.
import { applyOp, selectionText, BLEND_MODES, ADJUST_DEFAULTS, ADJUST_UNITS, SELECTION_MODES } from '/src/model.js';
import { render, preload, layerSize, layerMatrix, invert, apply, hitTest, selectionMask, drawLayer, strokePath, paintOrder, fontOf, LINE_HEIGHT, defaultMesh } from '/src/render.js';
import { createGpuTone, gpuInfo } from '/web/gpu.js';
import { tracePath, anchorCount } from '/src/paths.js';
import { edgeCost, liveWire } from '/src/smartselect.js';
import { dodgeBurnLUT, DODGE_RANGES, CURVE_PRESETS, LEVELS_DEFAULT, TONE_CHANNELS, BALANCE_RANGES, THRESHOLD_DEFAULT, PARAM_SETS, C2A_DEFAULT, paramDefaults, curveFn, histogram, withoutTone } from '/src/tone.js';

const $ = s => document.querySelector(s);
const canvas = $('#canvas'), ctx = canvas.getContext('2d', { willReadFrequently: true });
// Which project this tab edits (?project=<name>; none = the project the server was started with).
const PROJECT = new URLSearchParams(location.search).get('project');
function api(p, params = {}) {
  const u = new URL(p, location.origin);
  if (PROJECT) u.searchParams.set('project', PROJECT);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.pathname + u.search;
}

const env = {
  images: new Map(), paintCache: new Map(),
  makeCanvas: (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h }),
  loadAsset: a => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = api(`/assets/${a}`); }),
  epoch: 0, // bumped when web fonts finish loading, so cached text layers are redrawn
};
document.fonts?.addEventListener('loadingdone', () => { env.epoch++; draw(); });

// Adjustments run as WebGL2 shaders on a real GPU. With software WebGL (SwiftShader, llvmpipe) the
// JavaScript path is faster, so it is used instead. ?gpu=0 forces the CPU, ?gpu=1 forces shaders.
const gpuParam = new URLSearchParams(location.search).get('gpu');
const gpuCandidate = gpuParam === '0' ? null : createGpuTone();
const gpu = gpuCandidate && (!gpuCandidate.info.software || gpuParam === '1') ? gpuCandidate : null;
if (gpu) env.gpuTone = gpu;
const gpuDetails = gpuCandidate?.info ?? gpuInfo();

// "ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 (0x00002484) Direct3D11 vs_5_0 ps_5_0, D3D11)" → "NVIDIA GeForce RTX 3070"
function gpuName(renderer) {
  const parts = renderer.replace(/^ANGLE \((.*)\)$/, '$1').split(/,\s*/);
  const name = parts.length > 1 && /^(NVIDIA|AMD|ATI|Intel|Apple|Google|Qualcomm|ARM|Mesa)/i.test(parts[0]) ? parts[1] : parts[0];
  return name.replace(/\s*\(0x[0-9a-f]+\)|\s*Direct3D.*|\s*vs_\d.*|\/PCIe.*|\/SSE2.*|\s*OpenGL.*|\s*\(TM\)|\s*\(R\)/gi, '').trim() || renderer;
}

// Badge: which GPU the browser draws with, or a warning when it falls back to software rendering.
function gpuBadge() {
  const b = $('#gpu-badge'), g = gpuDetails;
  const name = gpuName(g.renderer);
  b.className = g.software ? 'warn' : 'ok';
  b.textContent = g.software ? 'GPU: software (CPU)' : `GPU: ${name.length > 40 ? name.slice(0, 40) + '…' : name}`;
  b.title = [
    `Renderer: ${g.renderer}`,
    `Adjustments: ${gpu ? 'GPU (WebGL2 shaders)' : 'CPU (JavaScript)'}${gpuParam === '0' ? ' — forced by ?gpu=0' : !gpu && gpuCandidate ? ' — software WebGL would be slower' : ''}`,
    g.software ? 'Hardware acceleration is off or unavailable. Chrome: open chrome://gpu, and turn on Settings → System → "Use graphics acceleration when available". Firefox: about:support → Graphics.' : 'Hardware acceleration is on.',
    'Click for a GPU vs CPU speed and accuracy check.',
  ].join('\n');
  b.onclick = () => window.open('/web/gpu-check.html', '_blank');
}

const S = { doc: null, entries: [], canUndo: false, canRedo: false, selected: null, preview: null,
  tool: 'move', zoom: 1, size: 12, fontSize: 48, font: 'sans-serif', crop: null,
  selMode: 'replace', wand: { threshold: 32, contiguous: true, merged: true },
  clone: { source: null, sampleLayer: null, offset: null, aligned: true, merged: true, hardness: 0.75 },
  pen: { active: null, draft: null, edit: null, hover: null },
  folded: new Set(), // groups folded in the Layers panel (view only)
  quickMask: false,   // Q: brush paints the selection (red overlay = not selected)
  maskEdit: null,     // layer id whose mask the brush paints
  hardness: 1,        // brush hardness for strokes, masks and quick mask
  view: { rulers: true, grid: false, gridSize: 50, snap: true }, // per-browser view settings (see loadView)
  guideDrag: null,    // guide being dragged from a ruler or moved: { axis, pos, index? }
  brush: { opacity: 1, blend: 'normal', pressure: true },
  text: { bold: false, italic: false },
  sc: { anchors: [], segs: [], hover: null },            // intelligent scissors in progress
  fg: { outline: null, strokes: [], useSelection: false }, // foreground select in progress
  fonts: ['sans-serif', 'serif', 'monospace', 'cursive', 'system-ui', 'Arial', 'Helvetica', 'Georgia', 'Times New Roman', 'Courier New', 'Verdana', 'Trebuchet MS', 'Impact'], // pressure: use pen pressure when drawing with a pen
  focus: { mode: 'blur', strength: 4 },                  // blur / sharpen brush // active path id; path being drawn; edited copy
  retouch: { dodge: 'dodge', range: 'midtones', exposure: 50, rate: 50, flow: 0 },
  gradKind: 'linear', gradEnd: 'background', toneChannel: 'value', balanceRange: 'midtones', open: new Set() };
const SELECT_TOOLS = ['rselect', 'eselect', 'lasso', 'wand', 'scissors', 'fgselect'];
const OUTLINE_TOOLS = ['rselect', 'eselect', 'lasso', 'wand']; // dragging inside the selection moves it
const RETOUCH_TOOLS = ['clone', 'heal', 'smudge', 'dodge', 'blur'];
const LIQUIFY = { mode: 'push', strength: 0.5 };
let drag = null;

const cur = () => S.preview || S.doc;
const sel = (d = cur()) => d?.layers.find(l => l.id === S.selected) || null;
const r1 = n => Math.round(n * 10) / 10;
const color = () => $('#color').value;
const bgColor = () => $('#bgcolor').value;
const CHANNEL_COLORS = { value: '#e5e5e5', r: '#f87171', g: '#4ade80', b: '#60a5fa' };

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else if (k in e) e[k] = v;
    else if (v != null && v !== false) e.setAttribute(k, v);
  }
  e.append(...kids.flat().filter(k => k != null));
  return e;
}

function status(msg, error = false) {
  const s = $('#status');
  s.textContent = msg;
  s.className = error ? 'error' : '';
}

// ---- Server sync --------------------------------------------------------------------------

async function refresh() {
  const s = await (await fetch(api('/api/state'))).json();
  await preload(s.doc, env);
  Object.assign(S, { doc: s.doc, entries: s.entries, canUndo: s.canUndo, canRedo: s.canRedo });
  if (S.selected && !s.doc.layers.some(l => l.id === S.selected)) S.selected = null;
  if (!drag && !textEdit) { S.preview = null; S.draft = false; }
  if (S.meshEdit && !drag) { // keep showing the starting grid until the first drag commits a mesh
    const l = s.doc.layers.find(q => q.id === S.meshEdit.id);
    if (!l) S.meshEdit = null;
    else if (l.mesh?.kind !== S.meshEdit.kind) S.preview = applyOp(s.doc, { type: 'layer.update', id: l.id, props: { mesh: defaultMesh(S.meshEdit.kind, layerSize(l, ctx), S.meshEdit.cols, S.meshEdit.rows) } });
  }
  draw();
  panels();
  if (SELECT_TOOLS.includes(S.tool)) options();
}

async function commit(op) {
  const res = await fetch(api('/api/ops'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op }) });
  const body = await res.json();
  if (!res.ok) {
    status(body.error, true);
    S.preview = null;
    draw();
    return null;
  }
  status(body.entry.text);
  await refresh();
  return body.entry;
}

// draft: live slider previews may render big processed layers at half resolution (see render.js).
function setPreview(op, draft = false) {
  try { S.preview = applyOp(S.doc, op); } catch { S.preview = null; }
  S.draft = draft && !!S.preview;
  draw();
}

const update = props => S.selected && commit({ type: 'layer.update', id: S.selected, props });
const previewUpdate = props => S.selected && setPreview({ type: 'layer.update', id: S.selected, props }, true);

// ---- Drawing ------------------------------------------------------------------------------

// Redraws are coalesced to one per animation frame (pointer events and slider input often arrive faster).
let drawQueued = false;
function draw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; drawNow(); });
}

function drawNow() {
  const d = cur();
  if (!d) return;
  if (canvas.width !== d.width) canvas.width = d.width;
  if (canvas.height !== d.height) canvas.height = d.height;
  canvas.style.width = `${d.width * S.zoom}px`;
  canvas.style.height = `${d.height * S.zoom}px`;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, d.width, d.height);
  env.draft = !!(S.draft && S.preview) && !(gpu && !gpuDetails.software); // a real GPU previews at full resolution
  render(ctx, d, env);
  env.draft = false;
  if (S.quickMask) drawQuickMask(d);
  drawGridAndGuides(d);
  if (selXformActive()) drawSelHandles(d, 1 / S.zoom);
  if (S.tool === 'move' && S.meshEdit) drawMeshHandles(1 / S.zoom);
  if (S.tool === 'scissors' || S.tool === 'fgselect') drawSmartSelect(1 / S.zoom);
  updateAnts(S.quickMask ? { ...d, selection: null } : d);
  const px = 1 / S.zoom;

  const l = sel(d);
  if (l && !['paint', 'group', 'adjustment'].includes(l.type)) {
    const size = layerSize(l, ctx), m = layerMatrix(l, size);
    const pts = [[0, 0], [size.w, 0], [size.w, size.h], [0, size.h]].map(([x, y]) => apply(m, x, y));
    ctx.save();
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.lineWidth = 2 * px; ctx.strokeStyle = '#000'; ctx.stroke();
    ctx.setLineDash([5 * px, 5 * px]); ctx.lineWidth = 1 * px; ctx.strokeStyle = '#fff'; ctx.stroke();
    ctx.restore();
    if (S.tool === 'move' && !l.locks?.position && !S.meshEdit) drawTransformHandles(l, px);
  }
  if (S.crop) {
    const c = normRect(S.crop);
    ctx.save();
    ctx.fillStyle = '#000a';
    ctx.beginPath();
    ctx.rect(0, 0, d.width, d.height);
    ctx.rect(c.x, c.y, c.w, c.h);
    ctx.fill('evenodd');
    ctx.strokeStyle = '#fff'; ctx.lineWidth = px; ctx.strokeRect(c.x, c.y, c.w, c.h);
    ctx.restore();
  }
  if (RETOUCH_TOOLS.includes(S.tool)) drawCloneOverlay(d, px);
  drawPenOverlay(d, px);
  if (drag?.tool === 'text' && S.textBox?.w > 10) {
    ctx.save(); ctx.setLineDash([4 * px, 3 * px]); ctx.lineWidth = px; ctx.strokeStyle = '#4ea1ff';
    ctx.strokeRect(S.textBox.x, S.textBox.y, S.textBox.w, S.textBox.h); ctx.restore();
  }
  if (textEdit) placeTextEditor();
  drawRulers();
}

// ---- Rulers, guides, grid, snapping ---------------------------------------------------------------
function loadView() {
  try { Object.assign(S.view, JSON.parse(localStorage.getItem('artifex.view') || '{}')); } catch {}
  applyView();
}
function saveView() { try { localStorage.setItem('artifex.view', JSON.stringify(S.view)); } catch {} applyView(); draw(); }
function applyView() {
  $('#workspace').classList.toggle('no-rulers', !S.view.rulers);
  $('#rulers-label').textContent = S.view.rulers ? 'Hide rulers' : 'Show rulers';
  $('#grid-label').textContent = S.view.grid ? 'Hide grid' : 'Show grid';
  $('#snap-label').textContent = S.view.snap ? 'Turn snapping off' : 'Turn snapping on';
}

function drawGridAndGuides(d) {
  const px = 1 / S.zoom;
  ctx.save();
  if (S.view.grid) {
    ctx.beginPath();
    for (let x = S.view.gridSize; x < d.width; x += S.view.gridSize) { ctx.moveTo(x + px / 2, 0); ctx.lineTo(x + px / 2, d.height); }
    for (let y = S.view.gridSize; y < d.height; y += S.view.gridSize) { ctx.moveTo(0, y + px / 2); ctx.lineTo(d.width, y + px / 2); }
    ctx.lineWidth = px; ctx.strokeStyle = 'rgba(128, 128, 128, 0.45)'; ctx.stroke();
  }
  const guides = [...(d.guides || []).filter((_, i) => S.guideDrag?.index !== i), ...(S.guideDrag ? [S.guideDrag] : [])];
  ctx.beginPath();
  for (const g of guides) {
    if (g.axis === 'x') { ctx.moveTo(g.pos, 0); ctx.lineTo(g.pos, d.height); } else { ctx.moveTo(0, g.pos); ctx.lineTo(d.width, g.pos); }
  }
  ctx.lineWidth = px; ctx.strokeStyle = '#00b8ff'; ctx.stroke();
  ctx.restore();
}

// Snap a point to guides, the grid (when shown) and the canvas edges/centre, within 6 screen px.
function snapTargets(axis) {
  const d = S.doc, size = axis === 'x' ? d.width : d.height;
  return [0, size / 2, size, ...(d.guides || []).filter(g => g.axis === axis).map(g => g.pos)];
}
function snapValue(v, axis) {
  if (!S.view.snap) return v;
  const tol = 6 / S.zoom;
  let best = v, dist = tol;
  for (const t of snapTargets(axis)) if (Math.abs(t - v) < dist) { best = t; dist = Math.abs(t - v); }
  if (S.view.grid) { const g = Math.round(v / S.view.gridSize) * S.view.gridSize; if (Math.abs(g - v) < dist) best = g; }
  return best;
}
const snapPoint = (x, y) => [snapValue(x, 'x'), snapValue(y, 'y')];

// Snap a layer being moved: its left/centre/right (top/middle/bottom) edges to the nearest target.
function snapLayerMove(l, nx, ny) {
  if (!S.view.snap) return [nx, ny];
  const size = layerSize(l, ctx), m = layerMatrix({ ...l, x: nx, y: ny }, size);
  const pts = [[0, 0], [size.w, 0], [size.w, size.h], [0, size.h]].map(([a, b]) => apply(m, a, b));
  const fit = (axis, i) => {
    const vs = pts.map(p => p[i]), lo = Math.min(...vs), hi = Math.max(...vs);
    let shift = 0, dist = 6 / S.zoom;
    for (const v of [lo, (lo + hi) / 2, hi]) { const sv = snapValue(v, axis); if (sv !== v && Math.abs(sv - v) < dist) { shift = sv - v; dist = Math.abs(shift); } }
    return shift;
  };
  return [nx + fit('x', 0), ny + fit('y', 1)];
}

// Rulers: ticks in canvas pixels following zoom and scroll.
function drawRulers() {
  if (!S.view.rulers || !S.doc) return;
  const cr = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  for (const [id, axis] of [['#ruler-x', 'x'], ['#ruler-y', 'y']]) {
    const r = $(id), rr = r.getBoundingClientRect(), W = Math.round(rr.width * dpr), H = Math.round(rr.height * dpr);
    if (r.width !== W || r.height !== H) { r.width = W; r.height = H; }
    const c = r.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, rr.width, rr.height);
    const len = axis === 'x' ? rr.width : rr.height, origin = axis === 'x' ? cr.left - rr.left : cr.top - rr.top;
    const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000].find(v => v * S.zoom >= 60) || 10000;
    const minor = step / (String(step).startsWith('25') ? 5 : step % 5 === 0 && step >= 10 ? 5 : 2);
    const from = Math.floor(-origin / S.zoom / minor) * minor, to = (len - origin) / S.zoom;
    c.strokeStyle = cssVar('--muted'); c.fillStyle = cssVar('--muted'); c.lineWidth = 1; c.font = '9px system-ui, sans-serif';
    c.beginPath();
    for (let v = from; v <= to; v += minor) {
      const at = Math.round(origin + v * S.zoom) + 0.5, major = Math.abs(v / step - Math.round(v / step)) < 1e-6, t = major ? 18 : 5;
      if (axis === 'x') { c.moveTo(at, 18); c.lineTo(at, 18 - t); } else { c.moveTo(18, at); c.lineTo(18 - t, at); }
      if (major) {
        if (axis === 'x') c.fillText(String(Math.round(v)), at + 2, 9);
        else { c.save(); c.translate(9, at - 2); c.rotate(-Math.PI / 2); c.fillText(String(Math.round(v)), 0, 0); c.restore(); }
      }
    }
    c.stroke();
  }
}

// Drag from a ruler to make a guide; with the Move tool, drag a guide to move it, or off the canvas to delete it.
function guideAt(x, y) {
  const tol = 4 / S.zoom;
  return (S.doc.guides || []).findIndex(g => Math.abs((g.axis === 'x' ? x : y) - g.pos) < tol);
}
function startGuideDrag(axis, index = undefined) {
  const move = e => {
    const [x, y] = docPoint(e);
    S.guideDrag = { axis, pos: Math.round(snapValueGrid(axis === 'x' ? x : y)), index };
    draw();
  };
  const up = async e => {
    removeEventListener('pointermove', move); removeEventListener('pointerup', up);
    const g = S.guideDrag; S.guideDrag = null;
    const [x, y] = docPoint(e), inside = x >= 0 && y >= 0 && x <= S.doc.width && y <= S.doc.height;
    if (index !== undefined) await commit({ type: 'guide.remove', index });
    if (g && inside) await commit({ type: 'guide.add', axis, pos: g.pos });
    draw();
  };
  addEventListener('pointermove', move); addEventListener('pointerup', up);
}
const snapValueGrid = v => (S.view.snap && S.view.grid ? (Math.abs(Math.round(v / S.view.gridSize) * S.view.gridSize - v) < 6 / S.zoom ? Math.round(v / S.view.gridSize) * S.view.gridSize : v) : v);
$('#ruler-x').addEventListener('pointerdown', e => { e.preventDefault(); startGuideDrag('y'); });
$('#ruler-y').addEventListener('pointerdown', e => { e.preventDefault(); startGuideDrag('x'); });
new ResizeObserver(() => drawRulers()).observe($('#workspace'));

// [x, y] — or [x, y, pressure] when drawing with a pen and "Pen pressure" is on.
const penPoint = (e, x, y) => (e.pointerType === 'pen' && S.brush.pressure ? [x, y, Math.round(Math.max(0.05, e.pressure || 0.5) * 100) / 100] : [x, y]);

const isLight = hex => { const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)); return 0.2126 * r + 0.7152 * g + 0.0722 * b > 127; };

// Is (x, y) inside the current selection? (used to drag the outline with a selection tool)
function insideSelection(d, x, y) {
  if (!d.selection || x < 0 || y < 0 || x >= d.width || y >= d.height) return false;
  return selectionMask(d.selection, d.width, d.height, env).getContext('2d').getImageData(Math.floor(x), Math.floor(y), 1, 1).data[3] > 0;
}

// Quick mask overlay: red over everything that is NOT selected.
function drawQuickMask(d) {
  const o = document.createElement('canvas');
  o.width = d.width; o.height = d.height;
  const oc = o.getContext('2d');
  oc.fillStyle = 'rgba(255, 0, 0, 0.5)'; oc.fillRect(0, 0, d.width, d.height);
  if (d.selection) { oc.globalCompositeOperation = 'destination-out'; oc.drawImage(selectionMask(d.selection, d.width, d.height, env), 0, 0); }
  ctx.drawImage(o, 0, 0);
}

function setQuickMask(on) {
  S.quickMask = on;
  if (on) S.maskEdit = null;
  status(on ? 'Quick mask: paint with the brush — light color adds to the selection, dark removes. Q to finish.' : 'Quick mask off');
  options(); draw();
}

// ---- Transforming the selection outline (selection tools → "Transform outline") -------------------
let selBoxCache = { key: null, box: null };
function selectionBox(d) {
  const key = JSON.stringify(d.selection);
  if (selBoxCache.key !== key) {
    let box = null;
    if (d.selection) {
      const a = selectionMask(d.selection, d.width, d.height, env).getContext('2d').getImageData(0, 0, d.width, d.height).data;
      let x0 = d.width, y0 = d.height, x1 = -1, y1 = -1;
      for (let y = 0; y < d.height; y++) for (let x = 0; x < d.width; x++) if (a[(y * d.width + x) * 4 + 3]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      if (x1 >= 0) box = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    }
    selBoxCache = { key, box };
  }
  return selBoxCache.box;
}
const selXformActive = () => S.selXform && SELECT_TOOLS.includes(S.tool) && S.doc?.selection;
function selHandles(b) {
  const hs = HANDLES.map(([name, fx, fy]) => ({ name, fx, fy, at: [b.x + fx * b.w, b.y + fy * b.h] }));
  return { hs, knob: [b.x + b.w / 2, b.y - 24 / S.zoom], top: [b.x + b.w / 2, b.y] };
}
function drawSelHandles(d, px) {
  const b = selectionBox(d);
  if (!b) return;
  const { hs, knob, top } = selHandles(b), s = 7 * px;
  ctx.save();
  ctx.setLineDash([4 * px, 3 * px]); ctx.lineWidth = px; ctx.strokeStyle = '#4ea1ff'; ctx.strokeRect(b.x, b.y, b.w, b.h); ctx.setLineDash([]);
  ctx.beginPath(); ctx.moveTo(...top); ctx.lineTo(...knob); ctx.stroke();
  ctx.beginPath(); ctx.arc(...knob, 4.5 * px, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); ctx.strokeStyle = '#000'; ctx.stroke();
  for (const h of hs) { ctx.fillStyle = '#fff'; ctx.fillRect(h.at[0] - s / 2, h.at[1] - s / 2, s, s); ctx.strokeStyle = '#000'; ctx.strokeRect(h.at[0] - s / 2, h.at[1] - s / 2, s, s); }
  ctx.restore();
}
function selHandleHit(x, y) {
  const b = selXformActive() && selectionBox(S.doc);
  if (!b) return null;
  const { hs, knob } = selHandles(b), r = 7 / S.zoom;
  if (Math.hypot(knob[0] - x, knob[1] - y) < r) return { kind: 'rotate', b };
  const h = hs.find(h => Math.hypot(h.at[0] - x, h.at[1] - y) < r);
  return h ? { kind: 'scale', h, b } : null;
}
// Matrix for the drag: scale about the opposite corner/edge, or rotate about the centre.
function selDragMatrix(d, x, y, e) {
  const { b } = d;
  if (d.kind === 'rotate') {
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    let deg = ((Math.atan2(y - cy, x - cx) - Math.atan2(d.y - cy, d.x - cx)) * 180) / Math.PI;
    if (e.shiftKey) deg = Math.round(deg / 15) * 15;
    const r = (deg * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
    return { m: [cos, sin, -sin, cos, cx - cos * cx + sin * cy, cy - sin * cx - cos * cy], via: `rotated ${Math.round(deg)}° about (${Math.round(cx)}, ${Math.round(cy)})` };
  }
  const { fx, fy } = d.h, ax = b.x + (1 - fx) * b.w, ay = b.y + (1 - fy) * b.h, hx = b.x + fx * b.w, hy = b.y + fy * b.h;
  let sx = fx === 0.5 ? 1 : (x - ax) / (hx - ax || 1), sy = fy === 0.5 ? 1 : (y - ay) / (hy - ay || 1);
  if (e.shiftKey && fx !== 0.5 && fy !== 0.5) { const k = Math.max(Math.abs(sx), Math.abs(sy)); sx = Math.sign(sx || 1) * k; sy = Math.sign(sy || 1) * k; }
  return { m: [sx, 0, 0, sy, ax - sx * ax, ay - sy * ay], via: `scaled ${Math.round(sx * 100)}% × ${Math.round(sy * 100)}% about (${Math.round(ax)}, ${Math.round(ay)})` };
}

// Liquify stroke in the layer's own coordinates (what the server would compute from canvas points).
const liquifyOp = d => ({ type: 'layer.liquify', id: d.id, space: 'layer',
  stroke: { mode: LIQUIFY.mode, strength: LIQUIFY.strength, size: r1(S.size * d.k), points: d.points.map(([x, y]) => apply(d.inv, x, y).map(r1)) } });

// ---- Intelligent scissors / foreground select (computed by the server on commit; previewed here) ---------------
let costCache = { key: null, cost: null };
function scissorsCost() {
  const d = S.doc, key = `${S.entries.length}:${d.width}x${d.height}`;
  if (costCache.key !== key) {
    const c = env.makeCanvas(d.width, d.height), x = c.getContext('2d', { willReadFrequently: true });
    render(x, d, env);
    costCache = { key, cost: edgeCost(x.getImageData(0, 0, d.width, d.height).data, d.width, d.height) };
  }
  return costCache.cost;
}
function scissorsAdd(x, y, e) {
  const sc = S.sc, d = S.doc, r = 8 / S.zoom;
  if (sc.anchors.length >= 3 && Math.hypot(sc.anchors[0][0] - x, sc.anchors[0][1] - y) < r) return scissorsFinish(e);
  const p = [Math.round(x), Math.round(y)];
  if (sc.anchors.length) sc.segs.push(liveWire(scissorsCost(), d.width, d.height, sc.anchors.at(-1), p));
  sc.anchors.push(p);
  options(); draw();
}
async function scissorsFinish(e) {
  const sc = S.sc;
  if (sc.anchors.length < 3) return status('Click at least 3 points around the object', true);
  const anchors = sc.anchors;
  S.sc = { anchors: [], segs: [], hover: null };
  await commit({ type: 'selection.scissors', anchors, mode: e ? selModeFor(e) : S.selMode });
  options(); draw();
}
let wireQueued = false;
function scissorsHover(x, y) {
  const sc = S.sc;
  sc.hoverPt = [Math.round(x), Math.round(y)];
  if (!sc.anchors.length || wireQueued) return;
  wireQueued = true;
  requestAnimationFrame(() => {
    wireQueued = false;
    if (!sc.anchors.length || !sc.hoverPt) return;
    sc.hover = liveWire(scissorsCost(), S.doc.width, S.doc.height, sc.anchors.at(-1), sc.hoverPt, 30);
    draw();
  });
}
function drawSmartSelect(px) {
  const line = (pts, color, dash) => {
    if (!pts?.length) return;
    ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x + 0.5, y + 0.5) : ctx.moveTo(x + 0.5, y + 0.5)));
    ctx.setLineDash(dash ? [4 * px, 3 * px] : []); ctx.lineWidth = 1.5 * px; ctx.strokeStyle = color; ctx.stroke(); ctx.setLineDash([]);
  };
  ctx.save();
  if (S.tool === 'scissors') {
    for (const sg of S.sc.segs) line(sg, '#ffeb3b');
    line(S.sc.hover, '#ffeb3b', true);
    for (const [x, y] of S.sc.anchors) { ctx.fillStyle = '#ffeb3b'; ctx.fillRect(x - 3 * px, y - 3 * px, 6 * px, 6 * px); }
  }
  if (S.tool === 'fgselect') {
    const fg = S.fg;
    if (fg.outline?.length) line([...fg.outline, fg.outline[0]], '#4ea1ff', true);
    for (const st of [...fg.strokes, ...(drag?.tool === 'fgpaint' ? [{ points: drag.points, size: S.size }] : [])]) {
      ctx.globalAlpha = 0.45; strokePath(ctx, { color: '#22c55e', size: st.size, points: st.points }); ctx.globalAlpha = 1;
    }
    if (drag?.tool === 'fgoutline') line(drag.points, '#4ea1ff', true);
  }
  ctx.restore();
}
async function fgFinish() {
  const fg = S.fg;
  if (!fg.outline && !fg.useSelection) return status('Draw a rough outline around the object first', true);
  status('Finding the foreground…');
  S.fg = { outline: null, strokes: [], useSelection: false };
  await commit({ type: 'selection.foreground', ...(fg.outline ? { outline: fg.outline } : {}), strokes: fg.strokes.length ? fg.strokes : undefined, mode: S.selMode });
  options(); draw();
}

// ---- Perspective / warp editing (Move tool → Perspective / Warp) ------------------------------------------
// Handles are the mesh points (layer coordinates) shown through the layer's transform; each drag is one layer.update.
function startMeshEdit(kind, cols = 3, rows = 3, regrid = false) {
  const l = sel(S.doc);
  if (!l) return;
  const keep = !regrid && l.mesh?.kind === kind;
  S.meshEdit = { id: l.id, kind, cols: keep ? l.mesh.cols : cols, rows: keep ? l.mesh.rows : rows };
  if (!keep) setPreview({ type: 'layer.update', id: l.id, props: { mesh: defaultMesh(kind, layerSize(l, ctx), cols, rows) } });
  options(); draw();
}
const meshOf = () => { const l = cur()?.layers.find(q => q.id === S.meshEdit?.id); return l && { l, mesh: l.mesh, m: layerMatrix(l, layerSize(l, ctx)) }; };
function drawMeshHandles(px) {
  const o = meshOf();
  if (!o?.mesh) return;
  const pts = o.mesh.points.map(([u, v]) => apply(o.m, u, v)), { cols, rows } = o.mesh;
  ctx.save(); ctx.lineWidth = px; ctx.strokeStyle = '#4ea1ff';
  ctx.beginPath();
  if (o.mesh.kind === 'perspective') { pts.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p))); ctx.closePath(); }
  else for (let j = 0; j <= rows; j++) for (let i = 0; i <= cols; i++) {
    const p = pts[j * (cols + 1) + i];
    if (i < cols) { ctx.moveTo(...p); ctx.lineTo(...pts[j * (cols + 1) + i + 1]); }
    if (j < rows) { ctx.moveTo(...p); ctx.lineTo(...pts[(j + 1) * (cols + 1) + i]); }
  }
  ctx.stroke();
  const s = 8 * px;
  for (const p of pts) { ctx.fillStyle = '#fff'; ctx.fillRect(p[0] - s / 2, p[1] - s / 2, s, s); ctx.strokeStyle = '#000'; ctx.strokeRect(p[0] - s / 2, p[1] - s / 2, s, s); }
  ctx.restore();
}
function meshHit(x, y) {
  const o = S.tool === 'move' && S.meshEdit && meshOf();
  if (!o?.mesh) return -1;
  return o.mesh.points.findIndex(([u, v]) => { const [px, py] = apply(o.m, u, v); return Math.hypot(px - x, py - y) < 8 / S.zoom; });
}

// ---- Transform handles (Move tool): corners scale (Shift keeps proportions), edges stretch one way,
// the knob above the box rotates (Shift snaps to 15°). The opposite corner/edge stays put, rotated or not.
const HANDLES = [['nw', 0, 0], ['n', 0.5, 0], ['ne', 1, 0], ['e', 1, 0.5], ['se', 1, 1], ['s', 0.5, 1], ['sw', 0, 1], ['w', 0, 0.5]];
const HANDLE_CURSORS = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };

function transformFrame(l) {
  const size = layerSize(l, ctx), m = layerMatrix(l, size);
  const handles = HANDLES.map(([name, fx, fy]) => ({ name, fx, fy, at: apply(m, fx * size.w, fy * size.h) }));
  const rad = (l.rotation * Math.PI) / 180, flip = Math.sign(l.scaleY) || 1, top = apply(m, size.w / 2, 0);
  const knob = [top[0] + Math.sin(rad) * flip * (24 / S.zoom), top[1] - Math.cos(rad) * flip * (24 / S.zoom)];
  return { size, m, handles, top, knob };
}

function drawTransformHandles(l, px) {
  const f = transformFrame(l), s = 7 * px;
  ctx.save();
  ctx.beginPath(); ctx.moveTo(...f.top); ctx.lineTo(...f.knob); ctx.lineWidth = px; ctx.strokeStyle = '#000'; ctx.stroke();
  ctx.beginPath(); ctx.arc(...f.knob, 4.5 * px, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); ctx.stroke();
  for (const h of f.handles) {
    ctx.fillStyle = '#fff'; ctx.fillRect(h.at[0] - s / 2, h.at[1] - s / 2, s, s);
    ctx.strokeStyle = '#000'; ctx.strokeRect(h.at[0] - s / 2, h.at[1] - s / 2, s, s);
  }
  ctx.restore();
}

// Which handle of the selected layer is under (x, y): { kind: 'rotate' } or { kind: 'scale', handle }.
const ancestorsOf = (d, l) => { const out = []; for (let p = l.parent; p; p = d.layers.find(q => q.id === p)?.parent) out.push(p); return out; };

function transformHit(x, y) {
  const l = sel(S.doc);
  if (!l || ['paint', 'group', 'adjustment'].includes(l.type) || l.locks?.position || S.tool !== 'move' || S.meshEdit) return null;
  const f = transformFrame(l), r = 7 / S.zoom;
  if (Math.hypot(f.knob[0] - x, f.knob[1] - y) < r) return { kind: 'rotate', l, f };
  const h = f.handles.find(h => Math.hypot(h.at[0] - x, h.at[1] - y) < r);
  return h ? { kind: 'scale', handle: h, l, f } : null;
}

function startTransform(hit, x, y) {
  const { l, f } = hit;
  if (hit.kind === 'rotate') {
    const c = apply(f.m, f.size.w / 2, f.size.h / 2);
    return { tool: 'move', mode: 'rotate', l0: { ...l }, center: c, a0: Math.atan2(y - c[1], x - c[0]), moved: false };
  }
  const { fx, fy } = hit.handle, { w, h } = f.size, ax = (1 - fx) * w, ay = (1 - fy) * h;
  return { tool: 'move', mode: 'scale', l0: { ...l }, size: f.size, inv: invert(f.m), fx, fy, ax, ay, hx: fx * w, hy: fy * h,
    anchorDoc: apply(f.m, ax, ay), moved: false };
}

function moveTransform(d, x, y, e) {
  d.moved = true;
  if (d.mode === 'rotate') {
    let deg = d.l0.rotation + ((Math.atan2(y - d.center[1], x - d.center[0]) - d.a0) * 180) / Math.PI;
    if (e.shiftKey) deg = Math.round(deg / 15) * 15;
    deg = ((((deg + 180) % 360) + 360) % 360) - 180;
    return setPreview({ type: 'layer.update', id: d.l0.id, props: { rotation: r1(deg) } });
  }
  const [u, v] = apply(d.inv, ...snapPoint(x, y));
  let kx = d.fx === 0.5 ? 1 : (u - d.ax) / (d.hx - d.ax), ky = d.fy === 0.5 ? 1 : (v - d.ay) / (d.hy - d.ay);
  if (e.shiftKey && d.fx !== 0.5 && d.fy !== 0.5) { const k = Math.max(Math.abs(kx), Math.abs(ky)); kx = Math.sign(kx || 1) * k; ky = Math.sign(ky || 1) * k; }
  // never collapse below one pixel; dragging past the anchor flips
  const minK = (n, s) => 1 / Math.max(1, n * Math.abs(s));
  if (Math.abs(kx) < minK(d.size.w, d.l0.scaleX)) kx = Math.sign(kx || 1) * minK(d.size.w, d.l0.scaleX);
  if (Math.abs(ky) < minK(d.size.h, d.l0.scaleY)) ky = Math.sign(ky || 1) * minK(d.size.h, d.l0.scaleY);
  const scaleX = Math.round(d.l0.scaleX * kx * 10000) / 10000, scaleY = Math.round(d.l0.scaleY * ky * 10000) / 10000;
  // place the layer so the anchor (opposite corner/edge) stays where it was
  const p = apply(layerMatrix({ ...d.l0, scaleX, scaleY, x: 0, y: 0 }, d.size), d.ax, d.ay);
  setPreview({ type: 'layer.update', id: d.l0.id, props: { scaleX, scaleY, x: r1(d.anchorDoc[0] - p[0]), y: r1(d.anchorDoc[1] - p[1]) } });
}

async function endTransform(d) {
  const l = S.preview?.layers.find(q => q.id === d.l0.id);
  if (!d.moved || !l) { S.preview = null; draw(); return; }
  const keys = d.mode === 'rotate' ? ['rotation'] : ['x', 'y', 'scaleX', 'scaleY'];
  const props = Object.fromEntries(keys.filter(k => l[k] !== d.l0[k]).map(k => [k, l[k]]));
  if (Object.keys(props).length) await commit({ type: 'layer.update', id: l.id, props });
  else { S.preview = null; draw(); }
}

function fontSelect(value, onPick) {
  const list = S.fonts.includes(value) ? S.fonts : [value, ...S.fonts];
  return el('select', { onchange: e => onPick(e.target.value) }, list.map(f => el('option', { value: f, selected: f === value, style: `font-family:${/\s/.test(f) ? `'${f}'` : f}` }, f)));
}

async function loadLocalFonts() {
  try {
    const fams = [...new Set((await window.queryLocalFonts()).map(f => f.family))].sort();
    S.fonts = [...new Set([...S.fonts.slice(0, 5), ...fams])];
    status(`${fams.length} installed fonts available. Note: exports render on the server, which needs the same fonts installed.`);
    options(); propsPanel(true);
  } catch (err) { status(`Could not list installed fonts: ${err.message}`, true); }
}

// ---- On-canvas text editing ------------------------------------------------------------------
// A transparent textarea sits exactly over the text layer (same transform, font and wrapping). The canvas shows
// the real rendering as you type (a preview op); Ctrl+Enter or clicking away commits, Esc cancels.
let textEdit = null; // { id, isNew, spec?, ta }

function textEditOp(text) {
  return textEdit.isNew ? { type: 'layer.add', layer: { ...textEdit.spec, text } } : { type: 'layer.update', id: textEdit.id, props: { text } };
}

function placeTextEditor() {
  const t = textEdit, l = cur()?.layers.find(q => q.id === t.id);
  if (!l) return;
  const size = layerSize(l, ctx), m = layerMatrix(l, size), z = S.zoom, lh = l.size * (l.lineHeight ?? LINE_HEIGHT);
  Object.assign(t.ta.style, {
    transform: `matrix(${m[0] * z}, ${m[1] * z}, ${m[2] * z}, ${m[3] * z}, ${40 + m[4] * z}, ${40 + m[5] * z})`,
    font: fontOf(l), lineHeight: `${lh}px`, textAlign: l.align,
    width: `${(l.boxWidth || Math.max(size.w, l.size)) + (l.boxWidth ? 0 : l.size)}px`, height: `${size.h + lh}px`,
    whiteSpace: l.boxWidth ? 'pre-wrap' : 'pre',
  });
}

function startTextEdit(l, isNew = false) {
  finishTextEdit(false);
  const ta = el('textarea', { class: 'text-edit', spellcheck: false, value: isNew ? '' : l.text });
  textEdit = { id: l.id, isNew, spec: isNew ? l : null, ta, orig: l.text };
  $('#stage').append(ta);
  ta.addEventListener('input', () => { setPreview(textEditOp(ta.value)); placeTextEditor(); });
  ta.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); finishTextEdit(false); }
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); finishTextEdit(true); }
  });
  ta.addEventListener('blur', () => finishTextEdit(true));
  setPreview(textEditOp(ta.value || (isNew ? '' : l.text)));
  placeTextEditor();
  ta.focus();
  requestAnimationFrame(() => { if (textEdit?.ta === ta) ta.focus(); });
  status(isNew ? 'Type your text — Ctrl+Enter or click away to finish, Esc to cancel' : 'Editing text — Ctrl+Enter or click away to finish, Esc to cancel');
}

async function finishTextEdit(save) {
  const t = textEdit;
  if (!t) return;
  textEdit = null;
  const text = t.ta.value;
  t.ta.remove();
  S.preview = null;
  if (save && t.isNew && text.trim()) {
    const { id, ...spec } = t.spec;
    const e = await commit({ type: 'layer.add', layer: { ...spec, text } });
    if (e) S.selected = e.op.layer.id;
  } else if (save && !t.isNew && text !== t.orig) await commit({ type: 'layer.update', id: t.id, props: { text } });
  panels(); draw();
}

function newTextSpec(x, y, boxWidth) {
  return { type: 'text', id: '__text', text: '', x: Math.round(x), y: Math.round(y), size: S.fontSize, font: S.font, color: color(),
    weight: S.text.bold ? 'bold' : 'normal', ...(S.text.italic ? { italic: true } : {}), ...(boxWidth ? { boxWidth: Math.round(boxWidth) } : {}) };
}

// ---- Pen tool: bezier paths ----------------------------------------------------------------
// While drawing, the new path lives in S.pen.draft (one subpath) and is committed as path.add when finished.
// Dragging anchors/handles of the active path edits a copy (S.pen.edit), committed as path.update on release.

const activePath = () => (S.doc?.paths || []).find(p => p.id === S.pen.active) || null;
function penSubpaths() {
  if (S.pen.draft) return [S.pen.draft];
  return S.pen.edit || activePath()?.subpaths || null;
}

function drawPenOverlay(d, px) {
  const sps = penSubpaths();
  if (!sps) return;
  const full = S.tool === 'pen';
  ctx.save();
  ctx.beginPath();
  tracePath(ctx, sps);
  ctx.lineWidth = 3 * px; ctx.strokeStyle = '#000a'; ctx.stroke();
  ctx.lineWidth = 1.5 * px; ctx.strokeStyle = '#4ea1ff'; ctx.stroke();
  const draft = S.pen.draft, h = S.pen.hover;
  if (full && draft && h && !drag) { // rubber band to the pointer
    const last = draft.anchors.at(-1);
    ctx.beginPath(); ctx.moveTo(last.x, last.y);
    if (last.out) ctx.quadraticCurveTo(...last.out, ...h); else ctx.lineTo(...h);
    ctx.setLineDash([4 * px, 4 * px]); ctx.lineWidth = px; ctx.strokeStyle = '#4ea1ff'; ctx.stroke(); ctx.setLineDash([]);
  }
  if (full) {
    const size = 7 * px;
    for (const sp of sps) sp.anchors.forEach((a, i) => {
      for (const hd of [a.in, a.out]) if (hd) {
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(...hd); ctx.lineWidth = px; ctx.strokeStyle = '#4ea1ff'; ctx.stroke();
        ctx.beginPath(); ctx.arc(...hd, 3.5 * px, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); ctx.strokeStyle = '#000'; ctx.stroke();
      }
      const closing = draft && i === 0 && sp.anchors.length > 1 && h && Math.hypot(h[0] - a.x, h[1] - a.y) < 7 * px;
      ctx.fillStyle = closing ? '#4ea1ff' : i === 0 && draft ? '#cde4ff' : '#fff';
      ctx.fillRect(a.x - size / 2, a.y - size / 2, size, size);
      ctx.lineWidth = px; ctx.strokeStyle = '#000'; ctx.strokeRect(a.x - size / 2, a.y - size / 2, size, size);
    });
  }
  ctx.restore();
}

// Anchor or handle of the editable path under (x, y).
function penHit(x, y) {
  const sps = penSubpaths(), r = 7 / S.zoom;
  if (!sps) return null;
  for (const [si, sp] of sps.entries()) for (const [ai, a] of sp.anchors.entries()) {
    for (const which of ['in', 'out']) if (a[which] && Math.hypot(a[which][0] - x, a[which][1] - y) < r) return { kind: 'handle', si, ai, which };
  }
  for (const [si, sp] of sps.entries()) for (const [ai, a] of sp.anchors.entries()) if (Math.hypot(a.x - x, a.y - y) < r) return { kind: 'anchor', si, ai };
  return null;
}

const roundPath = sps => sps.map(sp => ({ closed: !!sp.closed, anchors: sp.anchors.map(a => {
  const o = { x: r1(a.x), y: r1(a.y) };
  if (a.in) o.in = a.in.map(r1);
  if (a.out) o.out = a.out.map(r1);
  return o;
}) }));

async function finishPen() {
  const draft = S.pen.draft;
  S.pen.draft = null;
  if (!draft || draft.anchors.length < 2) { draw(); return; }
  const entry = await commit({ type: 'path.add', path: { subpaths: roundPath([draft]) } });
  if (entry) S.pen.active = entry.op.path.id;
  panels(); options(); draw();
}

function penDown(x, y, e) {
  [x, y] = snapPoint(x, y);
  const P = S.pen, r = 7 / S.zoom;
  if (P.draft) {
    const a = P.draft.anchors;
    if (a.length >= 2 && Math.hypot(a[0].x - x, a[0].y - y) < r) { P.draft.closed = true; finishPen(); return; }
    a.push({ x, y });
    drag = { tool: 'pen', mode: 'smooth', anchor: a.at(-1) };
  } else {
    const hit = penHit(x, y);
    if (hit && activePath()) {
      P.edit = structuredClone(activePath().subpaths);
      drag = { tool: 'pen', mode: hit.kind, hit, x, y, orig: structuredClone(P.edit), moved: false };
    } else {
      P.active = null;
      P.draft = { closed: false, anchors: [{ x, y }] };
      drag = { tool: 'pen', mode: 'smooth', anchor: P.draft.anchors[0] };
      options(); panels();
    }
  }
  draw();
}

function penMove(x, y, e) {
  const P = S.pen;
  if (drag.mode === 'smooth') {
    // Dragging out a new anchor sets symmetric handles (a plain click leaves a corner).
    const a = drag.anchor;
    if (Math.hypot(x - a.x, y - a.y) < 2) { delete a.in; delete a.out; }
    else { a.out = [x, y]; a.in = [2 * a.x - x, 2 * a.y - y]; }
  } else {
    drag.moved = true;
    const { si, ai, which } = drag.hit, o = drag.orig[si].anchors[ai], a = P.edit[si].anchors[ai], dx = x - drag.x, dy = y - drag.y;
    if (drag.mode === 'anchor') {
      a.x = o.x + dx; a.y = o.y + dy;
      for (const k of ['in', 'out']) if (o[k]) a[k] = [o[k][0] + dx, o[k][1] + dy];
    } else {
      a[which] = [o[which][0] + dx, o[which][1] + dy];
      const other = which === 'in' ? 'out' : 'in';
      if (o[other] && !e.altKey) { // keep the curve smooth: the opposite handle turns with this one (Alt breaks it)
        const len = Math.hypot(o[other][0] - o.x, o[other][1] - o.y), ang = Math.atan2(a[which][1] - a.y, a[which][0] - a.x) + Math.PI;
        a[other] = [a.x + Math.cos(ang) * len, a.y + Math.sin(ang) * len];
      }
    }
  }
  draw();
}

async function penUp() {
  const P = S.pen, d = drag;
  if (d.mode === 'smooth') { draw(); return; }
  const edit = P.edit;
  if (d.moved && edit && P.active) await commit({ type: 'path.update', id: P.active, props: { subpaths: roundPath(edit) } });
  P.edit = null;
  draw();
}

async function pathCommand(kind) {
  const p = activePath();
  if (!p) return status('Select a path in the Paths panel (or draw one with the Pen tool, P) first', true);
  if (kind === 'select') await commit({ type: 'path.select', id: p.id, mode: 'replace' });
  else if (kind === 'fill') { const e = await commit({ type: 'path.fill', id: p.id, color: color() }); if (e) S.selected = e.op.layer.id; }
  else if (kind === 'stroke') {
    const l = sel(S.doc), onto = l?.type === 'paint' ? l.id : undefined;
    const e = await commit({ type: 'path.stroke', id: p.id, color: color(), size: S.size, layer: onto });
    if (e && !onto) S.selected = e.op.layer.id;
  } else if (kind === 'delete') { await commit({ type: 'path.remove', id: p.id }); S.pen.active = null; }
  panels(); options(); draw();
}

function channelsPanel() {
  const box = $('#channels'), chans = S.doc.channels || [];
  box.replaceChildren(
    ...(chans.length ? chans.map(c => el('div', { class: 'layer', title: 'Click to load as the selection' , onclick: () => commit({ type: 'channel.load', name: c.name }) },
      el('span', { class: 'name' }, c.name),
      el('button', { title: 'Add to the selection', onclick: e => { e.stopPropagation(); commit({ type: 'channel.load', name: c.name, mode: 'add' }); } }, '+'),
      el('button', { title: 'Subtract from the selection', onclick: e => { e.stopPropagation(); commit({ type: 'channel.load', name: c.name, mode: 'subtract' }); } }, '−'),
      el('button', { title: 'Delete channel', onclick: e => { e.stopPropagation(); commit({ type: 'channel.remove', name: c.name }); } }, '×')))
      : [el('div', { class: 'muted' }, 'No saved selections.')]),
    el('div', { class: 'row' }, el('button', { disabled: !S.doc.selection, onclick: () => run('save-selection') }, 'Save selection…')));
}

function pathsPanel() {
  const box = $('#paths');
  box.replaceChildren();
  const paths = S.doc.paths || [];
  if (S.pen.active && !paths.some(p => p.id === S.pen.active)) S.pen.active = null;
  if (!paths.length) return box.append(el('div', { class: 'muted' }, 'No paths. Use the Pen tool (P): click for corners, drag for curves.'));
  for (const p of [...paths].reverse()) {
    box.append(el('div', { class: `layer${p.id === S.pen.active ? ' selected' : ''}`, title: 'Click to make active, double-click to rename',
      onclick: () => { S.pen.active = p.id; S.pen.draft = null; panels(); options(); draw(); },
      ondblclick: () => { const n = prompt('Path name', p.name); if (n && n !== p.name) commit({ type: 'path.update', id: p.id, props: { name: n } }); } },
      el('span', { class: 'name' }, p.name), el('span', { class: 'muted' }, `${anchorCount(p.subpaths)} pts · ${p.id}`)));
  }
  if (activePath()) box.append(el('div', { class: 'row' },
    el('button', { onclick: () => pathCommand('select'), title: 'Path → selection' }, 'Select'),
    el('button', { onclick: () => pathCommand('stroke'), title: 'Stroke with the foreground color and brush size' }, 'Stroke'),
    el('button', { onclick: () => pathCommand('fill'), title: 'Fill with the foreground color (new layer)' }, 'Fill'),
    el('button', { onclick: () => pathCommand('delete') }, 'Delete')));
}

// Clone/heal: live preview of the stroke (a plain clone; the server computes the healed result) and a
// crosshair where the source is being sampled.
function drawCloneOverlay(d, px) {
  const c = S.clone;
  if (drag?.snap) {
    const tmp = document.createElement('canvas');
    tmp.width = d.width; tmp.height = d.height;
    const t = tmp.getContext('2d');
    strokePath(t, { color: '#fff', size: S.size, points: drag.points });
    t.globalCompositeOperation = 'source-in';
    t.drawImage(drag.snap, -drag.offset[0], -drag.offset[1]);
    ctx.drawImage(tmp, 0, 0);
  } else if (drag?.tool === 'smudge' || drag?.tool === 'blur') {
    // smudge is computed by the server when the stroke ends; show where it goes
    ctx.save();
    ctx.globalAlpha = 0.35;
    strokePath(ctx, { color: '#fff', size: S.size, points: drag.points });
    ctx.restore();
  }
  if (S.tool !== 'clone' && S.tool !== 'heal') return;
  const at = drag?.offset ? [drag.points.at(-1)[0] + drag.offset[0], drag.points.at(-1)[1] + drag.offset[1]] : c.source;
  if (!at) return;
  ctx.save();
  ctx.lineWidth = 2 * px;
  for (const [color, w] of [['#000', 3], ['#fff', 1]]) {
    ctx.strokeStyle = color; ctx.lineWidth = w * px;
    ctx.beginPath();
    ctx.arc(at[0], at[1], S.size / 2, 0, Math.PI * 2);
    ctx.moveTo(at[0] - 6 * px, at[1]); ctx.lineTo(at[0] + 6 * px, at[1]);
    ctx.moveTo(at[0], at[1] - 6 * px); ctx.lineTo(at[0], at[1] + 6 * px);
    ctx.stroke();
  }
  ctx.restore();
}

// ---- Marching ants: the selection outline, animated on an overlay canvas ------------------

const ants = $('#ants'), actx = ants.getContext('2d');
let antsKey = null, antsEdges = null, antsImage = null, antsBox = null, antsPhase = 0;

function updateAnts(d) {
  if (ants.width !== d.width || ants.height !== d.height) { ants.width = d.width; ants.height = d.height; antsKey = null; }
  ants.style.width = canvas.style.width;
  ants.style.height = canvas.style.height;
  const key = JSON.stringify(d.selection);
  if (key === antsKey) return;
  antsKey = key;
  antsEdges = antsBox = null;
  actx.clearRect(0, 0, ants.width, ants.height);
  if (d.selection) {
    const w = d.width, h = d.height;
    const a = selectionMask(d.selection, w, h, env).getContext('2d').getImageData(0, 0, w, h).data;
    const on = i => a[i * 4 + 3] >= 128, edges = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (on(i) && (x === 0 || y === 0 || x === w - 1 || y === h - 1 || !on(i - 1) || !on(i + 1) || !on(i - w) || !on(i + w))) edges.push(i);
    }
    antsEdges = Int32Array.from(edges);
    antsImage = actx.createImageData(w, h);
    // only the outline's bounding box is re-uploaded on each animation step
    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    for (const i of edges) { const x = i % w, y = (i - x) / w; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    antsBox = edges.length ? [x0, y0, x1 - x0 + 1, y1 - y0 + 1] : null;
  }
  paintAnts();
}

function paintAnts() {
  if (!antsEdges || !antsBox) { actx.clearRect(0, 0, ants.width, ants.height); return; }
  const w = ants.width, data = antsImage.data;
  for (const i of antsEdges) {
    const v = (((i % w) + Math.floor(i / w) + antsPhase) >> 2) & 1 ? 255 : 0;
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  actx.putImageData(antsImage, 0, 0, ...antsBox);
}
setInterval(() => { if (antsEdges) { antsPhase = (antsPhase + 1) % 8; paintAnts(); } }, 120);

const selModeFor = e => (e.shiftKey && e.altKey ? 'intersect' : e.shiftKey ? 'add' : e.altKey ? 'subtract' : S.selMode);

function normRect({ x, y, x2, y2 }, square = false) {
  let w = x2 - x, h = y2 - y;
  if (square) { const s = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * s; h = Math.sign(h || 1) * s; }
  return { x: Math.round(Math.min(x, x + w)), y: Math.round(Math.min(y, y + h)), w: Math.round(Math.abs(w)), h: Math.round(Math.abs(h)) };
}

// ---- Canvas interaction -------------------------------------------------------------------

function docPoint(e) {
  const r = canvas.getBoundingClientRect(), d = cur();
  return [(e.clientX - r.left) * d.width / r.width, (e.clientY - r.top) * d.height / r.height];
}

function strokeOp() {
  // Quick mask / mask painting: the brush edits the selection or a layer mask instead of pixels.
  const brush = { points: drag.points.map(p => p.map(r1)), size: S.size, hardness: S.hardness };
  const light = drag.tool !== 'eraser' && isLight(color());
  if (S.quickMask) return { type: 'selection.paint', mode: light ? 'add' : 'subtract', stroke: brush };
  if (S.maskEdit) return { type: 'layer.maskStroke', id: S.maskEdit, mode: drag.tool === 'eraser' || light ? 'reveal' : 'hide', stroke: brush };
  const l = S.doc.layers.find(l => l.id === drag.layerId);
  if (!l) return null;
  const inv = invert(layerMatrix(l, layerSize(l, ctx)));
  const points = drag.points.map(([x, y, p]) => (p == null ? apply(inv, x, y).map(r1) : [...apply(inv, x, y).map(r1), p]));
  const stroke = { color: color(), size: S.size, erase: drag.tool === 'eraser', points };
  if (S.brush.opacity !== 1) stroke.opacity = S.brush.opacity;
  if (S.hardness !== 1) stroke.hardness = S.hardness;
  if (S.brush.blend !== 'normal' && drag.tool === 'brush') stroke.blend = S.brush.blend;
  // Painting is limited to the selection (the server does the same for CLI strokes).
  if (S.doc.selection) stroke.clip = { sel: S.doc.selection, w: S.doc.width, h: S.doc.height, dx: -l.x, dy: -l.y };
  return { type: 'paint.stroke', id: l.id, stroke };
}

// Gradient from the drag; Shift snaps the angle to 15° steps (as in GIMP).
function gradientLayer(d, snap) {
  let { x2, y2 } = d;
  if (snap) {
    const a = Math.round(Math.atan2(y2 - d.y, x2 - d.x) / (Math.PI / 12)) * (Math.PI / 12), len = Math.hypot(x2 - d.x, y2 - d.y);
    x2 = d.x + Math.cos(a) * len; y2 = d.y + Math.sin(a) * len;
  }
  const layer = { type: 'gradient', kind: S.gradKind, x1: Math.round(d.x), y1: Math.round(d.y), x2: Math.round(x2), y2: Math.round(y2),
    stops: [[0, color()], [1, S.gradEnd === 'transparent' ? 'transparent' : bgColor()]] };
  if (S.doc.selection) layer.mask = [{ mode: 'keep', sel: S.doc.selection, w: S.doc.width, h: S.doc.height, x0: 0, y0: 0 }];
  return layer;
}

function shapeLayer(tool, rect) {
  return { type: 'shape', shape: tool === 'ellipse' ? 'ellipse' : 'rect', x: rect.x, y: rect.y, w: rect.w, h: rect.h, fill: color() };
}

canvas.addEventListener('pointerdown', async e => {
  if (!S.doc || e.button !== 0) return;
  try { canvas.setPointerCapture(e.pointerId); } catch {} // fails for synthetic events; capture is only a convenience
  const [x, y] = docPoint(e), tool = S.tool;

  if (S.pickC2A) {
    // Color to alpha's "Pick from canvas": the server samples the layer at this point (same op as the CLI's --at).
    const id = S.pickC2A;
    S.pickC2A = null;
    canvas.style.cursor = '';
    await commit({ type: 'layer.colorToAlpha', id, at: [Math.floor(x), Math.floor(y)] });
    return;
  }

  if (tool === 'pen') return penDown(x, y, e);
  if (tool === 'move' && S.meshEdit) {
    const i = meshHit(x, y), o = meshOf();
    if (i >= 0) drag = { tool: 'mesh', i, inv: invert(o.m), mesh: structuredClone(o.mesh), id: o.l.id, moved: false };
    return;
  }
  if (tool === 'move' && guideAt(x, y) >= 0 && !transformHit(x, y)) {
    const i = guideAt(x, y), g = S.doc.guides[i];
    S.guideDrag = { ...g, index: i };
    startGuideDrag(g.axis, i);
    return;
  }
  if (tool === 'move') {
    const th = transformHit(x, y);
    if (th) { drag = startTransform(th, x, y); return; }
    const hit = hitTest(S.doc, ctx, env, x, y), cur = sel(S.doc);
    // A selected group is dragged as a whole when you press on something inside it.
    if (cur?.type === 'group' && hit && ancestorsOf(S.doc, hit).includes(cur.id)) {
      const locked = S.doc.layers.find(q => q.locks?.position && ancestorsOf(S.doc, q).includes(cur.id));
      if (locked) return status(`Can't move group "${cur.name}": layer "${locked.name}" in it is locked (position)`, true);
      drag = { tool, mode: 'group', id: cur.id, x, y, moved: false };
      return;
    }
    if (hit) S.selected = hit.id;
    const l = sel(S.doc);
    if (l?.locks?.position) { status(`Layer "${l.name}" is locked (position)`, true); draw(); panels(); return; }
    if (l && l.type !== 'group') drag = { tool, x, y, ox: l.x, oy: l.y, moved: false };
    draw(); panels(); options();
  } else if ((tool === 'brush' || tool === 'eraser') && (S.quickMask || S.maskEdit)) {
    drag = { tool, points: [[x, y]], special: true };
    setPreview(strokeOp());
  } else if (tool === 'brush' || tool === 'eraser') {
    drag = { tool, points: [penPoint(e, x, y)], layerId: null };
    let l = sel(S.doc);
    if (!l || l.type !== 'paint') {
      if (tool === 'eraser') { drag = null; return status('Select a paint layer to erase on (eraser works on paint layers)', true); }
      const entry = await commit({ type: 'layer.add', layer: { type: 'paint' } });
      if (!entry) { drag = null; return; }
      S.selected = entry.op.layer.id;
      l = sel(S.doc);
    }
    if (!drag) return; // released while the layer was being created
    drag.layerId = l.id;
    setPreview(strokeOp());
  } else if (tool === 'clone' || tool === 'heal') {
    const c = S.clone;
    if (e.altKey || e.ctrlKey || e.metaKey) {
      c.source = [Math.round(x), Math.round(y)]; c.offset = null;
      c.sampleLayer = c.merged ? null : sel(S.doc)?.id ?? null;
      status(`Source set at (${c.source[0]}, ${c.source[1]})${c.sampleLayer ? ` on layer "${sel(S.doc).name}"` : ' (merged image)'}`);
      options(); draw();
      return;
    }
    if (!c.source) return status(`Alt-click (or Ctrl-click) to set where to ${tool} from first`, true);
    if (!c.merged && !c.sampleLayer) return status('Alt-click on the canvas with the layer to sample selected, or turn on "Sample merged"', true);
    // Aligned: keep the first stroke's offset; otherwise every stroke starts sampling at the source point again.
    const offset = c.aligned && c.offset ? c.offset : [c.source[0] - Math.round(x), c.source[1] - Math.round(y)];
    c.offset = offset;
    const snap = document.createElement('canvas');
    snap.width = S.doc.width; snap.height = S.doc.height;
    const sample = c.sampleLayer && S.doc.layers.find(l => l.id === c.sampleLayer);
    render(snap.getContext('2d'), sample ? { ...S.doc, layers: [{ ...sample, opacity: 1, blend: 'normal', visible: true }] } : S.doc, env, { background: !sample });
    drag = { tool, points: [[x, y]], offset, snap, layerId: null };
    let l = sel(S.doc);
    if (!l || l.type !== 'paint') {
      const entry = await commit({ type: 'layer.add', layer: { type: 'paint', name: tool === 'heal' ? 'Healing' : 'Clone' } });
      if (!entry) { drag = null; return; }
      S.selected = entry.op.layer.id;
      l = sel(S.doc);
    }
    if (drag) { drag.layerId = l.id; draw(); }
  } else if (tool === 'smudge' || tool === 'dodge' || tool === 'blur') {
    // Dodge/burn previews exactly (the merged image through GIMP's LUT); smudge and blur/sharpen show their path.
    const r = S.retouch, flip = (a, b, v) => (e.altKey ? (v === a ? b : a) : v);
    const kind = tool === 'dodge' ? flip('dodge', 'burn', r.dodge) : tool === 'blur' ? flip('blur', 'sharpen', S.focus.mode) : 'smudge';
    drag = { tool, kind, points: [[x, y]], offset: [0, 0], layerId: null };
    if (tool === 'dodge') {
      const snap = document.createElement('canvas');
      snap.width = S.doc.width; snap.height = S.doc.height;
      const sc = snap.getContext('2d', { willReadFrequently: true });
      render(sc, S.doc, env);
      const img = sc.getImageData(0, 0, snap.width, snap.height), d = img.data, lut = dodgeBurnLUT(kind, r.range, r.exposure);
      for (let i = 0; i < d.length; i += 4) { d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]]; }
      sc.putImageData(img, 0, 0);
      drag.snap = snap;
    }
    const d0 = drag;
    let l = sel(S.doc);
    if (!l || l.type !== 'paint') {
      const entry = await commit({ type: 'layer.add', layer: { type: 'paint', name: 'Retouch' } });
      if (!entry) { drag = null; return; }
      S.selected = entry.op.layer.id;
      l = sel(S.doc);
    }
    d0.layerId = l.id;
    draw();
  } else if (tool === 'scissors') {
    return scissorsAdd(x, y, e);
  } else if (tool === 'fgselect') {
    const fg = S.fg;
    if (!fg.outline && !fg.useSelection) drag = { tool: 'fgoutline', points: [[r1(x), r1(y)]] };
    else drag = { tool: 'fgpaint', points: [[r1(x), r1(y)]] };
    draw();
  } else if (tool === 'liquify') {
    const l = sel(S.doc);
    if (!l || ['group', 'adjustment'].includes(l.type)) return status('Select a layer to liquify', true);
    if (l.locks?.pixels) return status(`Layer "${l.name}" is locked (pixels)`, true);
    const inv = invert(layerMatrix(l, layerSize(l, ctx)));
    drag = { tool, id: l.id, inv, k: Math.sqrt(Math.abs(inv[0] * inv[3] - inv[1] * inv[2])), points: [[x, y]] };
    setPreview(liquifyOp(drag));
  } else if (tool === 'text') {
    e.preventDefault(); // keep the browser from moving focus (which would blur an editor we open now)
    if (textEdit) { await finishTextEdit(true); return; }
    const hit = hitTest(S.doc, ctx, env, x, y);
    if (hit?.type === 'text') { S.selected = hit.id; panels(); startTextEdit(hit); return; } // click existing text to edit it
    drag = { tool, x, y, x2: x, y2: y };                                                     // click: point text; drag: paragraph box
  } else if (SELECT_TOOLS.includes(tool) && selHandleHit(x, y)) {
    drag = { tool: 'selXform', ...selHandleHit(x, y), x, y, moved: false };
  } else if (OUTLINE_TOOLS.includes(tool) && !e.shiftKey && !e.altKey && insideSelection(S.doc, x, y)) {
    drag = { tool: 'moveSel', from: tool, x, y, moved: false }; // dragging inside the selection moves its outline
  } else if (tool === 'rect' || tool === 'ellipse' || tool === 'crop' || tool === 'rselect' || tool === 'eselect') {
    const [sx, sy] = snapPoint(x, y);
    drag = { tool, x: sx, y: sy, x2: sx, y2: sy, mode: selModeFor(e) };
  } else if (tool === 'lasso') {
    drag = { tool, points: [[r1(x), r1(y)]], mode: selModeFor(e) };
  } else if (tool === 'gradient') {
    drag = { tool, x, y, x2: x, y2: y };
  } else if (tool === 'wand') {
    const l = sel(S.doc);
    if (!S.wand.merged && !l) return status('Select a layer to sample, or turn on "Sample merged"', true);
    await commit({ type: 'selection.set', mode: selModeFor(e), shape: { type: 'wand', x: Math.floor(x), y: Math.floor(y),
      threshold: S.wand.threshold, contiguous: S.wand.contiguous, layer: S.wand.merged ? undefined : l.id } });
  } else if (tool === 'bucket') {
    const l = sel(S.doc);
    const entry = await commit({ type: 'edit.bucket', x: Math.floor(x), y: Math.floor(y), color: color(),
      threshold: S.wand.threshold, contiguous: S.wand.contiguous, sample: S.wand.merged || !l ? undefined : l.id });
    if (entry) { S.selected = entry.op.layer.id; panels(); draw(); }
  } else if (tool === 'picker') {
    render(ctx, S.doc, env); // repaint without overlays before sampling
    const [r, g, b] = ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data;
    $('#color').value = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
    status(`Picked ${$('#color').value}`);
    draw();
  }
});

canvas.addEventListener('pointermove', e => {
  if (S.tool === 'pen' && !drag) { S.pen.hover = docPoint(e); if (S.pen.draft) draw(); return; }
  if (S.tool === 'scissors' && !drag) { scissorsHover(...docPoint(e)); return; }
  if (S.tool === 'move' && !drag) { // cursor hints over the transform handles
    const th = transformHit(...docPoint(e));
    const gi = th ? -1 : guideAt(...docPoint(e));
    canvas.style.cursor = gi >= 0 ? (S.doc.guides[gi].axis === 'x' ? 'col-resize' : 'row-resize') : !th ? 'move' : th.kind === 'rotate' ? 'grab' : HANDLE_CURSORS[th.handle.name];
    return;
  }
  if (!drag) return;
  const [x, y] = docPoint(e);
  if (drag.tool === 'pen') return penMove(x, y, e);
  if (drag.mode === 'scale' || drag.mode === 'rotate') return moveTransform(drag, x, y, e);
  if (drag.mode === 'group') { drag.moved = true; return setPreview({ type: 'layer.move', id: drag.id, dx: Math.round(x - drag.x), dy: Math.round(y - drag.y) }); }
  if (drag.tool === 'fgoutline' || drag.tool === 'fgpaint') {
    const [lx, ly] = drag.points.at(-1);
    if (Math.hypot(x - lx, y - ly) < 2) return;
    drag.points.push([r1(x), r1(y)]);
    return draw();
  }
  if (drag.tool === 'liquify') {
    const [lx, ly] = drag.points.at(-1);
    if (Math.hypot(x - lx, y - ly) < 3) return;
    drag.points.push([x, y]);
    return setPreview(liquifyOp(drag));
  }
  if (drag.tool === 'mesh') {
    drag.moved = true;
    drag.mesh.points[drag.i] = apply(drag.inv, ...snapPoint(x, y)).map(r1);
    return setPreview({ type: 'layer.update', id: drag.id, props: { mesh: drag.mesh } });
  }
  if (drag.tool === 'selXform') {
    drag.moved = true;
    const t = selDragMatrix(drag, x, y, e);
    drag.result = t;
    return setPreview({ type: 'selection.transform', matrix: t.m, via: t.via });
  }
  if (drag.tool === 'moveSel') {
    drag.moved = true;
    return setPreview({ type: 'selection.translate', dx: Math.round(x - drag.x), dy: Math.round(y - drag.y) });
  }
  if (drag.tool === 'move') {
    drag.moved = true;
    const l = S.doc.layers.find(q => q.id === S.selected);
    const [nx, ny] = l ? snapLayerMove(l, drag.ox + x - drag.x, drag.oy + y - drag.y) : [drag.ox + x - drag.x, drag.oy + y - drag.y];
    previewUpdate({ x: Math.round(nx), y: Math.round(ny) });
  } else if (drag.tool === 'brush' || drag.tool === 'eraser') {
    const [lx, ly] = drag.points.at(-1);
    if (Math.hypot(x - lx, y - ly) < 1.5) return;
    drag.points.push(drag.special ? [x, y] : penPoint(e, x, y));
    if (drag.layerId || drag.special) setPreview(strokeOp());
  } else if (RETOUCH_TOOLS.includes(drag.tool)) {
    const [lx, ly] = drag.points.at(-1);
    if (Math.hypot(x - lx, y - ly) < 1.5) return;
    drag.points.push([x, y]);
    draw();
  } else if (drag.tool === 'text') {
    Object.assign(drag, { x2: x, y2: y });
    S.textBox = normRect(drag);
    draw();
  } else if (drag.tool === 'gradient') {
    Object.assign(drag, { x2: x, y2: y });
    setPreview({ type: 'layer.add', layer: { ...gradientLayer(drag, e.shiftKey), id: '__preview' } });
  } else if (drag.tool === 'lasso') {
    const [lx, ly] = drag.points.at(-1);
    if (Math.hypot(x - lx, y - ly) < 2) return;
    drag.points.push([r1(x), r1(y)]);
    if (drag.points.length >= 3) setPreview({ type: 'selection.set', mode: drag.mode, shape: { type: 'polygon', points: drag.points } });
  } else {
    const [sx, sy] = snapPoint(x, y);
    Object.assign(drag, { x2: sx, y2: sy });
    const rect = normRect(drag, e.shiftKey && !SELECT_TOOLS.includes(drag.tool));
    if (drag.tool === 'crop') { S.crop = { ...drag }; options(); draw(); }
    else if (drag.tool === 'rselect' || drag.tool === 'eselect') {
      setPreview({ type: 'selection.set', mode: drag.mode, shape: { type: drag.tool === 'rselect' ? 'rect' : 'ellipse', x: rect.x, y: rect.y, w: rect.w, h: rect.h } });
    }
    else setPreview({ type: 'layer.add', layer: { ...shapeLayer(drag.tool, rect), id: '__preview' } });
  }
});

canvas.addEventListener('dblclick', e => {
  if (S.tool !== 'move' && S.tool !== 'text') return;
  const hit = hitTest(S.doc, ctx, env, ...docPoint(e));
  if (hit?.type === 'text' && !hit.locks?.pixels) { S.selected = hit.id; setTool('text'); panels(); startTextEdit(hit); }
});

canvas.addEventListener('pointerup', async e => {
  const d = drag;
  if (!d) return;
  if (d.tool === 'text') {
    drag = null;
    const r = normRect(d);
    startTextEdit(newTextSpec(r.w > 10 ? r.x : d.x, r.w > 10 ? r.y : d.y, r.w > 10 ? r.w : 0), true);
    return;
  }
  if (d.tool === 'pen') { await penUp(); drag = null; return; }
  drag = null;
  if (d.mode === 'scale' || d.mode === 'rotate') return endTransform(d);
  if (d.mode === 'group') {
    const [x, y] = docPoint(e), dx = Math.round(x - d.x), dy = Math.round(y - d.y);
    if (d.moved && (dx || dy)) await commit({ type: 'layer.move', id: d.id, dx, dy }); else { S.preview = null; draw(); }
    return;
  }
  if (d.tool === 'liquify') { await commit(liquifyOp(d)); return; }
  if (d.tool === 'fgoutline') {
    if (d.points.length >= 3) { S.fg.outline = d.points; status('Now paint over the object (optional), then press Enter or click Select'); }
    options(); draw(); return;
  }
  if (d.tool === 'fgpaint') { S.fg.strokes.push({ points: d.points, size: S.size }); draw(); return; }
  if (d.tool === 'mesh') {
    if (d.moved) await commit({ type: 'layer.update', id: d.id, props: { mesh: d.mesh } });
    return;
  }
  if (d.tool === 'selXform') {
    if (d.moved && d.result) await commit({ type: 'selection.transform', matrix: d.result.m, via: d.result.via });
    else { S.preview = null; draw(); }
    return;
  }
  if (d.tool === 'moveSel') {
    const [x, y] = docPoint(e), dx = Math.round(x - d.x), dy = Math.round(y - d.y);
    if (d.moved && (dx || dy)) await commit({ type: 'selection.translate', dx, dy });
    else if (d.from === 'wand') await commit({ type: 'selection.set', mode: 'replace', shape: { type: 'wand', x: Math.floor(d.x), y: Math.floor(d.y), threshold: S.wand.threshold, contiguous: S.wand.contiguous } });
    else if (d.from === 'rselect' || d.from === 'eselect') await commit({ type: 'selection.none' }); // a click deselects, as before
    else { S.preview = null; draw(); }
    return;
  }
  if (d.tool === 'move') {
    const l = sel();
    if (d.moved && l) await update({ x: l.x, y: l.y });
  } else if (d.tool === 'brush' || d.tool === 'eraser') {
    drag = d; // strokeOp reads the finished gesture
    const op = (d.layerId || d.special) && strokeOp();
    drag = null;
    if (op) await commit(op);
  } else if (d.tool === 'clone' || d.tool === 'heal') {
    if (!d.layerId) return draw();
    if (d.tool === 'heal') status('Healing…');
    const c = S.clone;
    await commit({ type: `paint.${d.tool}`, id: d.layerId, points: d.points.map(p => p.map(r1)), offset: d.offset,
      size: S.size, hardness: c.hardness, sample: c.sampleLayer ?? 'merged' });
    draw();
  } else if (d.tool === 'smudge' || d.tool === 'dodge' || d.tool === 'blur') {
    if (!d.layerId) return draw();
    const r = S.retouch, base = { id: d.layerId, points: d.points.map(p => p.map(r1)), size: S.size, hardness: S.clone.hardness };
    if (d.tool === 'smudge') status('Smudging…');
    await commit(d.tool === 'smudge' ? { type: 'paint.smudge', ...base, rate: r.rate, flow: r.flow, color: color() }
      : d.tool === 'blur' ? { type: `paint.${d.kind}`, ...base, strength: d.kind === 'blur' ? S.focus.strength : S.focus.sharpen ?? 50 }
      : { type: `paint.${d.kind}`, ...base, range: r.range, exposure: r.exposure });
    draw();
  } else if (d.tool === 'rselect' || d.tool === 'eselect') {
    const r = normRect(d);
    if (r.w > 1 && r.h > 1) await commit({ type: 'selection.set', mode: d.mode, shape: { type: d.tool === 'rselect' ? 'rect' : 'ellipse', x: r.x, y: r.y, w: r.w, h: r.h } });
    else if (S.doc.selection && d.mode === 'replace') await commit({ type: 'selection.none' }); // click without drag deselects
    else { S.preview = null; draw(); }
  } else if (d.tool === 'gradient') {
    const g = gradientLayer(d, e.shiftKey);
    S.preview = null;
    if (Math.hypot(g.x2 - g.x1, g.y2 - g.y1) > 2) {
      const entry = await commit({ type: 'edit.gradient', kind: g.kind, x1: g.x1, y1: g.y1, x2: g.x2, y2: g.y2, from: g.stops[0][1], to: g.stops[1][1] });
      if (entry) S.selected = entry.op.layer.id;
    }
    draw(); panels();
  } else if (d.tool === 'lasso') {
    if (d.points.length >= 3) await commit({ type: 'selection.set', mode: d.mode, shape: { type: 'polygon', points: d.points } });
    else { S.preview = null; draw(); }
  } else if (d.tool === 'crop') {
    const c = normRect(d);
    S.crop = c.w > 2 && c.h > 2 ? { ...d } : null;
    options(); draw();
  } else {
    const rect = normRect(d, e.shiftKey);
    S.preview = null;
    if (rect.w > 2 && rect.h > 2) {
      const entry = await commit({ type: 'layer.add', layer: shapeLayer(d.tool, rect) });
      if (entry) S.selected = entry.op.layer.id;
    }
    draw(); panels();
  }
});

async function applyCrop() {
  if (!S.crop) return;
  const c = normRect(S.crop);
  S.crop = null;
  await commit({ type: 'canvas.crop', x: c.x, y: c.y, width: c.w, height: c.h });
  options();
}

// ---- Tools & options bar ------------------------------------------------------------------

function setTool(t) {
  if (S.pen.draft && t !== 'pen') finishPen();
  if (t !== 'move' && S.meshEdit) { S.meshEdit = null; S.preview = null; }
  if (t !== 'scissors') S.sc = { anchors: [], segs: [], hover: null };
  if (t !== 'fgselect') S.fg = { outline: null, strokes: [], useSelection: false };
  if (textEdit && t !== 'text') finishTextEdit(true);
  S.tool = t;
  if (t !== 'crop') S.crop = null;
  document.querySelectorAll('#tools [data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
  canvas.style.cursor = { move: 'move', text: 'text', picker: 'copy', bucket: 'cell' }[t] || 'crosshair';
  options(); draw();
}

function setZoom(z) {
  S.zoom = Math.max(0.05, Math.min(16, z));
  draw(); options();
}

function fitZoom() {
  const v = $('#viewport').getBoundingClientRect(), d = cur();
  if (d) setZoom(Math.min((v.width - 80) / d.width, (v.height - 80) / d.height, 1));
}

function options() {
  const bar = $('#options');
  bar.replaceChildren();
  const t = S.tool;
  if (t === 'brush' || t === 'eraser') {
    const out = el('output', {}, `${S.size}px`);
    bar.append(el('label', {}, 'Size', el('input', { type: 'range', min: 1, max: 200, value: S.size, oninput: e => { S.size = Number(e.target.value); out.textContent = `${S.size}px`; } }), out));
    bar.append(el('label', {}, 'Hardness', el('input', { type: 'range', min: 0, max: 1, step: 0.05, value: S.hardness, oninput: e => (S.hardness = Number(e.target.value)) })));
    const op = el('output', {}, `${Math.round(S.brush.opacity * 100)}%`);
    bar.append(el('label', {}, 'Opacity', el('input', { type: 'range', min: 0.05, max: 1, step: 0.05, value: S.brush.opacity, oninput: e => { S.brush.opacity = Number(e.target.value); op.textContent = `${Math.round(S.brush.opacity * 100)}%`; } }), op));
    if (t === 'brush') bar.append(el('label', {}, 'Mode', el('select', { onchange: e => (S.brush.blend = e.target.value) }, BLEND_MODES.map(m => el('option', { value: m, selected: m === S.brush.blend }, m)))));
    bar.append(el('label', { title: 'Width follows pen pressure (graphics tablet / stylus)' }, el('input', { type: 'checkbox', checked: S.brush.pressure, onchange: e => (S.brush.pressure = e.target.checked) }), ' Pressure'));
    const masked = S.maskEdit && S.doc.layers.find(q => q.id === S.maskEdit);
    if (S.quickMask) bar.append(el('span', { class: 'mode-pill' }, 'Quick mask'), el('span', { class: 'muted' }, 'Light color adds to the selection, dark removes. Q to finish.'));
    else if (masked) bar.append(el('span', { class: 'mode-pill' }, `Mask of "${masked.name}"`), el('span', { class: 'muted' }, t === 'brush' ? 'Dark color hides, light reveals (X swaps colors).' : 'Erasing the mask reveals.'),
      el('button', { onclick: () => { S.maskEdit = null; options(); propsPanel(true); } }, 'Done'));
    else bar.append(el('span', { class: 'muted' }, t === 'brush' ? 'Paints on the selected paint layer (a new one is created if needed). [ and ] change size.' : 'Erases on the selected paint layer.'));
  } else if (t === 'clone' || t === 'heal') {
    const c = S.clone, out = el('output', {}, `${S.size}px`);
    bar.append(el('label', {}, 'Size', el('input', { type: 'range', min: 1, max: 200, value: S.size, oninput: e => { S.size = Number(e.target.value); out.textContent = `${S.size}px`; draw(); } }), out));
    bar.append(el('label', {}, 'Hardness', el('input', { type: 'range', min: 0, max: 1, step: 0.05, value: c.hardness, oninput: e => (c.hardness = Number(e.target.value)) })));
    bar.append(el('label', {}, el('input', { type: 'checkbox', checked: c.aligned, onchange: e => { c.aligned = e.target.checked; c.offset = null; } }), ' Aligned'));
    bar.append(el('label', {}, el('input', { type: 'checkbox', checked: c.merged, onchange: e => { c.merged = e.target.checked; c.source = null; c.offset = null; options(); draw(); } }), ' Sample merged'));
    bar.append(el('span', { class: 'muted' }, c.source
      ? `Source (${c.source[0]}, ${c.source[1]})${c.sampleLayer ? ` on "${S.doc.layers.find(l => l.id === c.sampleLayer)?.name}"` : ''}. ${t === 'heal' ? 'Paint over a flaw to blend the source into it.' : 'Paint to copy from the source.'}`
      : 'Alt-click (or Ctrl-click) to set the source.'));
  } else if (t === 'pen') {
    const p = activePath();
    if (S.pen.draft) bar.append(el('span', { class: 'muted' }, 'Click: corner · drag: curve · click the first point: close · Enter: finish · Esc: cancel · Backspace: undo point'));
    else {
      bar.append(el('span', { class: 'muted' }, p ? `Path "${p.name}": drag points or handles to reshape (Alt: break handle symmetry).` : 'Click to start a path. Pick an existing one in the Paths panel to edit it.'));
      if (p) bar.append(
        el('button', { onclick: () => pathCommand('select') }, 'To selection'),
        el('button', { onclick: () => pathCommand('stroke'), title: `Foreground color, ${S.size}px` }, 'Stroke'),
        el('button', { onclick: () => pathCommand('fill') }, 'Fill'),
        el('button', { onclick: () => { S.pen.active = null; options(); panels(); draw(); } }, 'Deselect'));
    }
  } else if (t === 'smudge' || t === 'dodge' || t === 'blur') {
    const r = S.retouch, out = el('output', {}, `${S.size}px`);
    const range = (label, min, max, key, step = 1) => el('label', {}, label, el('input', { type: 'range', min, max, step, value: r[key], oninput: e => (r[key] = Number(e.target.value)) }));
    bar.append(el('label', {}, 'Size', el('input', { type: 'range', min: 1, max: 200, value: S.size, oninput: e => { S.size = Number(e.target.value); out.textContent = `${S.size}px`; } }), out));
    bar.append(el('label', {}, 'Hardness', el('input', { type: 'range', min: 0, max: 1, step: 0.05, value: S.clone.hardness, oninput: e => (S.clone.hardness = Number(e.target.value)) })));
    if (t === 'blur') {
      const f = S.focus;
      bar.append(el('div', { class: 'seg' }, ['blur', 'sharpen'].map(k => el('button', { class: f.mode === k ? 'on' : '', onclick: () => { f.mode = k; options(); } }, k[0].toUpperCase() + k.slice(1)))));
      bar.append(f.mode === 'blur'
        ? el('label', {}, 'Radius', el('input', { type: 'range', min: 1, max: 30, value: f.strength, oninput: e => (f.strength = Number(e.target.value)) }))
        : el('label', {}, 'Strength', el('input', { type: 'range', min: 1, max: 100, value: f.sharpen ?? 50, oninput: e => (f.sharpen = Number(e.target.value)) })));
      bar.append(el('span', { class: 'muted' }, 'Alt while painting switches blur ↔ sharpen.'));
    } else if (t === 'smudge') {
      bar.append(range('Rate', 0, 100, 'rate'), range('Flow', 0, 100, 'flow'));
      bar.append(el('span', { class: 'muted' }, 'Rate: how far colors are dragged. Flow mixes in the foreground color.'));
    } else {
      bar.append(el('div', { class: 'seg' }, ['dodge', 'burn'].map(k => el('button', { class: r.dodge === k ? 'on' : '', onclick: () => { r.dodge = k; options(); } }, k[0].toUpperCase() + k.slice(1)))));
      bar.append(el('label', {}, 'Range', el('select', { onchange: e => (r.range = e.target.value) }, DODGE_RANGES.map(k => el('option', { value: k, selected: k === r.range }, k)))));
      bar.append(range('Exposure', 0, 100, 'exposure'));
      bar.append(el('span', { class: 'muted' }, 'Alt while painting switches dodge ↔ burn.'));
    }
  } else if (t === 'text') {
    bar.append(el('label', {}, 'Size', el('input', { type: 'number', min: 4, value: S.fontSize, style: 'width:60px', onchange: e => (S.fontSize = Number(e.target.value)) })));
    bar.append(el('label', {}, 'Font', fontSelect(S.font, f => (S.font = f))));
    bar.append(el('div', { class: 'seg' },
      el('button', { class: S.text.bold ? 'on' : '', style: 'font-weight:700', onclick: () => { S.text.bold = !S.text.bold; options(); } }, 'B'),
      el('button', { class: S.text.italic ? 'on' : '', style: 'font-style:italic', onclick: () => { S.text.italic = !S.text.italic; options(); } }, 'I')));
    if ('queryLocalFonts' in window) bar.append(el('button', { onclick: loadLocalFonts, title: 'List the fonts installed on this computer (Chrome asks for permission)' }, 'Installed fonts…'));
    bar.append(el('span', { class: 'muted' }, 'Click to type, drag for a paragraph box, click text to edit it.'));
  } else if (t === 'rect' || t === 'ellipse') {
    bar.append(el('span', { class: 'muted' }, 'Drag to draw, Shift for square/circle. Uses the foreground color.'));
  } else if (t === 'crop') {
    if (S.crop) {
      const c = normRect(S.crop);
      bar.append(el('span', {}, `${c.w} × ${c.h} at (${c.x}, ${c.y})`),
        el('button', { onclick: applyCrop }, 'Crop (Enter)'), el('button', { onclick: () => { S.crop = null; options(); draw(); } }, 'Cancel (Esc)'));
    } else bar.append(el('span', { class: 'muted' }, 'Drag a rectangle to crop the canvas.'));
  } else if (t === 'gradient') {
    bar.append(
      el('label', {}, 'Shape', el('select', { onchange: e => (S.gradKind = e.target.value) },
        ['linear', 'radial'].map(k => el('option', { value: k, selected: k === S.gradKind }, k)))),
      el('label', {}, 'Ends with', el('select', { onchange: e => (S.gradEnd = e.target.value) },
        [['background', 'background color'], ['transparent', 'transparent']].map(([v, n]) => el('option', { value: v, selected: v === S.gradEnd }, n)))),
      el('span', { class: 'muted' }, 'Drag from start to end (Shift snaps to 15°). Creates a gradient layer, limited to the selection.'));
  } else if (SELECT_TOOLS.includes(t) || t === 'bucket') {
    if (t !== 'bucket') {
      bar.append(el('span', { class: 'seg' }, SELECTION_MODES.map(m => el('button', { class: S.selMode === m ? 'on' : '', title: m,
        onclick: () => { S.selMode = m; options(); } }, m[0].toUpperCase() + m.slice(1)))));
      bar.append(el('button', { class: S.selXform ? 'on' : '', disabled: !S.doc?.selection, title: 'Handles around the selection: corners scale (Shift: keep proportions), the knob rotates',
        onclick: () => { S.selXform = !S.selXform; options(); draw(); } }, 'Transform outline'));
      if (t === 'scissors') bar.append(el('span', { class: 'muted' }, S.sc.anchors.length
        ? `${S.sc.anchors.length} points — click the first point or press Enter to finish · Backspace removes a point · Esc cancels`
        : 'Click points around the object; the outline snaps to edges between them.'));
      if (t === 'fgselect') {
        const fg = S.fg;
        if (!fg.outline && !fg.useSelection) bar.append(el('span', { class: 'muted' }, 'Drag a rough outline around the object'),
          el('button', { disabled: !S.doc?.selection, onclick: () => { fg.useSelection = true; options(); } }, 'Use current selection'));
        else {
          const out = el('output', {}, `${S.size}px`);
          bar.append(el('span', { class: 'muted' }, 'Paint over the object (optional)'),
            el('label', {}, 'Brush', el('input', { type: 'range', min: 3, max: 120, value: S.size, oninput: e => { S.size = Number(e.target.value); out.textContent = `${S.size}px`; } }), out),
            el('button', { class: 'on', onclick: fgFinish }, 'Select'),
            el('button', { onclick: () => { S.fg = { outline: null, strokes: [], useSelection: false }; options(); draw(); } }, 'Start over'));
        }
      }
    }
    if (t === 'wand' || t === 'bucket') {
      const out = el('output', {}, String(S.wand.threshold));
      bar.append(
        el('label', {}, 'Threshold', el('input', { type: 'range', min: 0, max: 255, value: S.wand.threshold,
          oninput: e => { S.wand.threshold = Number(e.target.value); out.textContent = e.target.value; } }), out),
        el('label', {}, el('input', { type: 'checkbox', checked: S.wand.contiguous, onchange: e => (S.wand.contiguous = e.target.checked) }), 'Contiguous'),
        el('label', {}, el('input', { type: 'checkbox', checked: S.wand.merged, onchange: e => (S.wand.merged = e.target.checked) }), 'Sample merged'));
    }
    bar.append(el('span', { class: 'muted' }, t === 'bucket' ? 'Click to fill similar colors (inside the selection, if any) with the foreground color.'
      : `Shift = add, Alt = subtract, Shift+Alt = intersect. Selection: ${selectionText(S.doc?.selection)}`));
  } else if (t === 'liquify') {
    const out = el('output', {}, `${S.size}px`);
    bar.append(el('div', { class: 'seg' }, ['push', 'twirl', 'bloat', 'pinch'].map(m => el('button', { class: LIQUIFY.mode === m ? 'on' : '', onclick: () => { LIQUIFY.mode = m; options(); } }, m[0].toUpperCase() + m.slice(1)))),
      el('label', {}, 'Size', el('input', { type: 'range', min: 5, max: 400, value: S.size, oninput: e => { S.size = Number(e.target.value); out.textContent = `${S.size}px`; } }), out),
      el('label', {}, 'Strength', el('input', { type: 'range', min: 0.05, max: 1, step: 0.05, value: LIQUIFY.strength, oninput: e => (LIQUIFY.strength = Number(e.target.value)) })),
      el('button', { disabled: !sel(S.doc)?.liquify, onclick: () => update({ liquify: null }) }, 'Reset liquify'),
      el('span', { class: 'muted' }, 'Drag over the selected layer. Every stroke can be undone; Reset removes them all.'));
  } else if (t === 'move') {
    const l = sel(S.doc), meshable = l && !['group', 'adjustment'].includes(l.type) && !l.locks?.position;
    if (S.meshEdit && meshable) {
      bar.append(el('span', { class: 'mode-pill' }, S.meshEdit.kind === 'perspective' ? 'Perspective' : 'Warp'),
        el('span', { class: 'muted' }, S.meshEdit.kind === 'perspective' ? 'Drag the corners.' : 'Drag the grid points.'));
      if (S.meshEdit.kind === 'warp') bar.append(el('label', {}, 'Grid', el('select', { onchange: e => { const [c, r] = e.target.value.split('x').map(Number); startMeshEdit('warp', c, r, true); } },
        ['2x2', '3x3', '4x4', '5x5', '3x2', '4x3'].map(g => el('option', { value: g, selected: g === `${S.meshEdit.cols}x${S.meshEdit.rows}` }, g)))));
      bar.append(el('button', { onclick: () => { update({ mesh: null }); S.meshEdit = null; options(); } }, 'Reset'),
        el('button', { onclick: () => { S.meshEdit = null; S.preview = null; options(); draw(); } }, 'Done'));
    } else {
      bar.append(el('span', { class: 'muted' }, 'Click a layer to select it, drag to move. Arrow keys nudge (Shift = 10px).'));
      if (meshable) bar.append(el('button', { onclick: () => startMeshEdit('perspective') }, 'Perspective'), el('button', { onclick: () => startMeshEdit('warp') }, 'Warp'));
    }
  } else if (t === 'picker') {
    bar.append(el('span', { class: 'muted' }, 'Click to pick a color from the image.'));
  }
  bar.append(el('span', { style: 'margin-left:auto' }),
    el('button', { onclick: () => setZoom(S.zoom / 1.25) }, '−'),
    el('span', { style: 'width:44px;text-align:center' }, `${Math.round(S.zoom * 100)}%`),
    el('button', { onclick: () => setZoom(S.zoom * 1.25) }, '+'),
    el('button', { onclick: fitZoom }, 'Fit'),
    el('button', { onclick: () => setZoom(1) }, '100%'));
}

// ---- Panels -------------------------------------------------------------------------------

function field(label, input, out) {
  return el('label', { class: 'field' }, el('span', {}, label), input, out || el('span'));
}

function num(label, value, onCommit, step = 1) {
  return field(label, el('input', { type: 'number', value: r1(value), step, onchange: e => onCommit(Number(e.target.value)) }));
}

function slider(label, { min, max, step = 1, value, fmt, onPreview, onCommit }) {
  const out = el('output', {}, fmt(value));
  const input = el('input', { type: 'range', min, max, step, value,
    oninput: e => { out.textContent = fmt(Number(e.target.value)); onPreview(Number(e.target.value)); },
    onchange: e => onCommit(Number(e.target.value)) });
  return field(label, input, out);
}

function colorField(label, value, key) {
  return field(label, el('input', { type: 'color', value: value || '#000000',
    oninput: e => previewUpdate({ [key]: e.target.value }), onchange: e => update({ [key]: e.target.value }) }));
}

function text(label, value, key, multiline = false) {
  return field(label, el(multiline ? 'textarea' : 'input', { value, onchange: e => update({ [key]: e.target.value }) }));
}

function choice(label, value, values, onCommit) {
  return field(label, el('select', { onchange: e => onCommit(e.target.value) }, values.map(v => el('option', { value: v, selected: v === value }, v))));
}

const ADJUST_RANGES = { brightness: [0, 200], contrast: [0, 200], saturate: [0, 300], hue: [-180, 180], blur: [0, 50], grayscale: [0, 100], sepia: [0, 100], invert: [0, 100] };

function propsPanel(force = false) {
  const box = $('#props');
  const typing = document.activeElement?.matches?.('input[type=text], input[type=number], input:not([type]), textarea');
  if (!force && typing && box.contains(document.activeElement)) return; // don't clobber what the user is typing
  const scroll = box.parentElement.scrollTop;
  requestAnimationFrame(() => { box.parentElement.scrollTop = scroll; });
  box.replaceChildren();
  const d = S.doc, l = sel(d);
  if (!l) {
    box.append(el('div', { class: 'muted' }, 'Canvas (no layer selected)'),
      num('Width', d.width, v => commit({ type: 'canvas.resize', width: v, height: d.height })),
      num('Height', d.height, v => commit({ type: 'canvas.resize', width: d.width, height: v })),
      field('Background', el('input', { type: 'color', value: d.background || '#ffffff', onchange: e => commit({ type: 'canvas.background', color: e.target.value }) }),
        el('button', { onclick: () => commit({ type: 'canvas.background', color: null }) }, 'None')));
    return;
  }
  if (l.type === 'adjustment') {
    box.append(text('Name', l.name, 'name'),
      slider('Opacity', { min: 0, max: 100, value: Math.round(l.opacity * 100), fmt: v => `${v}%`, onPreview: v => previewUpdate({ opacity: v / 100 }), onCommit: v => update({ opacity: v / 100 }) }),
      choice('Mode', l.blend, BLEND_MODES, v => update({ blend: v })),
      ...structureFields(l),
      el('div', { class: 'group' }, 'Adjustment layer — affects every layer below it (clip it to affect just one). Add a mask from a selection to limit where.'));
    box.append(el('div', { class: 'group' }, 'Colors & filters'));
    for (const [k, [min, max]] of Object.entries(ADJUST_RANGES)) {
      box.append(slider(k, { min, max, value: l.adjust[k], fmt: v => `${v}${ADJUST_UNITS[k]}`,
        onPreview: v => previewUpdate({ adjust: { [k]: v } }), onCommit: v => update({ adjust: { [k]: v } }) }));
    }
    box.append(...toneSections(l));
    return;
  }
  if (l.type === 'group') {
    const n = d.layers.filter(x => x.parent === l.id).length;
    box.append(text('Name', l.name, 'name'),
      slider('Opacity', { min: 0, max: 100, value: Math.round(l.opacity * 100), fmt: v => `${v}%`, onPreview: v => previewUpdate({ opacity: v / 100 }), onCommit: v => update({ opacity: v / 100 }) }),
      choice('Mode', l.blend, BLEND_MODES, v => update({ blend: v })),
      el('div', { class: 'group' }, `Group · ${n} layer${n === 1 ? '' : 's'} (Move tool drags the whole group)`),
      ...structureFields(l),
      el('div', { class: 'row' }, el('button', { onclick: () => run('ungroup') }, 'Ungroup')));
    return;
  }
  box.append(
    text('Name', l.name, 'name'),
    num('X', l.x, v => update({ x: v })), num('Y', l.y, v => update({ y: v })),
    num('Rotation°', l.rotation, v => update({ rotation: v })),
    num('Scale X %', l.scaleX * 100, v => update({ scaleX: v / 100 })), num('Scale Y %', l.scaleY * 100, v => update({ scaleY: v / 100 })),
    slider('Opacity', { min: 0, max: 100, value: Math.round(l.opacity * 100), fmt: v => `${v}%`, onPreview: v => previewUpdate({ opacity: v / 100 }), onCommit: v => update({ opacity: v / 100 }) }),
    choice('Mode', l.blend, BLEND_MODES, v => update({ blend: v })),
    ...structureFields(l),
  );
  if (l.type === 'text') box.append(el('div', { class: 'group' }, 'Text'),
    text('Text', l.text, 'text', true),
    el('div', { class: 'row' }, el('button', { onclick: () => { setTool('text'); startTextEdit(l); } }, 'Edit on canvas')),
    num('Size', l.size, v => update({ size: v })), colorField('Color', l.color, 'color'),
    field('Font', fontSelect(l.font, f => update({ font: f }))),
    choice('Weight', l.weight, ['normal', 'bold', '300', '600', '900'], v => update({ weight: v })),
    field('Italic', el('input', { type: 'checkbox', checked: !!l.italic, onchange: e => update({ italic: e.target.checked }) })),
    choice('Align', l.align, ['left', 'center', 'right'], v => update({ align: v })),
    ...(l.path
      ? [slider('Path offset', { min: -200, max: 1000, value: l.path.offset ?? 0, fmt: v => `${v}px`, onPreview: v => previewUpdate({ path: { offset: v } }), onCommit: v => update({ path: { offset: v } }) }),
        el('div', { class: 'row' }, el('button', { onclick: () => update({ path: null }) }, 'Remove from path'))]
      : [el('div', { class: 'row' }, el('button', { disabled: !activePath(), title: activePath() ? `Follow path "${activePath().name}"` : 'Pick a path in the Paths panel first',
          onclick: () => commit({ type: 'text.onPath', id: l.id, path: S.pen.active }) }, activePath() ? `Put on path "${activePath().name}"` : 'Put on path (pick a path first)'))]),
    num('Box width', l.boxWidth || 0, v => update({ boxWidth: v > 0 ? v : null })),
    num('Line height', l.lineHeight ?? LINE_HEIGHT, v => update({ lineHeight: v > 0 ? v : null }), 0.05));
  if (l.type === 'shape') box.append(el('div', { class: 'group' }, 'Shape'),
    choice('Shape', l.shape, ['rect', 'ellipse'], v => update({ shape: v })),
    num('Width', l.w, v => update({ w: v })), num('Height', l.h, v => update({ h: v })),
    field('Fill', el('input', { type: 'color', value: l.fill || '#000000', oninput: e => previewUpdate({ fill: e.target.value }), onchange: e => update({ fill: e.target.value }) }),
      el('button', { onclick: () => update({ fill: null }) }, 'None')),
    colorField('Stroke', l.stroke, 'stroke'), num('Stroke px', l.strokeWidth, v => update({ strokeWidth: v })),
    num('Corner radius', l.radius, v => update({ radius: v })));
  if (l.type === 'image') box.append(el('div', { class: 'group' }, `Image ${l.w}×${l.h}`),
    el('div', { class: 'row' }, el('button', { onclick: () => run('fit') }, 'Fit to canvas'), el('button', { onclick: () => update({ scaleX: 1, scaleY: 1 }) }, 'Actual size')));
  if (l.type === 'paint') box.append(el('div', { class: 'group' }, `Paint layer · ${l.strokes.length} strokes`));
  if (l.type === 'fill') box.append(el('div', { class: 'group' }, 'Fill'), colorField('Color', l.color, 'color'));
  box.append(...[el('div', { class: 'group' }, 'Layer mask'),
    l.mask?.length ? el('div', { class: 'muted' }, l.mask.map(m => (m.stroke ? `${m.mode}: painted stroke` : `${m.mode}: ${selectionText(m.sel)}`)).join('; ')) : null,
    el('div', { class: 'row' },
      el('button', { class: S.maskEdit === l.id ? 'on' : '', title: 'Brush paints this layer\'s mask: dark hides, light reveals; the eraser reveals',
        onclick: () => { S.maskEdit = S.maskEdit === l.id ? null : l.id; if (S.maskEdit) { S.quickMask = false; setTool('brush'); } propsPanel(true); options(); } },
        S.maskEdit === l.id ? 'Painting mask…' : 'Paint mask'),
      l.mask?.length ? el('button', { onclick: () => run('unmask') }, 'Remove mask') : null)].filter(Boolean));

  if (l.type === 'gradient') {
    const [[, from], [, to]] = l.stops;
    const setStops = (a, b) => update({ stops: [[0, a], [1, b]] });
    box.append(el('div', { class: 'group' }, 'Gradient'),
      choice('Shape', l.kind, ['linear', 'radial'], v => update({ kind: v })),
      field('Start color', el('input', { type: 'color', value: from === 'transparent' ? '#000000' : from, onchange: e => setStops(e.target.value, to) }),
        el('button', { onclick: () => setStops('transparent', to), title: 'Make transparent' }, '∅')),
      field('End color', el('input', { type: 'color', value: to === 'transparent' ? '#ffffff' : to, onchange: e => setStops(from, e.target.value) }),
        el('button', { onclick: () => setStops(from, 'transparent'), title: 'Make transparent' }, '∅')),
      num('Start X', l.x1, v => update({ x1: v })), num('Start Y', l.y1, v => update({ y1: v })),
      num('End X', l.x2, v => update({ x2: v })), num('End Y', l.y2, v => update({ y2: v })),
      el('div', { class: 'row' }, el('button', { onclick: () => setStops(to, from) }, 'Reverse colors')));
  }

  box.append(el('div', { class: 'group' }, 'Colors & filters'));
  for (const [k, [min, max]] of Object.entries(ADJUST_RANGES)) {
    box.append(slider(k, { min, max, value: l.adjust[k], fmt: v => `${v}${ADJUST_UNITS[k]}`,
      onPreview: v => previewUpdate({ adjust: { [k]: v } }), onCommit: v => update({ adjust: { [k]: v } }) }));
  }
  box.append(...toneSections(l));
}

// Clipping and locks (shown for every layer type).
function structureFields(l) {
  const LOCKS = { position: 'Position', pixels: 'Pixels', alpha: 'Alpha' };
  const TIPS = { position: 'No moving or transforming', pixels: 'No painting or clearing', alpha: 'Paint only where there are pixels already' };
  return [
    field('Clip', el('label', {}, el('input', { type: 'checkbox', checked: !!l.clip, onchange: e => update({ clip: e.target.checked }) }), ' to layer below')),
    field('Lock', el('div', { class: 'seg' }, Object.entries(LOCKS).map(([k, label]) => el('button', { class: l.locks?.[k] ? 'on' : '', title: TIPS[k],
      onclick: () => update({ locks: { [k]: !l.locks?.[k] } }) }, label)))),
  ];
}

function lockIcon() {
  const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '12'); svg.setAttribute('height', '12');
  svg.innerHTML = '<rect x="5" y="11" width="14" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 11V7a4 4 0 018 0v4" fill="none" stroke="currentColor" stroke-width="2"/>';
  return svg;
}

function eyeIcon() {
  const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '16'); svg.setAttribute('height', '16');
  svg.innerHTML = '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3" fill="currentColor"/>';
  return svg;
}

// Histogram of a layer before its own tone adjustments (what GIMP's Levels/Curves dialogs show).
// Histogram of a layer before its own tone adjustments; cached until the layer's pixels change.
const histCache = new Map();
function layerHistogram(l) {
  const d = S.doc, raw = { ...withoutTone(l), opacity: 1, blend: 'normal', visible: true };
  const key = (l.type === 'adjustment' ? `adj:${S.entries.length}:` : '') + `${d.width}x${d.height}:${env.epoch}:` + JSON.stringify(raw, (k, v) => (k === 'strokes' ? `${v.length}:${v.at(-1)?.points?.length}` : k === 'name' ? undefined : v));
  const hit = histCache.get(l.id);
  if (hit?.key === key) return hit.hist;
  const c = env.makeCanvas(d.width, d.height), x = c.getContext('2d', { willReadFrequently: true });
  if (l.type === 'adjustment') { const order = paintOrder(d); render(x, d, env, { only: order.slice(0, order.findIndex(q => q.id === l.id)).map(q => q.id) }); }
  else drawLayer(x, raw, env, d);
  const hist = histogram(x.getImageData(0, 0, d.width, d.height));
  if (histCache.size > 20) histCache.clear();
  histCache.set(l.id, { key, hist });
  return hist;
}

// Theme colors for the histogram / curve canvases (style.css :root variables).
const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const chColor = ch => (ch === 'value' ? cssVar('--curve') : CHANNEL_COLORS[ch]);

function drawHistogram(x, hist, w, h, fill) {
  let max = 1;
  for (let v = 0; v < 256; v++) max = Math.max(max, Math.sqrt(hist[v]));
  x.fillStyle = fill;
  for (let v = 0; v < 256; v++) { const bh = (Math.sqrt(hist[v]) / max) * h; x.fillRect((v * w) / 256, h - bh, Math.ceil(w / 256), bh); }
}

function toneSections(l) {
  const ch = S.toneChannel, hist = layerHistogram(l);
  const channelPicker = () => field('Channel', el('select', { onchange: e => { S.toneChannel = e.target.value; propsPanel(true); } },
    TONE_CHANNELS.map(c => el('option', { value: c, selected: c === ch }, c === 'value' ? 'Value (all)' : { r: 'Red', g: 'Green', b: 'Blue' }[c]))));

  // Levels
  const lv = { ...LEVELS_DEFAULT, ...(l.levels?.[ch] || {}) };
  const hc = el('canvas', { width: 256, height: 60 }), hx = hc.getContext('2d');
  const paintLevels = v => {
    hx.clearRect(0, 0, 256, 60);
    drawHistogram(hx, hist[ch], 256, 60, cssVar('--hist'));
    hx.fillStyle = chColor(ch);
    for (const at of [v.inLow, v.inLow + (v.inHigh - v.inLow) * Math.pow(0.5, v.gamma), v.inHigh]) hx.fillRect(at - 1, 0, 2, 60);
  };
  paintLevels(lv);
  const lvSlider = (label, key, min, max, step = 1) => slider(label, { min, max, step, value: lv[key], fmt: v => (key === 'gamma' ? v.toFixed(2) : String(v)),
    onPreview: v => { paintLevels({ ...lv, [key]: v }); previewUpdate({ levels: { [ch]: { ...lv, [key]: v } } }); },
    onCommit: v => update({ levels: { [ch]: { ...lv, [key]: v } } }) });

  // Curves
  const cc = el('canvas', { width: 256, height: 256 }), cx = cc.getContext('2d');
  let pts = (l.curves?.[ch] || CURVE_PRESETS.linear).map(p => [...p]), dragging = null;
  const paintCurve = () => {
    cx.clearRect(0, 0, 256, 256);
    drawHistogram(cx, hist[ch], 256, 256, cssVar('--hist-dim'));
    cx.strokeStyle = cssVar('--grid'); cx.lineWidth = 1;
    for (let g = 64; g < 256; g += 64) { cx.beginPath(); cx.moveTo(g + 0.5, 0); cx.lineTo(g + 0.5, 256); cx.moveTo(0, g + 0.5); cx.lineTo(256, g + 0.5); cx.stroke(); }
    cx.beginPath(); cx.moveTo(0, 256); cx.lineTo(256, 0); cx.stroke();
    const f = curveFn(pts);
    cx.strokeStyle = chColor(ch); cx.lineWidth = 2; cx.beginPath();
    for (let v = 0; v < 256; v++) (v ? cx.lineTo : cx.moveTo).call(cx, v, 255 - Math.min(255, Math.max(0, f(v))));
    cx.stroke();
    cx.fillStyle = cssVar('--curve');
    for (const [px, py] of pts) cx.fillRect(px - 3, 252 - py, 7, 7);
  };
  paintCurve();
  const toCurve = e => {
    const r = cc.getBoundingClientRect(), k = v => Math.round(Math.min(255, Math.max(0, v)));
    return [k(((e.clientX - r.left) * 256) / r.width), k(255 - ((e.clientY - r.top) * 256) / r.height)];
  };
  const commitCurve = () => update({ curves: { [ch]: pts.map(p => p.map(Math.round)) } });
  cc.addEventListener('pointerdown', e => {
    cc.setPointerCapture(e.pointerId);
    const [px, py] = toCurve(e);
    dragging = pts.find(p => Math.hypot(p[0] - px, p[1] - py) < 12);
    if (!dragging) { dragging = [px, Math.round(curveFn(pts)(px))]; pts.push(dragging); pts.sort((a, b) => a[0] - b[0]); }
    paintCurve();
  });
  cc.addEventListener('pointermove', e => {
    if (!dragging) return;
    const [px, py] = toCurve(e), i = pts.indexOf(dragging);
    dragging[0] = Math.min(i < pts.length - 1 ? pts[i + 1][0] - 1 : 255, Math.max(i > 0 ? pts[i - 1][0] + 1 : 0, px));
    dragging[1] = py;
    paintCurve();
    previewUpdate({ curves: { [ch]: pts } });
  });
  cc.addEventListener('pointerup', () => { if (dragging) { dragging = null; commitCurve(); } });
  cc.addEventListener('dblclick', e => {
    const [px, py] = toCurve(e), i = pts.findIndex(p => Math.hypot(p[0] - px, p[1] - py) < 12);
    if (i > 0 && i < pts.length - 1) { pts.splice(i, 1); commitCurve(); }
  });

  // Color balance
  const cb = l.colorBalance || {}, rangeShift = cb[S.balanceRange] || {};
  const balSlider = (label, axis) => slider(label, { min: -100, max: 100, value: rangeShift[axis] || 0, fmt: String,
    onPreview: v => previewUpdate({ colorBalance: { [S.balanceRange]: { [axis]: v } } }),
    onCommit: v => update({ colorBalance: { [S.balanceRange]: { [axis]: v } } }) });

  // Threshold
  const th = { ...THRESHOLD_DEFAULT, ...(l.threshold || {}) };
  const tc = el('canvas', { width: 256, height: 60 }), tx = tc.getContext('2d');
  const paintThreshold = t => {
    tx.clearRect(0, 0, 256, 60);
    tx.fillStyle = cssVar('--band'); tx.fillRect(t.low, 0, t.high - t.low + 1, 60);
    drawHistogram(tx, hist[t.channel], 256, 60, cssVar('--hist'));
  };
  paintThreshold(th);
  const thSlider = (label, key) => slider(label, { min: 0, max: 255, value: th[key], fmt: String,
    onPreview: v => { paintThreshold({ ...th, [key]: v }); previewUpdate({ threshold: { ...th, [key]: v } }); },
    onCommit: v => update({ threshold: { ...th, [key]: v } }) });

  // Shadows-highlights, exposure, hue-chroma: one slider per setting (ranges from PARAM_SETS).
  const PARAM_UI = {
    shadowsHighlights: { id: 'shadows-highlights-section', title: 'Shadows-highlights', on: { shadows: 50 },
      labels: { shadows: 'Shadows', highlights: 'Highlights', whitepoint: 'White point', radius: 'Radius', compress: 'Compress',
        shadowsColor: 'Shadows color', highlightsColor: 'Highlights color' }, step: { radius: 0.1, whitepoint: 0.1 }, max: { radius: 200 } },
    exposure: { id: 'exposure-section', title: 'Exposure', on: { stops: 0.5 },
      labels: { stops: 'Exposure (stops)', blackLevel: 'Black level' }, step: { stops: 0.05, blackLevel: 0.001 } },
    hueChroma: { id: 'hue-chroma-section', title: 'Hue-chroma', on: { hue: 30 },
      labels: { hue: 'Hue (°)', chroma: 'Chroma', lightness: 'Lightness' }, step: {} },
    denoise: { id: 'denoise-section', title: 'Noise reduction', on: { strength: 30 },
      labels: { strength: 'Strength', radius: 'Radius' }, step: {} },
    pixelate: { id: 'pixelate-section', title: 'Pixelate', on: { size: 16 }, labels: { size: 'Block size' }, step: {}, max: { size: 128 } },
    emboss: { id: 'emboss-section', title: 'Emboss', on: { depth: 20 }, labels: { azimuth: 'Azimuth (°)', elevation: 'Elevation (°)', depth: 'Depth', keepColor: 'Keep color (bump map)' }, step: {} },
    sharpen: { id: 'unsharp-section', title: 'Unsharp mask (sharpen)', on: { amount: 0.5 },
      labels: { radius: 'Radius', amount: 'Amount', threshold: 'Threshold' }, step: { radius: 0.1, amount: 0.05 }, max: { radius: 30 } },
    highPass: { id: 'high-pass-section', title: 'High pass', on: { radius: 4 },
      labels: { radius: 'Radius' }, step: { radius: 0.5 }, max: { radius: 50 } },
  };
  const paramSection = key => {
    const ui = PARAM_UI[key], cur = { ...paramDefaults(PARAM_SETS[key]), ...(l[key] || {}) };
    const sliders = Object.entries(PARAM_SETS[key]).map(([k, [, min, max]]) => {
      const step = ui.step[k] ?? 1;
      return slider(ui.labels[k], { min, max: ui.max?.[k] ?? max, step, value: cur[k], fmt: v => String(+v.toFixed(step < 0.01 ? 3 : step < 1 ? 2 : 0)),
        onPreview: v => previewUpdate({ [key]: { ...cur, [k]: v } }), onCommit: v => update({ [key]: { [k]: v } }) });
    });
    return section(ui.id, ui.title, !!l[key], [
      field('Enabled', el('input', { type: 'checkbox', checked: !!l[key], onchange: e => update({ [key]: e.target.checked ? ui.on : null }) })),
      ...sliders,
      el('div', { class: 'row' }, el('button', { onclick: () => update({ [key]: null }) }, 'Reset'))]);
  };

  // Color to alpha
  const c2a = { ...C2A_DEFAULT, ...(l.colorToAlpha || {}) };
  const c2aSlider = (label, k) => slider(label, { min: 0, max: 1, step: 0.005, value: c2a[k], fmt: v => v.toFixed(3),
    onPreview: v => previewUpdate({ colorToAlpha: { ...c2a, [k]: v } }), onCommit: v => update({ colorToAlpha: { [k]: v } }) });

  // Distort (content stage, before tone): twirl, pinch/bulge, ripple, waves
  const dist = l.distort, DK = { twirl: { amount: [-720, 720, 5, 180] }, pinch: { amount: [-1, 1, 0.05, -0.5] }, ripple: {}, waves: {}, lens: {} };
  const dset = (k, v) => update({ distort: { [k]: v } });
  const dslider = (label, k, min, max, step, def) => slider(label, { min, max, step, value: dist?.[k] ?? def, fmt: v => String(+(+v).toFixed(step < 1 ? 2 : 0)),
    onPreview: v => previewUpdate({ distort: { ...dist, [k]: v } }), onCommit: v => dset(k, v) });
  const distortSection = section('distort-section', 'Distort', !!dist, [
    field('Kind', el('select', { onchange: e => update({ distort: e.target.value ? { kind: e.target.value, ...(DK[e.target.value].amount ? { amount: DK[e.target.value].amount[3] } : {}) } : null }) },
      el('option', { value: '' }, 'Off'), Object.keys(DK).map(k => el('option', { value: k, selected: dist?.kind === k }, k === 'pinch' ? 'pinch / bulge' : k === 'lens' ? 'lens distortion' : k)))),
    ...(dist ? [
      ...(DK[dist.kind].amount ? [dslider(dist.kind === 'twirl' ? 'Angle (°)' : 'Pinch (− bulge)', 'amount', ...DK[dist.kind].amount)] : []),
      ...(['twirl', 'pinch', 'waves'].includes(dist.kind) ? [dslider('Center X', 'centerX', 0, 1, 0.01, 0.5), dslider('Center Y', 'centerY', 0, 1, 0.01, 0.5)] : []),
      ...(['twirl', 'pinch'].includes(dist.kind) ? [dslider('Radius', 'radius', 0.05, 1, 0.01, 1)] : []),
      ...(['ripple', 'waves'].includes(dist.kind) ? [dslider('Amplitude', 'amplitude', 0, 60, 1, 5), dslider('Wavelength', 'wavelength', 2, 300, 1, 20)] : []),
      ...(dist.kind === 'lens' ? [['Main', 'main'], ['Edge', 'edge'], ['Zoom', 'zoom'], ['Shift X', 'xShift'], ['Shift Y', 'yShift'], ['Brighten', 'brighten']].map(([lab, k]) => dslider(lab, k, -100, 100, 1, 0)) : []),
      ...(dist.kind === 'ripple' ? [field('Direction', el('select', { onchange: e => dset('orientation', e.target.value) }, ['horizontal', 'vertical'].map(o => el('option', { value: o, selected: (dist.orientation ?? 'horizontal') === o }, o))))] : []),
    ] : [])]);

  return [
    distortSection,
    paramSection('denoise'),
    paramSection('sharpen'),
    paramSection('highPass'),
    paramSection('pixelate'),
    paramSection('emboss'),
    paramSection('shadowsHighlights'),
    paramSection('exposure'),
    section('levels-section', 'Levels', !!l.levels, [channelPicker(),
    el('div', { class: 'tone' }, hc),
    lvSlider('Input black', 'inLow', 0, 254), lvSlider('Gamma', 'gamma', 0.1, 5, 0.05), lvSlider('Input white', 'inHigh', 1, 255),
    lvSlider('Output black', 'outLow', 0, 255), lvSlider('Output white', 'outHigh', 0, 255),
    el('div', { class: 'row' },
      el('button', { onclick: () => run('auto-levels') }, 'Auto'),
      el('button', { onclick: () => update({ levels: { [ch]: null } }) }, `Reset ${ch}`),
      el('button', { onclick: () => update({ levels: null }) }, 'Reset all'))]),
    section('curves-section', 'Curves', !!l.curves, [channelPicker(),
    el('div', { class: 'muted' }, 'Click to add a point, drag to move, double-click to remove.'),
    el('div', { class: 'tone' }, cc),
    el('div', { class: 'row' },
      el('select', { onchange: e => { if (e.target.value) update({ curves: { [ch]: CURVE_PRESETS[e.target.value] } }); } },
        el('option', { value: '' }, 'Preset…'), Object.keys(CURVE_PRESETS).map(k => el('option', { value: k }, k))),
      el('button', { onclick: () => update({ curves: { [ch]: null } }) }, `Reset ${ch}`),
      el('button', { onclick: () => update({ curves: null }) }, 'Reset all'))]),
    section('balance-section', 'Color balance', !!l.colorBalance, [
      field('Range', el('select', { onchange: e => { S.balanceRange = e.target.value; propsPanel(true); } },
        BALANCE_RANGES.map(r => el('option', { value: r, selected: r === S.balanceRange }, r[0].toUpperCase() + r.slice(1))))),
      balSlider('Cyan ↔ Red', 'cyanRed'), balSlider('Magenta ↔ Green', 'magentaGreen'), balSlider('Yellow ↔ Blue', 'yellowBlue'),
      field('Luminosity', el('label', {}, el('input', { type: 'checkbox', checked: cb.preserveLuminosity !== false,
        onchange: e => update({ colorBalance: { preserveLuminosity: e.target.checked } }) }), ' Preserve')),
      el('div', { class: 'row' },
        el('button', { onclick: () => update({ colorBalance: { [S.balanceRange]: null } }) }, `Reset ${S.balanceRange}`),
        el('button', { onclick: () => update({ colorBalance: null }) }, 'Reset all'))]),
    paramSection('hueChroma'),
    section('threshold-section', 'Threshold', !!l.threshold, [
      field('Enabled', el('input', { type: 'checkbox', checked: !!l.threshold, onchange: e => update({ threshold: e.target.checked ? th : null }) })),
      field('Channel', el('select', { onchange: e => update({ threshold: { ...th, channel: e.target.value } }) },
        TONE_CHANNELS.map(c => el('option', { value: c, selected: c === th.channel }, c)))),
      el('div', { class: 'tone' }, tc),
      thSlider('Low', 'low'), thSlider('High', 'high'),
      el('div', { class: 'muted' }, 'Pixels between low and high turn white, the rest black.')]),
    section('posterize-section', 'Posterize', !!l.posterize, [
      field('Enabled', el('input', { type: 'checkbox', checked: !!l.posterize, onchange: e => update({ posterize: e.target.checked ? 4 : null }) })),
      slider('Levels', { min: 2, max: 32, value: l.posterize || 4, fmt: String,
        onPreview: v => previewUpdate({ posterize: v }), onCommit: v => update({ posterize: v }) })]),
    section('color-to-alpha-section', 'Color to alpha', !!l.colorToAlpha, [
      field('Enabled', el('input', { type: 'checkbox', checked: !!l.colorToAlpha, onchange: e => update({ colorToAlpha: e.target.checked ? {} : null }) })),
      field('Color', el('input', { type: 'color', value: c2a.color,
        oninput: e => previewUpdate({ colorToAlpha: { ...c2a, color: e.target.value } }), onchange: e => update({ colorToAlpha: { color: e.target.value } }) })),
      el('div', { class: 'row' },
        el('button', { onclick: () => { S.pickC2A = l.id; canvas.style.cursor = 'copy'; status('Click the canvas to pick the color to make transparent'); } }, 'Pick from canvas'),
        el('button', { onclick: () => update({ colorToAlpha: { color: $('#color').value } }) }, 'Use foreground')),
      c2aSlider('Transparency threshold', 'transparency'), c2aSlider('Opacity threshold', 'opacity'),
      el('div', { class: 'muted' }, 'Colors within the transparency threshold vanish; beyond the opacity threshold stay opaque.')]),
  ];
}

// Collapsible panel section; stays open if the user opened it or the layer uses it ("•").
function section(id, title, active, body) {
  return el('details', { class: 'section', id, open: S.open.has(id) || active,
    ontoggle: e => (e.target.open ? S.open.add(id) : S.open.delete(id)) }, el('summary', {}, title, active ? ' •' : ''), ...body);
}

function layersPanel() {
  const box = $('#layers'), d = S.doc;
  box.replaceChildren();
  if (!d.layers.length) box.append(el('div', { class: 'muted' }, 'No layers yet. Import or drop images here, or draw.'));
  // Tree, top first: group contents are indented under their group (▸/▾ folds a group in this view only).
  const rows = [];
  const walk = (pid, depth) => { for (const l of d.layers.filter(l => (l.parent ?? null) === pid).reverse()) { rows.push([l, depth]); if (l.type === 'group' && !S.folded.has(l.id)) walk(l.id, depth + 1); } };
  walk(null, 0);
  const dropOn = async (target, id) => {
    if (!id || id === target.id) return;
    const moving = d.layers.find(x => x.id === id);
    if (target.type === 'group') { if (moving.parent !== target.id) await commit({ type: 'layer.update', id, props: { parent: target.id } }); return; }
    if ((moving.parent ?? null) !== (target.parent ?? null)) await commit({ type: 'layer.update', id, props: { parent: target.parent ?? null } });
    await commit({ type: 'layer.reorder', id, index: S.doc.layers.findIndex(x => x.id === target.id) });
  };
  for (const [l, depth] of rows) {
    const isGroup = l.type === 'group';
    box.append(el('div', {
      class: `layer${l.id === S.selected ? ' selected' : ''}${isGroup ? ' group-row' : ''}`, draggable: 'true', style: `padding-left:${6 + depth * 14}px`,
      title: isGroup ? 'Drop layers here to put them in this group' : '',
      onclick: () => { S.selected = l.id; if (S.maskEdit && S.maskEdit !== l.id) S.maskEdit = null; if (S.meshEdit && S.meshEdit.id !== l.id) { S.meshEdit = null; S.preview = null; } options(); draw(); panels(); },
      ondblclick: () => { const name = prompt(isGroup ? 'Group name' : 'Layer name', l.name); if (name) commit({ type: 'layer.update', id: l.id, props: { name } }); },
      ondragstart: e => e.dataTransfer.setData('text/layer', l.id),
      ondragover: e => e.preventDefault(),
      ondrop: e => { e.preventDefault(); e.stopPropagation(); dropOn(l, e.dataTransfer.getData('text/layer')); },
    },
    el('span', { class: `eye${l.visible ? '' : ' off'}`, title: 'Toggle visibility',
      onclick: e => { e.stopPropagation(); commit({ type: 'layer.update', id: l.id, props: { visible: !l.visible } }); } }, eyeIcon()),
    isGroup ? el('span', { class: 'fold', title: 'Show / hide contents', onclick: e => { e.stopPropagation(); S.folded.has(l.id) ? S.folded.delete(l.id) : S.folded.add(l.id); layersPanel(); } },
      S.folded.has(l.id) ? '▸' : '▾') : null,
    l.clip ? el('span', { class: 'kind', title: 'Clipped to the layer below' }, '↳') : null,
    el('span', { class: 'name' }, l.name),
    l.locks ? el('span', { class: 'kind', title: `Locked: ${Object.keys(l.locks).join(', ')}` }, lockIcon()) : null,
    el('span', { class: 'kind' }, `${l.type} · ${l.id}`)));
  }
  const cur = sel(d), has = !!cur;
  $('#layer-actions').replaceChildren(...[
    el('button', { onclick: () => run('new-paint'), title: 'New paint layer' }, '+ Paint'),
    el('button', { onclick: () => run('group'), disabled: !has, title: 'Put the selected layer in a new group (Ctrl+G)' }, 'Group'),
    cur?.type === 'group' ? el('button', { onclick: () => run('ungroup'), title: 'Ctrl+Shift+G' }, 'Ungroup') : null,
    el('button', { onclick: () => run('toggle-clip'), disabled: !has, class: cur?.clip ? 'on' : '', title: 'Clip to the layer below (Ctrl+Alt+G)' }, 'Clip'),
    el('button', { onclick: () => run('duplicate'), disabled: !has }, 'Dup'),
    el('button', { onclick: () => commit({ type: 'layer.reorder', id: S.selected, index: 'up' }), disabled: !has }, '▲'),
    el('button', { onclick: () => commit({ type: 'layer.reorder', id: S.selected, index: 'down' }), disabled: !has }, '▼'),
    el('button', { onclick: () => run('merge-down'), disabled: !has }, 'Merge ↓'),
    el('button', { onclick: () => run('delete'), disabled: !has }, 'Delete')].filter(Boolean));
}

function historyPanel() {
  const box = $('#history');
  box.replaceChildren(...[...S.entries].reverse().map(e => el('div', { class: `entry${e.undone ? ' undone' : ''}` },
    el('span', { class: `who ${e.author}` }, e.author),
    el('span', { class: 'text' }, e.text),
    el('span', { class: 'meta' }, `#${e.seq} · ${new Date(e.ts).toLocaleTimeString()}${e.undone ? ' · undone' : ''}`))));
}

function panels() {
  if (!S.doc) return;
  propsPanel(); layersPanel(); pathsPanel(); channelsPanel(); historyPanel();
  document.querySelector('[data-cmd=undo]').disabled = !S.canUndo;
  document.querySelector('[data-cmd=redo]').disabled = !S.canRedo;
}

// ---- Commands (menus + shortcuts) ---------------------------------------------------------

// File → Open project: every project in the workspace folder; open here or in a new tab (one per document).
async function projectsDialog() {
  const { root, projects } = await (await fetch('/api/projects')).json();
  const close = () => overlay.remove();
  const here = name => (PROJECT ? PROJECT === name : projects.find(p => p.start)?.name === name);
  const overlay = el('div', { class: 'modal-bg', onclick: e => { if (e.target === overlay) close(); } },
    el('div', { class: 'modal' },
      el('h3', {}, 'Projects'), el('div', { class: 'muted' }, root),
      el('div', { class: 'project-list' }, projects.map(p => el('div', { class: `project${here(p.name) ? ' current' : ''}` },
        el('div', {}, el('b', {}, p.name), el('div', { class: 'muted' }, `${p.width}×${p.height} · ${p.layers} layers · ${new Date(p.modified).toLocaleString()}`)),
        el('div', { class: 'row' },
          el('button', { onclick: () => { location.search = `?project=${encodeURIComponent(p.name)}`; } }, here(p.name) ? 'Reload' : 'Open'),
          el('button', { onclick: () => { window.open(`/?project=${encodeURIComponent(p.name)}`, '_blank'); close(); } }, 'New tab'))))),
      el('div', { class: 'row' }, el('button', { onclick: () => { close(); run('new-project'); } }, 'New project…'), el('button', { onclick: close }, 'Close'))));
  document.body.append(overlay);
}

async function importFiles(files) {
  for (const file of files) {
    const psd = /\.(psd|xcf)$/i.test(file.name || ''); // layered files: PSD or GIMP XCF
    if (!psd && !file.type.startsWith('image/')) continue;
    if (psd) status(`Importing ${file.name}…`);
    const res = await fetch(api('/api/upload', { name: file.name || 'pasted.png' }), { method: 'POST', body: file });
    const up = await res.json();
    if (!res.ok) { status(up.error, true); continue; }
    if (psd) { await commit({ type: 'doc.import', src: up.file, name: file.name }); fitZoom(); continue; } // layers, groups, masks in one step
    const big = up.w > S.doc.width || up.h > S.doc.height;
    const entry = await commit({ type: 'layer.add', layer: { type: 'image', name: file.name || 'Pasted image', ...up, fit: big ? 'contain' : undefined } });
    if (entry) S.selected = entry.op.layer.id;
  }
  panels(); draw();
}

function promptSize(title, w, h) {
  const v = prompt(title, `${w}x${h}`);
  const m = v && v.match(/^\s*(\d+)\s*[x×, ]\s*(\d+)\s*$/);
  if (v && !m) status('Enter a size like 1200x800', true);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

function adjust(props) {
  if (!sel()) return status('Select a layer first', true);
  return update({ adjust: props });
}

async function run(cmd) {
  const d = S.doc, l = sel(d);
  const needLayer = ['duplicate', 'merge-down', 'fit', 'delete', 'flip-h', 'flip-v', 'rotate-90', 'drop-shadow', 'clear', 'copy-layer', 'cut-layer', 'mask', 'unmask', 'select-alpha'];
  const needSelection = ['clear', 'copy-layer', 'cut-layer', 'mask', 'crop-selection', 'select-feather', 'select-grow', 'select-shrink', 'select-border'];
  if (needSelection.includes(cmd) && !d.selection) return status('Make a selection first', true);
  if (needLayer.includes(cmd) && !l) return status('Select a layer first', true);
  switch (cmd) {
    case 'new': { const s = promptSize('New canvas size (clears all layers; undoable)', d.width, d.height); if (s) await commit({ type: 'canvas.new', width: s[0], height: s[1], background: '#ffffff' }); break; }
    case 'import': $('#file').click(); break;
    case 'export': case 'export-png': case 'export-jpeg': case 'export-webp': case 'export-psd': case 'export-xcf': case 'export-pdf': case 'export-svg': {
      const f = cmd === 'export' ? 'png' : cmd.slice(7), name = `${PROJECT || S.projectName || 'export'}.${f === 'jpeg' ? 'jpg' : f}`;
      const res = await fetch(api('/api/export', { format: f }));
      if (!res.ok) return status((await res.json()).error, true);
      const notes = res.headers.get('x-artifex-notes');
      const a = el('a', { href: URL.createObjectURL(await res.blob()), download: name });
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      status(`Exported ${name}${notes ? ` — note: ${decodeURIComponent(notes)}` : ''}`);
      break;
    }
    case 'open-project': await projectsDialog(); break;
    case 'new-project': {
      const name = prompt('New project name (letters, numbers, spaces, - _ .)');
      if (!name) break;
      const size = promptSize('Canvas size', 1200, 800);
      if (!size) break;
      const res = await fetch('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, width: size[0], height: size[1] }) });
      if (!res.ok) return status((await res.json()).error, true);
      location.search = `?project=${encodeURIComponent(name)}`;
      break;
    }
    case 'undo': await commit({ type: 'history.undo' }); break;
    case 'redo': await commit({ type: 'history.redo' }); break;
    case 'canvas-size': { const s = promptSize('Canvas size (anchored at center)', d.width, d.height); if (s) await commit({ type: 'canvas.resize', width: s[0], height: s[1] }); break; }
    case 'background': { const c = prompt('Background color (e.g. #ffffff, or "none")', d.background || 'none'); if (c != null) await commit({ type: 'canvas.background', color: c === 'none' ? null : c }); break; }
    case 'flatten': await commit({ type: 'layer.merge', flatten: true }); break;
    case 'new-paint': { const e = await commit({ type: 'layer.add', layer: { type: 'paint' } }); if (e) S.selected = e.op.layer.id; break; }
    case 'duplicate': { const e = await commit({ type: 'layer.duplicate', id: l.id }); if (e) S.selected = e.op.newId; break; }
    case 'merge-down': { const e = await commit({ type: 'layer.merge', down: l.id }); if (e) S.selected = e.op.newId; break; }
    case 'delete': await commit({ type: 'layer.remove', id: l.id }); break;
    case 'fit': {
      const { w, h } = layerSize(l, ctx), s = Math.min(d.width / w, d.height / h);
      await update({ scaleX: s, scaleY: s, x: Math.round((d.width - w * s) / 2), y: Math.round((d.height - h * s) / 2) });
      break;
    }
    case 'levels': case 'curves': case 'balance': case 'threshold': case 'posterize': case 'shadows-highlights': case 'exposure': case 'hue-chroma': case 'color-to-alpha':
    case 'unsharp': case 'denoise': case 'high-pass': case 'distort': case 'pixelate': case 'emboss': {
      if (!l) return status('Select a layer first', true);
      const sec = document.getElementById(`${cmd}-section`);
      if (sec) { S.open.add(sec.id); sec.open = true; sec.scrollIntoView({ block: 'start' }); }
      break;
    }
    case 'select-path': await pathCommand('select'); break;
    case 'liquify': setTool('liquify'); break;
    case 'copy': await copyToClipboard(false); break;
    case 'tool-scissors': setTool('scissors'); break;
    case 'tool-fgselect': setTool('fgselect'); break;
    case 'copy-merged': await copyToClipboard(true); break;
    case 'paste': await pasteFromClipboard(readClip(), false); break;
    case 'paste-in-place': await pasteFromClipboard(readClip(), true); break;
    case 'lens': { if (!l) return status('Select a layer first', true); await update({ distort: { kind: 'lens', main: 30 } }); const sec = document.getElementById('distort-section'); if (sec) { sec.open = true; sec.scrollIntoView({ block: 'start' }); } break; }
    case 'stroke-selection': {
      if (!d.selection) return status('Make a selection first', true);
      const v = prompt('Stroke width in px (add "inside" or "outside" to place it, e.g. "6 inside")', String(S.size));
      if (!v) break;
      const m = v.match(/(\d+(?:\.\d+)?)\s*(inside|outside|center)?/i);
      const e = await commit({ type: 'edit.strokeSelection', color: color(), width: Number(m?.[1] || 4), position: (m?.[2] || 'center').toLowerCase() });
      if (e) S.selected = e.op.layer.id;
      break;
    }
    case 'save-selection': {
      if (!d.selection) return status('Make a selection first', true);
      const name = prompt('Save the selection as channel named:', `Selection ${(d.channels?.length ?? 0) + 1}`);
      if (name) await commit({ type: 'channel.save', name });
      break;
    }
    case 'load-selection': {
      const names = (d.channels || []).map(c => c.name);
      if (!names.length) return status('No saved selections yet (Select → Save selection)', true);
      const name = prompt(`Load which channel? (${names.join(', ')})`, names.at(-1));
      if (name) await commit({ type: 'channel.load', name });
      break;
    }
    case 'transform-selection': setTool(SELECT_TOOLS.includes(S.tool) ? S.tool : 'rselect'); S.selXform = true; options(); draw(); break;
    case 'toggle-theme': toggleTheme(); break;
    case 'toggle-rulers': S.view.rulers = !S.view.rulers; saveView(); break;
    case 'toggle-grid': S.view.grid = !S.view.grid; saveView(); break;
    case 'toggle-snap': S.view.snap = !S.view.snap; saveView(); status(`Snapping ${S.view.snap ? 'on' : 'off'}`); break;
    case 'grid-size': { const v = Number(prompt('Grid size (px)', S.view.gridSize)); if (v > 0) { S.view.gridSize = v; S.view.grid = true; saveView(); } break; }
    case 'clear-guides': if (S.doc.guides?.length) await commit({ type: 'guide.clear' }); break;
    case 'image-size': {
      const v = prompt(`Image size: new width in px (height keeps the ratio), "w x h", or a percentage like "50%"\nNow ${d.width}×${d.height}`, String(d.width));
      if (!v) break;
      const m = v.trim().match(/^(\d+(?:\.\d+)?)\s*%$/), wh = v.split(/[x×,\s]+/).map(Number).filter(n => n > 0);
      await commit(m ? { type: 'canvas.scale', percent: Number(m[1]) } : wh.length >= 2 ? { type: 'canvas.scale', width: Math.round(wh[0]), height: Math.round(wh[1]) } : { type: 'canvas.scale', width: Math.round(wh[0]) });
      fitZoom();
      break;
    }
    case 'new-adjustment': {
      const e = await commit({ type: 'layer.add', layer: { type: 'adjustment', name: 'Adjustment', ...(l?.parent ? { parent: l.parent } : {}) }, ...(l ? { index: S.doc.layers.indexOf(l) + 1 } : {}) });
      if (e) { S.selected = e.op.layer.id; S.open.add('levels-section'); }
      break;
    }
    case 'group': {
      if (!l) return status('Select a layer first', true);
      const e = await commit({ type: 'layer.group', ids: [l.id] });
      if (e) S.selected = e.op.newId;
      break;
    }
    case 'ungroup':
      if (l?.type !== 'group') return status('Select a group first', true);
      await commit({ type: 'layer.ungroup', id: l.id });
      break;
    case 'toggle-clip':
      if (!l) return status('Select a layer first', true);
      await commit({ type: 'layer.update', id: l.id, props: { clip: !l.clip } });
      break;
    case 'toggle-panels': togglePanels(); break;
    case 'toggle-toolbar': setToolbarExpanded(!$('#tools').classList.contains('expanded')); break;
    case 'stroke-path': await pathCommand('stroke'); break;
    case 'fill-path': await pathCommand('fill'); break;
    case 'auto-levels':
      if (!l) return status('Select a layer first', true);
      await commit({ type: 'layer.autoLevels', id: l.id });
      break;
    case 'select-all': await commit({ type: 'selection.all' }); break;
    case 'select-none': await commit({ type: 'selection.none' }); break;
    case 'select-invert': await commit({ type: 'selection.invert' }); break;
    case 'select-by-color': S.wand.contiguous = false; setTool('wand'); status('Select by color: click a color (Contiguous is off)'); break;
    case 'select-alpha': await commit({ type: 'selection.set', mode: 'replace', shape: { type: 'alpha', layer: l.id } }); break;
    case 'select-feather': case 'select-grow': case 'select-shrink': case 'select-border': {
      const kind = cmd.slice(7), r = prompt(`${kind[0].toUpperCase() + kind.slice(1)} selection by (px)`, kind === 'feather' ? 10 : 5);
      if (r != null) await commit({ type: 'selection.modify', kind, radius: Number(r) });
      break;
    }
    case 'clear': await commit({ type: 'edit.clear', id: l.id }); break;
    case 'fill': { const e = await commit({ type: 'edit.fill', color: color() }); if (e) S.selected = e.op.layer.id; break; }
    case 'copy-layer': case 'cut-layer': {
      const e = await commit({ type: 'layer.fromSelection', id: l.id, cut: cmd === 'cut-layer' });
      if (e) S.selected = e.op.newId;
      break;
    }
    case 'mask': await commit({ type: 'layer.mask', id: l.id, mode: 'keep' }); break;
    case 'unmask': await commit({ type: 'layer.unmask', id: l.id }); break;
    case 'crop-selection': await commit({ type: 'canvas.crop', toSelection: true }); break;
    case 'flip-h': await update({ scaleX: -l.scaleX }); break;
    case 'flip-v': await update({ scaleY: -l.scaleY }); break;
    case 'rotate-90': await update({ rotation: (l.rotation + 90) % 360 }); break;
    case 'desaturate': await adjust({ grayscale: 100 }); break;
    case 'invert': await adjust({ invert: l?.adjust.invert ? 0 : 100 }); break;
    case 'sepia': await adjust({ sepia: 100 }); break;
    case 'reset-colors': await adjust({ ...ADJUST_DEFAULTS }); break;
    case 'blur': { const r = prompt('Blur radius (px)', l?.adjust.blur || 4); if (r != null) await adjust({ blur: Number(r) }); break; }
    case 'drop-shadow': {
      // GIMP-style drop shadow: a dark, blurred, offset copy placed beneath the layer.
      const e = await commit({ type: 'layer.duplicate', id: l.id, name: `${l.name} shadow`, dx: 8, dy: 8 });
      if (!e) break;
      await commit({ type: 'layer.update', id: e.op.newId, props: { opacity: 0.6, adjust: { brightness: 0, blur: 6 } } });
      await commit({ type: 'layer.reorder', id: e.op.newId, index: S.doc.layers.findIndex(x => x.id === l.id) });
      break;
    }
  }
  panels(); draw();
}

function swapColors() {
  const fg = $('#color').value;
  $('#color').value = $('#bgcolor').value;
  $('#bgcolor').value = fg;
}
$('#swap').addEventListener('click', swapColors);

document.querySelectorAll('[data-cmd]').forEach(b => b.addEventListener('click', () => run(b.dataset.cmd)));
document.querySelectorAll('[data-tool]').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));
$('#file').addEventListener('change', e => { importFiles([...e.target.files]); e.target.value = ''; });

const vp = $('#viewport');
vp.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); vp.classList.add('drop'); } });
vp.addEventListener('dragleave', () => vp.classList.remove('drop'));
vp.addEventListener('drop', e => { e.preventDefault(); vp.classList.remove('drop'); importFiles([...e.dataTransfer.files]); });
vp.addEventListener('scroll', () => drawRulers());
vp.addEventListener('wheel', e => { if (e.ctrlKey) { e.preventDefault(); setZoom(S.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)); } }, { passive: false });
// ---- Copy / paste: layers stay editable across projects and tabs (internal clipboard in localStorage); a PNG goes
// on the system clipboard too, for other apps. Images copied in other apps still paste as image layers.
const CLIP_KEY = 'artifex.clipboard';
const readClip = () => { try { return JSON.parse(localStorage.getItem(CLIP_KEY) || 'null'); } catch { return null; } };
let pasteInPlace = false;

async function copyToClipboard(merged = false) {
  const d = S.doc, l = sel(d), token = Math.random().toString(36).slice(2);
  if (!d.selection && !l && !merged) return status('Select a layer (or make a selection) to copy', true);
  const c = env.makeCanvas(d.width, d.height), cx = c.getContext('2d');
  if (merged || !l) render(cx, d, env);
  else render(cx, { ...d, layers: d.layers.filter(q => q.id === l.id || ancestorsOf(d, q).includes(l.id)).map(q => (q.id === l.id ? { ...q, parent: undefined } : q)) }, env, { background: false });
  let clip, box = { x: 0, y: 0, w: d.width, h: d.height };
  if (d.selection) { // GIMP: copy the selected area only, as pixels
    cx.globalCompositeOperation = 'destination-in';
    cx.drawImage(selectionMask(d.selection, d.width, d.height, env), 0, 0);
    box = selectionBox(d) || box;
  }
  const out = env.makeCanvas(box.w, box.h);
  out.getContext('2d').drawImage(c, -box.x, -box.y);
  const blob = await new Promise(r => out.toBlob(r, 'image/png'));
  if (d.selection || merged) clip = { kind: 'pixels', token, x: box.x, y: box.y, w: box.w, h: box.h, png: out.toDataURL('image/png') };
  else clip = { kind: 'layers', token, project: S.projectName, ids: [l.id], name: l.name };
  try { localStorage.setItem(CLIP_KEY, JSON.stringify(clip)); } catch { return status('The copy is too large for the browser clipboard storage', true); }
  try { await navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob([`artifex:${token}`], { type: 'text/plain' }), 'image/png': blob })]); } catch {}
  status(clip.kind === 'layers' ? `Copied layer "${l.name}" — Ctrl+V pastes it here or in another project tab` : `Copied ${box.w}×${box.h} pixels${merged ? ' (merged)' : ''}`);
}

async function pasteFromClipboard(clip = readClip(), inPlace = false) {
  if (!clip) return status('Nothing copied yet', true);
  if (clip.kind === 'layers') {
    const e = await commit({ type: 'layer.paste', from: clip.project, ids: clip.ids, inPlace });
    if (e) S.selected = e.op.layers.at(-1)?.id ?? S.selected;
  } else {
    const blob = await (await fetch(clip.png)).blob();
    const up = await (await fetch(api('/api/upload', { name: 'pasted.png' }), { method: 'POST', body: blob })).json();
    const d = S.doc, x = inPlace ? clip.x : Math.round((d.width - clip.w) / 2), y = inPlace ? clip.y : Math.round((d.height - clip.h) / 2);
    const e = await commit({ type: 'layer.add', layer: { type: 'image', name: 'Pasted', ...up, x, y } });
    if (e) S.selected = e.op.layer.id;
  }
  panels(); draw();
}

document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') pasteInPlace = e.shiftKey; }, true);
document.addEventListener('paste', e => {
  if (e.target.closest?.('input, textarea, select')) return;
  const text = e.clipboardData?.getData('text/plain') || '', clip = readClip(), files = [...(e.clipboardData?.files || [])];
  if (clip && (text === `artifex:${clip.token}` || !files.length)) { e.preventDefault(); pasteFromClipboard(clip, pasteInPlace); return; }
  if (files.length) importFiles(files);
});

const TOOL_KEYS = { p: 'pen', s: 'clone', j: 'heal', r: 'smudge', v: 'move', b: 'brush', e: 'eraser', t: 'text', u: 'rect', o: 'ellipse', c: 'crop', i: 'picker', m: 'rselect', l: 'lasso', w: 'wand', g: 'gradient' };
document.addEventListener('keydown', e => {
  if (e.target.closest('input, textarea, select')) return;
  const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
  if (k === 'tab' && e.shiftKey && !mod) { e.preventDefault(); togglePanels(); return; }
  if (S.tool === 'scissors' && S.sc.anchors.length) {
    if (k === 'enter') { e.preventDefault(); scissorsFinish(); return; }
    if (k === 'escape') { S.sc = { anchors: [], segs: [], hover: null }; options(); draw(); return; }
    if (k === 'backspace' || k === 'delete') { e.preventDefault(); S.sc.anchors.pop(); S.sc.segs.pop(); S.sc.hover = null; options(); draw(); return; }
  }
  if (S.tool === 'fgselect' && (S.fg.outline || S.fg.useSelection)) {
    if (k === 'enter') { e.preventDefault(); fgFinish(); return; }
    if (k === 'escape') { S.fg = { outline: null, strokes: [], useSelection: false }; options(); draw(); return; }
  }
  if (S.tool === 'pen' && S.pen.draft) { // keys while drawing a path
    if (k === 'enter') { e.preventDefault(); finishPen(); return; }
    if (k === 'escape') { S.pen.draft = null; options(); draw(); return; }
    if (k === 'backspace' || k === 'delete') { e.preventDefault(); S.pen.draft.anchors.pop(); if (!S.pen.draft.anchors.length) S.pen.draft = null; options(); draw(); return; }
  }
  if (S.tool === 'pen' && activePath() && (k === 'delete' || k === 'backspace') && !mod) { e.preventDefault(); pathCommand('delete'); return; }
  if (mod && k === 'z') { e.preventDefault(); run(e.shiftKey ? 'redo' : 'undo'); }
  else if (mod && k === 'y') { e.preventDefault(); run('redo'); }
  else if (mod && k === 'j') { e.preventDefault(); run(S.doc.selection ? (e.shiftKey ? 'cut-layer' : 'copy-layer') : 'duplicate'); }
  else if (mod && k === 'a') { e.preventDefault(); run(e.shiftKey ? 'select-none' : 'select-all'); }
  else if (mod && k === 'd') { e.preventDefault(); run('select-none'); }
  else if (mod && k === 'i') { e.preventDefault(); run('select-invert'); }
  else if (mod && k === 'c') { e.preventDefault(); copyToClipboard(e.shiftKey); }
  else if (mod && k === 'r') { e.preventDefault(); run('toggle-rulers'); }
  else if (mod && k === "'") { e.preventDefault(); run('toggle-grid'); }
  else if (mod && k === ';') { e.preventDefault(); run('toggle-snap'); }
  else if (mod && k === 'g') { e.preventDefault(); run(e.altKey ? 'toggle-clip' : e.shiftKey ? 'ungroup' : 'group'); }
  else if (mod && k === 'e') { e.preventDefault(); run(e.shiftKey ? 'flatten' : 'merge-down'); }
  else if (mod && k === '0') { e.preventDefault(); fitZoom(); }
  else if (mod && k === '1') { e.preventDefault(); setZoom(1); }
  else if (mod && (k === '=' || k === '+')) { e.preventDefault(); setZoom(S.zoom * 1.25); }
  else if (mod && k === '-') { e.preventDefault(); setZoom(S.zoom / 1.25); }
  else if (mod) return;
  else if (k === 'm' && e.shiftKey) setTool('eselect');
  else if (k === 'g' && e.shiftKey) setTool('bucket');
  else if (k === 'x') swapColors();
  else if (k === 'd' && e.shiftKey) setTool('dodge');
  else if (k === 'r' && e.shiftKey && !mod) setTool('blur');
  else if (k === 'l' && e.shiftKey && !mod) setTool('scissors');
  else if (k === 'f' && e.shiftKey && !mod) setTool('fgselect');
  else if (k === 'q' && !mod) setQuickMask(!S.quickMask);
  else if (k === 'd') { $('#color').value = '#000000'; $('#bgcolor').value = '#ffffff'; }
  else if (TOOL_KEYS[k] && !mod) setTool(TOOL_KEYS[k]);
  else if (k === 'delete' || k === 'backspace') run(S.doc.selection && sel() ? 'clear' : 'delete');
  else if (k === 'enter' && S.crop) applyCrop();
  else if (k === 'escape' && S.meshEdit) { S.meshEdit = null; S.preview = null; options(); draw(); }
  else if (k === 'escape') { if (S.crop) { S.crop = null; options(); } else S.selected = null; draw(); panels(); }
  else if (k === '[' || k === ']') { S.size = Math.max(1, Math.min(200, S.size + (k === ']' ? 2 : -2))); options(); draw(); }
  else if (k.startsWith('arrow') && SELECT_TOOLS.includes(S.tool) && S.doc.selection) {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    commit({ type: 'selection.translate', dx: k === 'arrowleft' ? -step : k === 'arrowright' ? step : 0, dy: k === 'arrowup' ? -step : k === 'arrowdown' ? step : 0 });
  }
  else if (k.startsWith('arrow') && sel()) {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1, l = sel();
    update({ x: l.x + (k === 'arrowleft' ? -step : k === 'arrowright' ? step : 0), y: l.y + (k === 'arrowup' ? -step : k === 'arrowdown' ? step : 0) });
  }
});

new EventSource(api('/api/events')).addEventListener('change', () => refresh());
// Theme: dark (default) or light. Follows the system setting until the user picks one; remembered per browser.
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
function applyTheme(theme, remember = false) {
  document.documentElement.dataset.theme = theme;
  const light = theme === 'light', next = light ? 'dark' : 'light';
  $('#theme-toggle').title = `Switch to ${next} mode`;
  $('#theme-toggle').innerHTML = light // moon in light mode, sun in dark mode: the icon shows what you switch to
    ? '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/></svg>'
    : '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  $('#theme-label').textContent = light ? 'Dark mode' : 'Light mode';
  if (remember) store.set('artifex.theme', theme);
  if (S.doc) { propsPanel(true); draw(); } // histogram / curve canvases use theme colors
}
const toggleTheme = () => applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light', true);
$('#theme-toggle').addEventListener('click', toggleTheme);
const systemLight = matchMedia('(prefers-color-scheme: light)');
applyTheme(store.get('artifex.theme') || (systemLight.matches ? 'light' : 'dark'));
systemLight.addEventListener('change', e => { if (!store.get('artifex.theme')) applyTheme(e.matches ? 'light' : 'dark'); });

// Right-hand panels: full drawer, or a thin strip of panel names (Shift+Tab, like Photoshop).
function setPanelsCollapsed(on) {
  $('.panels').classList.toggle('collapsed', on);
  $('#panels-toggle').title = on ? 'Show panels (Shift+Tab)' : 'Hide panels (Shift+Tab)';
  document.querySelector('[data-cmd=toggle-panels]').firstChild.textContent = on ? 'Show panels ' : 'Hide panels ';
  store.set('artifex.panelsCollapsed', on ? '1' : '0');
}
const togglePanels = () => setPanelsCollapsed(!$('.panels').classList.contains('collapsed'));
$('#panels-toggle').addEventListener('click', togglePanels);
// A strip label reopens the panels and jumps to its section: scrolled into view and briefly highlighted.
document.querySelectorAll('.panels-tabs [data-panel]').forEach(b => b.addEventListener('click', () => {
  setPanelsCollapsed(false);
  const target = document.getElementById(b.dataset.panel);
  target.scrollIntoView({ block: 'nearest' });
  target.scrollTop = 0;
  target.classList.remove('flash');
  void target.offsetWidth; // restart the animation on repeated clicks
  target.classList.add('flash');
}));
setPanelsCollapsed(store.get('artifex.panelsCollapsed') === '1');

// Toolbar: one column (default) or two, like Photoshop's double-arrow toggle; remembered per browser.
function setToolbarExpanded(on) {
  $('#tools').classList.toggle('expanded', on);
  $('#tools-toggle').title = on ? 'Collapse toolbar to one column' : 'Expand toolbar to two columns';
  try { localStorage.setItem('artifex.toolsExpanded', on ? '1' : '0'); } catch {}
}
$('#tools-toggle').addEventListener('click', () => setToolbarExpanded(!$('#tools').classList.contains('expanded')));
try { setToolbarExpanded(localStorage.getItem('artifex.toolsExpanded') === '1'); } catch { setToolbarExpanded(false); }

fetch('/api/projects').then(r => r.json()).then(({ projects }) => {
  S.projectName = PROJECT || projects.find(p => p.start)?.name;
  document.title = `${S.projectName || 'Project'} — ImageArtifex`;
}).catch(() => {});
loadView();
setTool('move');
gpuBadge();
refresh().then(fitZoom);
