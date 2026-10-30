// GIMP's native format, XCF (https://developer.gimp.org/core/standards/xcf/). Node only.
// Writer: XCF version 10 by default (3 and 11 for compatibility testing), 8-bit gamma RGBA layers, zlib (or RLE /
// raw) tiles, groups via PROP_GROUP_ITEM / PROP_ITEM_PATH.
// Reader: versions 0–11+ (32/64-bit pointers), none/RLE/zlib tiles, RGB / gray / indexed, 8-bit precision,
// layer masks, groups. Layers are listed top-first, a group directly followed by its children.
import zlib from 'node:zlib';

const PROP = { END: 0, COLORMAP: 1, OPACITY: 6, MODE: 7, VISIBLE: 8, LOCK_ALPHA: 10, APPLY_MASK: 11, OFFSETS: 15, COMPRESSION: 17,
  RESOLUTION: 19, GROUP_ITEM: 29, ITEM_PATH: 30, FLOAT_OPACITY: 33 };
const TILE = 64;

// GIMP layer modes (current numbers for XCF ≥ 9, legacy below) ↔ our blend modes.
const MODE_OUT = { normal: 28, multiply: 30, screen: 31, overlay: 23, difference: 32, darken: 35, lighten: 36, hue: 37, saturation: 38,
  color: 39, luminosity: 40, 'color-dodge': 42, 'color-burn': 43, 'hard-light': 44, 'soft-light': 45, exclusion: 57 };
const LEGACY_OUT = { normal: 0, multiply: 3, screen: 4, 'soft-light': 19, difference: 6, darken: 9, lighten: 10, hue: 11, saturation: 12,
  color: 13, luminosity: 14, 'color-dodge': 16, 'color-burn': 17, 'hard-light': 18 };
const MODE_IN = { 0: 'normal', 3: 'multiply', 4: 'screen', 5: 'soft-light', 6: 'difference', 9: 'darken', 10: 'lighten', 11: 'hue', 12: 'saturation',
  13: 'color', 14: 'luminosity', 16: 'color-dodge', 17: 'color-burn', 18: 'hard-light', 19: 'soft-light',
  ...Object.fromEntries(Object.entries(MODE_OUT).map(([k, v]) => [v, k])), 24: 'hue', 25: 'saturation', 26: 'color', 27: 'luminosity', 61: 'normal' };

// ---- writing -------------------------------------------------------------------------------------------------
class Writer {
  constructor(wide = false) { this.parts = []; this.size = 0; this.patches = []; this.wide = wide; }
  bytes(b) { this.parts.push(Buffer.from(b)); this.size += b.length; }
  u32(v) { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); this.bytes(b); }
  i32(v) { const b = Buffer.alloc(4); b.writeInt32BE(v | 0); this.bytes(b); }
  f32(v) { const b = Buffer.alloc(4); b.writeFloatBE(v); this.bytes(b); }
  str(s) { if (s == null) return this.u32(0); const b = Buffer.from(String(s), 'utf8'); this.u32(b.length + 1); this.bytes(b); this.bytes([0]); }
  ptr() { const at = this.size; if (this.wide) this.u32(0); this.u32(0); return this.wide ? at + 4 : at; } // placeholder (64-bit: high word 0)
  patch(at, value) { this.patches.push([at, value]); }
  nullPtr() { if (this.wide) this.u32(0); this.u32(0); } // a zero pointer, pointer-sized
  done() {
    const out = Buffer.concat(this.parts);
    for (const [at, v] of this.patches) out.writeUInt32BE(v >>> 0, at);
    return out;
  }
}

function prop(w, type, payload = []) {
  w.u32(type);
  const b = Buffer.concat(payload.map(([t, v]) => { const x = Buffer.alloc(4); t === 'f' ? x.writeFloatBE(v) : t === 'i' ? x.writeInt32BE(v) : x.writeUInt32BE(v >>> 0); return x; }));
  w.u32(b.length); w.bytes(b);
}

