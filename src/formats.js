// File formats beyond PNG/JPEG/WebP/AVIF (Node only): PSD import/export (ag-psd), PDF and SVG export.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { createCanvas, ImageData } from '@napi-rs/canvas';
import { readPsd, writePsdBuffer, initializeCanvas } from 'ag-psd';
import { layerSize, layerMatrix, textLines, fontOf, LINE_HEIGHT, paintOrder } from './render.js';
import { hasTone } from './tone.js';
import { writeXcf, readXcf } from './xcf.js';

initializeCanvas(createCanvas, undefined, (w, h) => new ImageData(w, h));

// Photoshop blend mode names ↔ ours (canvas composite operations).
const PS_BLEND = { normal: 'normal', 'pass through': 'normal', darken: 'darken', multiply: 'multiply', 'color burn': 'color-burn', lighten: 'lighten',
  screen: 'screen', 'color dodge': 'color-dodge', overlay: 'overlay', 'soft light': 'soft-light', 'hard light': 'hard-light',
  difference: 'difference', exclusion: 'exclusion', hue: 'hue', saturation: 'saturation', color: 'color', luminosity: 'luminosity' };
const TO_PS = Object.fromEntries(Object.entries(PS_BLEND).filter(([k]) => k !== 'pass through').map(([k, v]) => [v, k]));

// Smallest box holding the visible pixels of a canvas: [x, y, w, h] or null.
function alphaBox(canvas) {
  const { width: w, height: h } = canvas, d = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return x1 < 0 ? null : [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
}
function crop(canvas, [x, y, w, h]) {
  const c = createCanvas(w, h);
  c.getContext('2d').drawImage(canvas, -x, -y);
  return c;
}

// A layer on its own: its pixels with transform, filters, tone and masks applied, but not its opacity/blend/group.
async function soloCanvas(renderCanvas, dir, doc, l) {
  const solo = { ...l, opacity: 1, blend: 'normal', visible: true, parent: undefined, clip: undefined };
  return renderCanvas(dir, { ...doc, background: null, layers: [solo] }, { background: false });
}

const children = (doc, pid) => doc.layers.filter(l => (l.parent ?? null) === pid);

// ---- PSD export ---------------------------------------------------------------------------------------------
// Layers and groups with opacity, blend mode, visibility and clipping; each layer's tone, filters and masks are
// baked into its pixels; adjustment layers have no PSD equivalent and are left out (reported in `skipped`).
export async function toPsd(renderCanvas, dir, doc) {
  const skipped = [];
  const build = async pid => {
    const out = [];
    for (const l of children(doc, pid)) {
      const common = { name: l.name, hidden: !l.visible, opacity: l.opacity, blendMode: TO_PS[l.blend] ?? 'normal', ...(l.clip ? { clipping: true } : {}) };
      if (l.type === 'adjustment') { skipped.push(l.name); continue; }
      if (l.type === 'group') { out.push({ ...common, opened: true, children: await build(l.id) }); continue; }
      const full = await soloCanvas(renderCanvas, dir, doc, l), box = alphaBox(full);
      out.push(box ? { ...common, left: box[0], top: box[1], canvas: crop(full, box) } : common);
    }
    return out;
  };
  const layers = await build(null);
  if (doc.background) {
    const bg = createCanvas(doc.width, doc.height), c = bg.getContext('2d');
    c.fillStyle = doc.background; c.fillRect(0, 0, doc.width, doc.height);
    layers.unshift({ name: 'Background', left: 0, top: 0, canvas: bg });
  }
  const composite = await renderCanvas(dir, doc);
  return { buffer: writePsdBuffer({ width: doc.width, height: doc.height, children: layers, canvas: composite }), skipped };
}

// ---- PSD import -------------------------------------------------------------------------------------------
// Turns a PSD into layer specs for one doc.import op: pixel layers become image layers (text and smart objects
// come in as their pixels), folders become groups, masks become layer masks. `store` saves PNG assets.
export async function fromPsd(buffer, { nextId, store, maskShape }) {
  const psd = readPsd(buffer, { skipThumbnail: true }), layers = [], notes = new Set();
  let id = nextId;
  const walk = async (list, parent) => {
    for (const p of list || []) {
      const blend = PS_BLEND[p.blendMode ?? 'normal'];
      if (!blend) notes.add(`blend mode "${p.blendMode}" shown as normal`);
      // PSD stores opacity in 8 bits: round to whole percent
      const common = { id: `L${id++}`, name: p.name || 'Layer', visible: !p.hidden, opacity: Math.round((p.opacity ?? 1) * 100) / 100, blend: blend ?? 'normal',
        ...(parent ? { parent } : {}), ...(p.clipping ? { clip: true } : {}) };
      if (p.children) { layers.push({ ...common, type: 'group' }); await walk(p.children, common.id); continue; }
      if (p.text) notes.add('text layers come in as pixels');
      if (!p.canvas || !p.canvas.width || !p.canvas.height) { layers.push({ ...common, type: 'paint', w: psd.width, h: psd.height, strokes: [] }); continue; }
      const layer = { ...common, type: 'image', ...(await store(await p.canvas.encode('png'))), x: p.left ?? 0, y: p.top ?? 0 };
      const m = p.mask;
      if (m?.canvas && !m.disabled) {
        // PSD masks are grayscale with a default color outside their box; ours are selection alpha in doc space.
        const full = createCanvas(psd.width, psd.height), fc = full.getContext('2d');
        const g = m.defaultColor ?? 0;
        fc.fillStyle = `rgb(${g},${g},${g})`; fc.fillRect(0, 0, psd.width, psd.height);
        fc.drawImage(m.canvas, m.left ?? 0, m.top ?? 0);
        const img = fc.getImageData(0, 0, psd.width, psd.height), d = img.data;
        for (let i = 0; i < d.length; i += 4) { d[i + 3] = d[i]; d[i] = d[i + 1] = d[i + 2] = 255; }
        fc.putImageData(img, 0, 0);
        const shape = await maskShape(full, `PSD mask of "${common.name}"`);
        layer.mask = [{ mode: 'keep', sel: { items: [{ mode: 'add', shape, dx: 0, dy: 0 }] }, w: psd.width, h: psd.height, x0: layer.x, y0: layer.y }];
      }
      layers.push(layer);
    }
  };
  await walk(psd.children, null);
  // A flat PSD (no layer records) still has its composite image.
  if (!layers.length && psd.canvas) layers.push({ id: `L${id++}`, name: 'Image', type: 'image', ...(await store(await psd.canvas.encode('png'))), x: 0, y: 0, visible: true, opacity: 1, blend: 'normal' });
  return { width: psd.width, height: psd.height, layers, notes: [...notes] };
}

// ---- XCF (GIMP) ---------------------------------------------------------------------------------------------
// Export: groups, opacity, blend modes and visibility are kept; each layer's tone, filters and masks are baked
// into its pixels; clipped layers are baked to their base's shape (GIMP has no clipping masks); adjustment
// layers are left out. Import: layers (pixels), groups, layer masks, opacity, modes.
export async function toXcf(renderCanvas, dir, doc) {
  const skipped = [];
  const build = async pid => {
    const out = [], list = children(doc, pid);
    for (let i = 0; i < list.length; i++) {
      const l = list[i], common = { name: l.name, visible: l.visible, opacity: l.opacity, blend: l.blend };
      if (l.type === 'adjustment') { skipped.push(l.name); continue; }
      if (l.type === 'group') { out.push({ ...common, children: await build(l.id) }); continue; }
      const full = await soloCanvas(renderCanvas, dir, doc, l);
      if (l.clip) { // bake: keep only where the base (nearest unclipped sibling below) has pixels
        const base = list.slice(0, i).reverse().find(q => !q.clip);
        if (base) {
          const fc = full.getContext('2d');
          fc.globalCompositeOperation = 'destination-in';
          fc.drawImage(base.type === 'group' ? await renderCanvas(dir, { ...doc, background: null }, { only: [base.id], background: false }) : await soloCanvas(renderCanvas, dir, doc, base), 0, 0);
        }
      }
      const box = alphaBox(full);
      out.push(box ? { ...common, x: box[0], y: box[1], w: box[2], h: box[3], rgba: crop(full, box).getContext('2d').getImageData(0, 0, box[2], box[3]).data }
        : { ...common, x: 0, y: 0, w: 1, h: 1, rgba: new Uint8ClampedArray(4) });
    }
    return out.reverse(); // XCF lists layers top-first
  };
  const layers = await build(null);
  if (doc.background) {
    const bg = createCanvas(doc.width, doc.height), c = bg.getContext('2d');
    c.fillStyle = doc.background; c.fillRect(0, 0, doc.width, doc.height);
    layers.push({ name: 'Background', x: 0, y: 0, w: doc.width, h: doc.height, rgba: c.getImageData(0, 0, doc.width, doc.height).data });
  }
  return { buffer: writeXcf({ width: doc.width, height: doc.height, layers }), skipped };
}

export async function fromXcf(buffer, { nextId, store, maskShape }) {
  const x = readXcf(buffer), out = [], byPath = new Map();
  let id = nextId;
  // XCF order is top-first, a group followed by its children; ours is bottom-first per parent.
  const entries = x.layers.map((l, k) => ({ l, k, path: l.path ?? [null] }));
  let top = 0;
  for (const e of entries) if (!e.l.path) e.path = [top++];
  const kids = new Map();
  for (const e of entries) {
    const key = JSON.stringify(e.path.slice(0, -1));
    if (!kids.has(key)) kids.set(key, []);
    kids.get(key).push(e);
  }
  const walk = async (pathKey, parent) => {
    for (const e of (kids.get(pathKey) || []).slice().reverse()) {
      const l = e.l, common = { id: `L${id++}`, name: l.name || 'Layer', visible: l.visible, opacity: l.opacity, blend: l.blend, ...(parent ? { parent } : {}) };
      if (l.group) { out.push({ ...common, type: 'group' }); await walk(JSON.stringify(e.path), common.id); continue; }
      const c = createCanvas(l.w, l.h);
      c.getContext('2d').putImageData(new ImageData(l.rgba, l.w, l.h), 0, 0);
      const layer = { ...common, type: 'image', ...(await store(await c.encode('png'))), x: l.x, y: l.y };
      if (l.mask) { // GIMP masks are a gray channel the size of the layer
        const full = createCanvas(x.width, x.height), fc = full.getContext('2d'), img = fc.createImageData(x.width, x.height);
        for (let yy = 0; yy < l.mask.h; yy++) for (let xx = 0; xx < l.mask.w; xx++) {
          const X = l.x + xx, Y = l.y + yy;
          if (X >= 0 && Y >= 0 && X < x.width && Y < x.height) img.data.set([255, 255, 255, l.mask.data[yy * l.mask.w + xx]], (Y * x.width + X) * 4);
        }
        fc.putImageData(img, 0, 0);
        layer.mask = [{ mode: 'keep', sel: { items: [{ mode: 'add', shape: await maskShape(full, `GIMP mask of "${common.name}"`), dx: 0, dy: 0 }] }, w: x.width, h: x.height, x0: layer.x, y0: layer.y }];
      }
      out.push(layer);
    }
  };
  await walk(JSON.stringify([]), null);
  return { width: x.width, height: x.height, layers: out, notes: x.notes };
}

// ---- PDF export (one page with the flattened image) ----------------------------------------------------------
export function toPdf(canvas, { dpi = 72 } = {}) {
  const { width: w, height: h } = canvas, d = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  const rgb = Buffer.alloc(w * h * 3);
  for (let i = 0, j = 0; i < d.length; i += 4, j += 3) { // flatten onto white (PDF images here have no alpha)
    const a = d[i + 3] / 255;
    rgb[j] = Math.round(d[i] * a + 255 * (1 - a)); rgb[j + 1] = Math.round(d[i + 1] * a + 255 * (1 - a)); rgb[j + 2] = Math.round(d[i + 2] * a + 255 * (1 - a));
  }
  const img = zlib.deflateSync(rgb), pw = (w * 72) / dpi, ph = (h * 72) / dpi;
  const content = `q ${pw.toFixed(2)} 0 0 ${ph.toFixed(2)} 0 0 cm /Im0 Do Q`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw.toFixed(2)} ${ph.toFixed(2)}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`,
    [`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${img.length} >>\nstream\n`, img, '\nendstream'],
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'binary')], offsets = [];
  let len = parts[0].length;
  objs.forEach((o, i) => {
    offsets.push(len);
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), ...[o].flat().map(p => (Buffer.isBuffer(p) ? p : Buffer.from(p, 'binary'))), Buffer.from('\nendobj\n')]);
    parts.push(chunk); len += chunk.length;
  });
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
    + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${len}\n%%EOF\n`;
  parts.push(Buffer.from(xref));
  return Buffer.concat(parts);
}