// RLE as GIMP writes it: each channel separately; runs (0–126: n+1 copies, 127: long run) and literals
// (129–255: 256−n bytes, 128: long literal).
function rle(tile, bpp) {
  const n = tile.length / bpp, out = [];
  for (let c = 0; c < bpp; c++) {
    const v = i => tile[i * bpp + c];
    for (let i = 0; i < n;) {
      let r = 1;
      while (i + r < n && r < 32768 && v(i + r) === v(i)) r++;
      if (r >= 3) {
        if (r <= 127) out.push(r - 1, v(i)); else out.push(127, r >> 8, r & 255, v(i));
        i += r;
        continue;
      }
      let l = 0; // literal until a run of 3 starts
      while (i + l < n && l < 32768 && !(i + l + 2 < n && v(i + l) === v(i + l + 1) && v(i + l) === v(i + l + 2))) l++;
      if (l <= 127) out.push(256 - l); else out.push(128, l >> 8, l & 255);
      for (let k = 0; k < l; k++) out.push(v(i + k));
      i += l;
    }
  }
  return Buffer.from(out);
}

// layers: tree, top-first: [{ name, visible, opacity, blend, x, y, w, h, rgba (Uint8 RGBA w×h) | null, children? }]
export function writeXcf({ width, height, layers }, { version = 10, compression = 'zlib' } = {}) {
  const w = new Writer(version >= 11), comp = { none: 0, rle: 1, zlib: 2 }[compression];
  if (comp === 2 && version < 8) throw new Error('zlib tiles need XCF 8 or later');
  w.bytes(Buffer.from(`gimp xcf v${String(version).padStart(3, '0')}\0`, 'binary'));
  w.u32(width); w.u32(height); w.u32(0);
  if (version >= 4) w.u32(version === 4 ? 0 : 150); // 8-bit gamma integer
  w.u32(PROP.COMPRESSION); w.u32(1); w.bytes([comp]);
  prop(w, PROP.RESOLUTION, [['f', 72], ['f', 72]]);
  prop(w, PROP.END);
  const flat = [];
  const walk = (list, path) => list.forEach((l, i) => { flat.push({ l, path: [...path, i] }); if (l.children) walk(l.children, [...path, i]); });
  walk(layers, []);
  const slots = flat.map(() => w.ptr());
  w.nullPtr(); // end of layers
  w.nullPtr(); // no channels
  flat.forEach(({ l, path }, k) => {
    w.patch(slots[k], w.size);
    const lw = l.children ? 1 : Math.max(1, l.w), lh = l.children ? 1 : Math.max(1, l.h);
    w.u32(lw); w.u32(lh); w.u32(1); w.str(l.name || 'Layer'); // RGBA
    prop(w, PROP.OPACITY, [['u', Math.round((l.opacity ?? 1) * 255)]]);
    prop(w, PROP.FLOAT_OPACITY, [['f', l.opacity ?? 1]]);
    prop(w, PROP.VISIBLE, [['u', l.visible === false ? 0 : 1]]);
    prop(w, PROP.OFFSETS, [['i', Math.round(l.x || 0)], ['i', Math.round(l.y || 0)]]);
    prop(w, PROP.MODE, [['u', version >= 9 ? MODE_OUT[l.blend] ?? 28 : LEGACY_OUT[l.blend] ?? 0]]);
    if (l.children) prop(w, PROP.GROUP_ITEM);
    if (path.length > 1) prop(w, PROP.ITEM_PATH, path.map(i => ['u', i]));
    prop(w, PROP.END);
    const hptr = w.ptr();
    w.nullPtr(); // no mask
    // hierarchy → level → zlib tiles
    w.patch(hptr, w.size);
    w.u32(lw); w.u32(lh); w.u32(4);
    const lptr = w.ptr();
    w.u32(0); // no dummy levels (their pointers are always 32-bit)
    w.patch(lptr, w.size);
    w.u32(lw); w.u32(lh);
    const tx = Math.ceil(lw / TILE), ty = Math.ceil(lh / TILE), tptrs = [];
    for (let i = 0; i < tx * ty; i++) tptrs.push(w.ptr());
    w.nullPtr();
    const rgba = l.children || !l.rgba ? new Uint8Array(lw * lh * 4) : l.rgba;
    for (let j = 0; j < ty; j++) for (let i = 0; i < tx; i++) {
      const x0 = i * TILE, y0 = j * TILE, tw = Math.min(TILE, lw - x0), th = Math.min(TILE, lh - y0), tile = Buffer.alloc(tw * th * 4);
      for (let y = 0; y < th; y++) tile.set(rgba.subarray(((y0 + y) * lw + x0) * 4, ((y0 + y) * lw + x0 + tw) * 4), y * tw * 4);
      w.patch(tptrs[j * tx + i], w.size);
      w.bytes(comp === 2 ? zlib.deflateSync(tile) : comp === 1 ? rle(tile, 4) : tile);
    }
  });
  return w.done();
}

// ---- reading -------------------------------------------------------------------------------------------------
export function readXcf(buf) {
  if (buf.toString('latin1', 0, 9) !== 'gimp xcf ') throw new Error('Not an XCF file');
  const tag = buf.toString('latin1', 9, 13), version = tag === 'file' ? 0 : Number(tag.slice(1));
  if (!Number.isFinite(version)) throw new Error(`Unknown XCF version "${tag}"`);
  let p = 14;
  const u32 = () => { const v = buf.readUInt32BE(p); p += 4; return v; };
  const i32 = () => { const v = buf.readInt32BE(p); p += 4; return v; };
  const f32 = () => { const v = buf.readFloatBE(p); p += 4; return v; };
  const ptr = () => { if (version >= 11) { const v = Number(buf.readBigUInt64BE(p)); p += 8; return v; } return u32(); };
  const str = () => { const n = u32(); if (!n) return ''; const s = buf.toString('utf8', p, p + n - 1); p += n; return s; };
  const width = u32(), height = u32(), baseType = u32();
  const notes = new Set();
  if (version >= 4) {
    const precision = u32(), gamma8 = version === 4 ? [0] : [150], linear8 = version === 4 ? [] : [100];
    if (linear8.includes(precision)) notes.add('8-bit linear colors were read as-is');
    else if (!gamma8.includes(precision)) throw new Error('Only 8-bit XCF files are supported (in GIMP: Image → Precision → 8 bit integer, then save)');
  }
  if (baseType > 2) throw new Error(`Unsupported XCF color mode ${baseType}`);
  let compression = 0, colormap = null;
  const readProps = onProp => {
    for (;;) {
      const type = u32(), len = u32(), end = p + len;
      if (type === PROP.END) return;
      if (type === PROP.COLORMAP) { // some old files wrote a wrong length: trust the count
        const n = u32(); colormap = []; for (let i = 0; i < n; i++) { colormap.push([buf[p], buf[p + 1], buf[p + 2]]); p += 3; }
        continue;
      }
      onProp(type, len);
      p = end;
    }
  };
  readProps(type => { if (type === PROP.COMPRESSION) compression = buf[p]; });
  if (compression > 2) throw new Error(`Unsupported XCF tile compression ${compression}`);
  const layerPtrs = [];
  for (let q; (q = ptr());) layerPtrs.push(q);

  // A hierarchy → RGBA (or, for masks, one value channel).
  const readPixels = (hptr, kind) => {
    p = hptr;
    const w = u32(), h = u32(), bpp = u32(), lptr = ptr();
    p = lptr;
    const lw = u32(), lh = u32(), tx = Math.ceil(lw / TILE), ty = Math.ceil(lh / TILE), tiles = [];
    for (let i = 0; i < tx * ty; i++) tiles.push(ptr());
    const raw = new Uint8Array(lw * lh * bpp);
    tiles.forEach((tp, k) => {
      const i = k % tx, j = Math.floor(k / tx), x0 = i * TILE, y0 = j * TILE, tw = Math.min(TILE, lw - x0), th = Math.min(TILE, lh - y0), n = tw * th;
      const next = tiles[k + 1] || buf.length;
      let px; // interleaved bytes of this tile
      if (compression === 2) px = zlib.inflateSync(buf.subarray(tp, next));
      else if (compression === 0) px = buf.subarray(tp, tp + n * bpp);
      else { // RLE, one stream per channel
        px = new Uint8Array(n * bpp);
        let q = tp;
        for (let c = 0; c < bpp; c++) {
          for (let o = 0; o < n;) {
            const op = buf[q++];
            if (op <= 126) { const v = buf[q++]; for (let r = 0; r <= op; r++) px[(o++) * bpp + c] = v; }
            else if (op === 127) { const cnt = buf[q] * 256 + buf[q + 1], v = buf[q + 2]; q += 3; for (let r = 0; r < cnt; r++) px[(o++) * bpp + c] = v; }
            else if (op === 128) { const cnt = buf[q] * 256 + buf[q + 1]; q += 2; for (let r = 0; r < cnt; r++) px[(o++) * bpp + c] = buf[q++]; }
            else { const cnt = 256 - op; for (let r = 0; r < cnt; r++) px[(o++) * bpp + c] = buf[q++]; }
          }
        }
      }
      for (let y = 0; y < th; y++) raw.set(px.subarray(y * tw * bpp, (y + 1) * tw * bpp), ((y0 + y) * lw + x0) * bpp);
    });
    if (kind === 'mask') return { w: lw, h: lh, data: raw };
    const rgba = new Uint8ClampedArray(lw * lh * 4);
    for (let i = 0; i < lw * lh; i++) {
      const s = raw.subarray(i * bpp, i * bpp + bpp);
      let r, g, b, a = 255;
      if (baseType === 0) { [r, g, b] = s; if (bpp === 4) a = s[3]; }
      else if (baseType === 1) { r = g = b = s[0]; if (bpp === 2) a = s[1]; }
      else { [r, g, b] = colormap?.[s[0]] ?? [0, 0, 0]; if (bpp === 2) a = s[1]; }
      rgba.set([r, g, b, a], i * 4);
    }
    return { w: lw, h: lh, rgba };
  };

  const layers = layerPtrs.map(lp => {
    p = lp;
    const w = u32(), h = u32(), type = u32(), name = str();
    const l = { name, w, h, x: 0, y: 0, opacity: 1, visible: true, blend: 'normal', group: false, path: null, applyMask: true };
    let floatOpacity = null;
    readProps((t, len) => {
      if (t === PROP.OPACITY) l.opacity = buf.readUInt32BE(p) / 255;
      else if (t === PROP.FLOAT_OPACITY) floatOpacity = buf.readFloatBE(p);
      else if (t === PROP.VISIBLE) l.visible = !!buf.readUInt32BE(p);
      else if (t === PROP.OFFSETS) { l.x = buf.readInt32BE(p); l.y = buf.readInt32BE(p + 4); }
      else if (t === PROP.MODE) { const m = buf.readUInt32BE(p); l.blend = MODE_IN[m] ?? 'normal'; if (!(m in MODE_IN)) notes.add(`layer mode ${m} shown as normal`); }
      else if (t === PROP.GROUP_ITEM) l.group = true;
      else if (t === PROP.ITEM_PATH) { l.path = []; for (let k = 0; k < len / 4; k++) l.path.push(buf.readUInt32BE(p + k * 4)); }
      else if (t === PROP.APPLY_MASK) l.applyMask = !!buf.readUInt32BE(p);
    });
    if (floatOpacity != null) l.opacity = floatOpacity;
    l.opacity = Math.round(l.opacity * 100) / 100;
    const hptr = ptr(), mptr = ptr();
    if (!l.group) Object.assign(l, readPixels(hptr));
    if (mptr && l.applyMask) {
      p = mptr;
      u32(); u32(); str();
      readProps(() => {});
      l.mask = readPixels(ptr(), 'mask');
    }
    if (type % 2 === 0 && !l.group) for (let i = 3; i < l.rgba.length; i += 4) l.rgba[i] = 255; // no alpha channel
    return l;
  });
  return { width, height, version, layers, notes: [...notes] };
}