// ---- SVG export -----------------------------------------------------------------------------------------------
// Shapes, text, fills and gradients become real SVG; everything else (images, paint, layers with tone/filters/
// masks, clipping stacks) is embedded as PNG. With adjustment layers in the document the whole image is embedded.
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const plainFilters = l => !l.adjust || Object.entries(l.adjust).every(([k, v]) => v === ({ brightness: 100, contrast: 100, saturate: 100 }[k] ?? 0));

export async function toSvg(renderCanvas, dir, doc) {
  const measure = createCanvas(1, 1).getContext('2d'), defs = [], notes = [];
  let gid = 0;
  const png = async canvas => `data:image/png;base64,${(await canvas.encode('png')).toString('base64')}`;
  const style = l => `${l.opacity !== 1 ? ` opacity="${l.opacity}"` : ''}${l.blend !== 'normal' ? ` style="mix-blend-mode:${l.blend}"` : ''}`;
  const raster = async (canvas, l) => {
    const box = alphaBox(canvas);
    return box ? `<image x="${box[0]}" y="${box[1]}" width="${box[2]}" height="${box[3]}"${l ? style(l) : ''} href="${await png(crop(canvas, box))}"/>` : '';
  };
  const vector = l => {
    const m = layerMatrix(l, layerSize(l, measure)).map(v => +v.toFixed(4)), t = `transform="matrix(${m.join(' ')})"`;
    if (l.type === 'shape') {
      const paint = `fill="${l.fill ?? 'none'}"${l.stroke ? ` stroke="${l.stroke}" stroke-width="${l.strokeWidth}"` : ''}`;
      return l.shape === 'ellipse' ? `<ellipse ${t} cx="${l.w / 2}" cy="${l.h / 2}" rx="${l.w / 2}" ry="${l.h / 2}" ${paint}${style(l)}/>`
        : `<rect ${t} width="${l.w}" height="${l.h}"${l.radius ? ` rx="${l.radius}"` : ''} ${paint}${style(l)}/>`;
    }
    if (l.type === 'fill') return `<rect ${t} width="${l.w}" height="${l.h}" fill="${l.color}"${style(l)}/>`;
    if (l.type === 'gradient') {
      const id = `g${gid++}`, stops = l.stops.map(([o, c], i) => {
        const transparent = c === 'transparent', col = transparent ? (l.stops[i ? i - 1 : i + 1]?.[1] ?? '#000') : c;
        return `<stop offset="${o}" stop-color="${col}"${transparent ? ' stop-opacity="0"' : ''}/>`;
      }).join('');
      defs.push(l.kind === 'radial'
        ? `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${l.x1}" cy="${l.y1}" r="${Math.hypot(l.x2 - l.x1, l.y2 - l.y1)}">${stops}</radialGradient>`
        : `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${l.x1}" y1="${l.y1}" x2="${l.x2}" y2="${l.y2}">${stops}</linearGradient>`);
      return `<rect ${t} width="${l.w}" height="${l.h}" fill="url(#${id})"${style(l)}/>`;
    }
    if (l.type === 'text' && l.path) return null; // text on a path: embedded as pixels
    if (l.type === 'text') {
      const { w } = layerSize(l, measure), lh = l.size * (l.lineHeight ?? LINE_HEIGHT);
      const anchor = { left: 'start', center: 'middle', right: 'end' }[l.align] ?? 'start', x = l.align === 'center' ? w / 2 : l.align === 'right' ? w : 0;
      const lines = textLines(l, measure).map((s, i) => `<tspan x="${x}" y="${i * lh}">${esc(s) || ' '}</tspan>`).join('');
      return `<text ${t} font-family="${esc(l.font)}" font-size="${l.size}" font-weight="${l.weight}"${l.italic ? ' font-style="italic"' : ''} fill="${l.color}" text-anchor="${anchor}" dominant-baseline="text-before-edge"${style(l)} xml:space="preserve">${lines}</text>`;
    }
    return null;
  };
  const body = [];
  if (doc.layers.some(l => l.type === 'adjustment')) {
    notes.push('adjustment layers present: embedded as one flattened image');
    body.push(await raster(await renderCanvas(dir, { ...doc, background: null }, { background: false })));
  } else {
    const walk = async pid => {
      const out = [], list = children(doc, pid);
      for (let i = 0; i < list.length; i++) {
        const l = list[i];
        if (l.clip && i > 0) continue;
        const clipped = [];
        for (let j = i + 1; j < list.length && list[j].clip; j++) clipped.push(list[j]);
        if (!l.visible) continue;
        if (l.type === 'group' && !clipped.length) { out.push(`<g${style(l)}>${(await walk(l.id)).join('')}</g>`); continue; }
        if (clipped.length) { // a clipping stack: embed it as one image
          const ids = [l.id, ...clipped.map(c => c.id)], solo = { ...doc, background: null, layers: doc.layers.map(q => (q.id === l.id ? { ...q, parent: undefined } : ids.includes(q.id) ? { ...q, parent: undefined } : q)) };
          out.push(await raster(await renderCanvas(dir, solo, { only: ids, background: false })));
          continue;
        }
        const v = !hasTone(l) && !l.mask?.length && !l.mesh && !l.liquify?.length && !l.distort && plainFilters(l) && vector(l);
        out.push(v || await raster(await soloCanvas(renderCanvas, dir, doc, l), l));
      }
      return out;
    };
    body.push(...(await walk(null)));
  }
  const bg = doc.background ? `<rect width="${doc.width}" height="${doc.height}" fill="${doc.background}"/>` : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${doc.width}" height="${doc.height}" viewBox="0 0 ${doc.width} ${doc.height}">`
    + `${defs.length ? `<defs>${defs.join('')}</defs>` : ''}${bg}${body.join('')}</svg>\n`;
  return { svg, notes };
}

export const readFileBuffer = p => fs.readFileSync(p);
export { paintOrder };
