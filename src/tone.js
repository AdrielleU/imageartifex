// Tone adjustments applied to a layer's pixels: noise reduction, unsharp mask, high pass, shadows-highlights,
// exposure, levels, curves, color balance, hue-chroma, posterize, threshold, color to alpha (in that order). Shared by the browser and Node. Values are 0–255. Levels/curves have a
// "value" channel that affects r, g and b together, as in GIMP.

export const TONE_CHANNELS = ['value', 'r', 'g', 'b'];
export const LEVELS_DEFAULT = { inLow: 0, inHigh: 255, gamma: 1, outLow: 0, outHigh: 255 };
export const CURVE_PRESETS = {
  linear: [[0, 0], [255, 255]],
  's-curve': [[0, 0], [64, 44], [192, 212], [255, 255]],
  brighten: [[0, 0], [128, 168], [255, 255]],
  darken: [[0, 0], [128, 88], [255, 255]],
  invert: [[0, 255], [255, 0]],
};

export function levelsFn(levels) {
  const { inLow, inHigh, gamma, outLow, outHigh } = { ...LEVELS_DEFAULT, ...levels };
  return v => {
    const x = Math.min(1, Math.max(0, (v - inLow) / Math.max(1, inHigh - inLow)));
    return outLow + Math.pow(x, 1 / gamma) * (outHigh - outLow);
  };
}

// Monotone cubic (Fritsch–Carlson) through the control points: smooth, never overshoots.
export function curveFn(points) {
  const p = [...points].sort((a, b) => a[0] - b[0]).filter((q, i, a) => i === 0 || q[0] !== a[i - 1][0]);
  const n = p.length, xs = p.map(q => q[0]), ys = p.map(q => q[1]);
  if (n === 1) return () => ys[0];
  const m = xs.slice(0, -1).map((x, i) => (ys[i + 1] - ys[i]) / (xs[i + 1] - x));
  const t = xs.map((_, i) => (i === 0 ? m[0] : i === n - 1 ? m[n - 2] : m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2));
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = t[i + 1] = 0; continue; }
    const a = t[i] / m[i], b = t[i + 1] / m[i], s = a * a + b * b;
    if (s > 9) { const k = 3 / Math.sqrt(s); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; }
  }
  return v => {
    if (v <= xs[0]) return ys[0];
    if (v >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (v > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i], s = (v - xs[i]) / h, s2 = s * s, s3 = s2 * s;
    return (2 * s3 - 3 * s2 + 1) * ys[i] + (s3 - 2 * s2 + s) * h * t[i] + (-2 * s3 + 3 * s2) * ys[i + 1] + (s3 - s2) * h * t[i + 1];
  };
}

export const TONE_KEYS = ['denoise', 'sharpen', 'highPass', 'pixelate', 'emboss', 'shadowsHighlights', 'exposure', 'levels', 'curves', 'colorBalance', 'hueChroma', 'posterize', 'threshold', 'colorToAlpha'];
export const BALANCE_RANGES = ['shadows', 'midtones', 'highlights'];
export const BALANCE_AXES = ['cyanRed', 'magentaGreen', 'yellowBlue']; // shift r, g, b respectively
export const THRESHOLD_DEFAULT = { low: 127, high: 255, channel: 'value' };
// GIMP's Colors → Shadows-Highlights settings: name: [default, min, max].
export const SH_PARAMS = {
  shadows: [0, -100, 100], highlights: [0, -100, 100], whitepoint: [0, -10, 10], radius: [100, 0.1, 1500],
  compress: [50, 0, 100], shadowsColor: [100, 0, 100], highlightsColor: [50, 0, 100],
};
// GIMP's Colors → Exposure (stops = "Exposure", relative brightness in stops) and Colors → Hue-Chroma.
export const EXPOSURE_PARAMS = { stops: [0, -10, 10], blackLevel: [0, -0.1, 0.1] };
export const HC_PARAMS = { hue: [0, -180, 180], chroma: [0, -100, 100], lightness: [0, -100, 100] };
// Adjustments that are a flat set of numeric settings: prop → { name: [default, min, max] }.
// Filters (spatial): GIMP's Unsharp Mask (radius px, amount ×, threshold 0–255), noise reduction (edge-preserving
// guided filter: strength 0–100, radius px), and high pass (radius px).
export const SHARPEN_PARAMS = { radius: [3, 0.1, 100], amount: [0.5, 0, 10], threshold: [0, 0, 255] };
export const DENOISE_PARAMS = { strength: [30, 0, 100], radius: [2, 1, 10] };
export const HIGHPASS_PARAMS = { radius: [4, 0.5, 100] };
// GIMP Pixelize (square blocks, px) and Emboss (light azimuth/elevation in degrees, depth; keepColor 1 = bump map).
export const PIXELATE_PARAMS = { size: [16, 1, 512] };
export const EMBOSS_PARAMS = { azimuth: [30, 0, 360], elevation: [45, 0, 180], depth: [20, 1, 100], keepColor: [0, 0, 1] };
export const PARAM_SETS = { shadowsHighlights: SH_PARAMS, exposure: EXPOSURE_PARAMS, hueChroma: HC_PARAMS, sharpen: SHARPEN_PARAMS, denoise: DENOISE_PARAMS, highPass: HIGHPASS_PARAMS,
  pixelate: PIXELATE_PARAMS, emboss: EMBOSS_PARAMS };
export const paramDefaults = params => Object.fromEntries(Object.entries(params).map(([k, [d]]) => [k, d]));
export const SH_DEFAULT = paramDefaults(SH_PARAMS);
// GIMP's Colors → Color to Alpha: thresholds are 0–1 distances from the color.
export const C2A_DEFAULT = { color: '#ffffff', transparency: 0, opacity: 1 };

const nonEmpty = o => !!(o && Object.keys(o).length);
export const hasTone = l => !!(nonEmpty(l.levels) || nonEmpty(l.curves) || hasBalance(l.colorBalance) || l.posterize || l.threshold
  || l.shadowsHighlights || l.exposure || l.hueChroma || l.colorToAlpha || l.sharpen || l.denoise || l.highPass || l.pixelate || l.emboss);
export const withoutTone = l => ({ ...l, ...Object.fromEntries(TONE_KEYS.map(k => [k, undefined])) });
const hasBalance = cb => !!cb && BALANCE_RANGES.some(r => BALANCE_AXES.some(a => cb[r]?.[a]));

// Color balance, GIMP's formula: the range weights come from the pixel's HSL lightness L (0–1) as
// overlapping ramps (shadows < ~0.46, midtones ~0.21–0.79, highlights > ~0.54) that sum to 1, scaled
// by 0.7; each channel moves by slider/100 × weight (full scale). Precomputed per (max+min) = 0..510.
const BAL_A = 0.25, BAL_B = 0.333, BAL_SCALE = 0.7;
const clamp01 = x => Math.min(1, Math.max(0, x));
export function balanceWeights(L) {
  return {
    shadows: clamp01((L - BAL_B) / -BAL_A + 0.5) * BAL_SCALE,
    midtones: clamp01((L - BAL_B) / BAL_A + 0.5) * clamp01((L + BAL_B - 1) / -BAL_A + 0.5) * BAL_SCALE,
    highlights: clamp01((L + BAL_B - 1) / BAL_A + 0.5) * BAL_SCALE,
  };
}
function balanceTables(cb) {
  const t = BALANCE_AXES.map(() => new Float32Array(511));
  for (let s = 0; s <= 510; s++) {
    const w = balanceWeights(s / 510);
    BALANCE_AXES.forEach((axis, i) => {
      for (const r of BALANCE_RANGES) t[i][s] += ((cb[r]?.[axis] || 0) / 100) * w[r] * 255;
    });
  }
  return t;
}

// Exposure, GIMP's formula on linear light: (v − black level) / (2^−stops − black level).
function exposureFn({ stops = 0, blackLevel = 0 }) {
  const gain = 1 / Math.max(2 ** -stops - blackLevel, 0.000001);
  return v => 255 * gamma(Math.min(1, Math.max(0, (LIN[Math.round(v)] - blackLevel) * gain)));
}

const posterizeFn = n => v => Math.round(Math.round((v / 255) * (n - 1)) * (255 / (n - 1)));

function lut(fns) {
  const t = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) t[v] = Math.round(fns.reduce((x, f) => f(x), v));
  return t;
}

// Compile a layer's adjustments into lookup tables plus the per-pixel steps (color balance, threshold).
export function toneProgram(layer) {
  const cb = hasBalance(layer.colorBalance) ? layer.colorBalance : null;
  const stages = ['r', 'g', 'b'].map(c => {
    const pre = layer.exposure ? [exposureFn(layer.exposure)] : [];
    if (layer.levels?.[c]) pre.push(levelsFn(layer.levels[c]));
    if (layer.levels?.value) pre.push(levelsFn(layer.levels.value));
    if (layer.curves?.[c]) pre.push(curveFn(layer.curves[c]));
    if (layer.curves?.value) pre.push(curveFn(layer.curves.value));
    const post = layer.posterize ? [posterizeFn(layer.posterize)] : [];
    return { pre, post };
  });
  return {
    // Without color balance / hue-chroma every LUT step folds into one table per channel.
    all: stages.map(s => lut([...s.pre, ...s.post])),
    pre: stages.map(s => lut(s.pre)), post: stages.map(s => lut(s.post)),
    balance: cb && { shift: balanceTables(cb), preserve: cb.preserveLuminosity !== false },
    threshold: layer.threshold ? { ...THRESHOLD_DEFAULT, ...layer.threshold } : null,
    sh: layer.shadowsHighlights ? { ...SH_DEFAULT, ...layer.shadowsHighlights } : null,
    denoise: layer.denoise ? { ...paramDefaults(DENOISE_PARAMS), ...layer.denoise } : null,
    unsharp: layer.sharpen ? { ...paramDefaults(SHARPEN_PARAMS), ...layer.sharpen } : null,
    highpass: layer.highPass ? { ...paramDefaults(HIGHPASS_PARAMS), ...layer.highPass } : null,
    pixelate: layer.pixelate ? { ...paramDefaults(PIXELATE_PARAMS), ...layer.pixelate } : null,
    emboss: layer.emboss ? { ...paramDefaults(EMBOSS_PARAMS), ...layer.emboss } : null,
    hc: layer.hueChroma ? { ...paramDefaults(HC_PARAMS), ...layer.hueChroma } : null,
    c2a: layer.colorToAlpha ? { ...C2A_DEFAULT, ...layer.colorToAlpha, rgb: hexRgb(layer.colorToAlpha.color ?? C2A_DEFAULT.color) } : null,
  };
}

// The combined per-channel LUT (ignores per-pixel steps).
export const toneLUTs = layer => toneProgram(layer).all;

// HSL helpers on 0–255 values (h in 0–1), used to put back the original lightness like GIMP does.
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
function hslToRgb(h, s, l) {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = t => {
    t = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    return 255 * (t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p);
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}

export function applyTone(imageData, prog) {
  if (prog.denoise) denoise(imageData, prog.denoise);
  if (prog.unsharp) unsharp(imageData, prog.unsharp);
  if (prog.highpass) highPass(imageData, prog.highpass);
  if (prog.pixelate) pixelate(imageData, prog.pixelate);
  if (prog.emboss) emboss(imageData, prog.emboss);
  if (prog.sh) shadowsHighlights(imageData, prog.sh);
  const d = imageData.data, t = prog.threshold, bal = prog.balance, hc = prog.hc, c2a = prog.c2a, ci = { r: 0, g: 1, b: 2 }[t?.channel];
  const [ar, ag, ab] = prog.all, [pr, pg, pb] = prog.pre, [qr, qg, qb] = prog.post;
  const cl = v => Math.min(255, Math.max(0, v));
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    let r, g, b;
    if (!bal && !hc) { r = ar[d[i]]; g = ag[d[i + 1]]; b = ab[d[i + 2]]; }
    else {
      r = pr[d[i]]; g = pg[d[i + 1]]; b = pb[d[i + 2]];
      if (bal) {
        const s = Math.max(r, g, b) + Math.min(r, g, b);
        r = cl(r + bal.shift[0][s]); g = cl(g + bal.shift[1][s]); b = cl(b + bal.shift[2][s]);
        if (bal.preserve) { const [h, sat] = rgbToHsl(r, g, b); [r, g, b] = hslToRgb(h, sat, s / 510); }
      }
      if (hc) [r, g, b] = hueChroma(Math.round(r), Math.round(g), Math.round(b), hc);
      r = qr[Math.round(r)]; g = qg[Math.round(g)]; b = qb[Math.round(b)];
    }
    if (t) {
      const v = ci === undefined ? Math.max(r, g, b) : [r, g, b][ci];
      r = g = b = v >= t.low && v <= t.high ? 255 : 0;
    }
    if (c2a) {
      const px = [r / 255, g / 255, b / 255], a = colorToAlpha(px, c2a);
      d[i + 3] = Math.round(d[i + 3] * a);
      [r, g, b] = px.map(v => Math.round(v * 255));
    }
    d[i] = r; d[i + 1] = g; d[i + 2] = b;
  }
  return imageData;
}

export const hexRgb = hex => {
  const h = hex.replace('#', ''), f = h.length === 3 ? [...h].map(c => c + c).join('') : h.slice(0, 6);
  return [0, 2, 4].map(i => parseInt(f.slice(i, i + 2), 16) / 255);
};

// Color to alpha, GIMP's (GEGL) formula on gamma-encoded 0–1 values: alpha is the largest per-channel
// distance from the color, ramped between the transparency and opacity thresholds; the color is then
// un-mixed so compositing it over the removed color gives back the original. Mutates px, returns alpha.
export function colorToAlpha(px, { rgb, transparency: tt, opacity: ot }) {
  const EPS = 0.00001;
  let alpha = 0, dist = 0;
  for (let i = 0; i < 3; i++) {
    const d = Math.abs(px[i] - rgb[i]);
    const a = d < tt + EPS ? 0 : d > ot - EPS ? 1
      : (d - tt) / (Math.min(ot, px[i] < rgb[i] ? rgb[i] : 1 - rgb[i]) - tt);
    if (a > alpha) { alpha = a; dist = d; }
  }
  if (alpha > EPS) {
    const ratio = tt / dist, inv = 1 / alpha;
    for (let i = 0; i < 3; i++) {
      const c = rgb[i] + (px[i] - rgb[i]) * ratio;
      px[i] = Math.min(1, Math.max(0, c + (px[i] - c) * inv));
    }
  }
  return Math.min(1, alpha);
}

// sRGB ↔ CIE Lab (D50, Bradford-adapted sRGB matrices, as babl uses).
const LIN = Float32Array.from({ length: 256 }, (_, v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
const gamma = c => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const LAB_E = 216 / 24389, LAB_K = 24389 / 27, XN = 0.96420, ZN = 0.82491;
const labF = t => (t > LAB_E ? Math.cbrt(t) : (LAB_K * t + 16) / 116);
const labFInv = f => (f ** 3 > LAB_E ? f ** 3 : (116 * f - 16) / LAB_K);
const lumY = (r, g, b) => 0.2225045 * r + 0.7168786 * g + 0.0606169 * b; // linear, D50
const labL = Y => 116 * labF(Y) - 16;
function toLab(r8, g8, b8) {
  const r = LIN[r8], g = LIN[g8], b = LIN[b8];
  const fx = labF((0.4360747 * r + 0.3850649 * g + 0.1430804 * b) / XN), fy = labF(lumY(r, g, b));
  const fz = labF((0.0139322 * r + 0.0971045 * g + 0.7141733 * b) / ZN);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
function fromLab(L, a, b) {
  const fy = (L + 16) / 116, X = XN * labFInv(fy + a / 500), Y = L > LAB_K * LAB_E ? fy ** 3 : L / LAB_K, Z = ZN * labFInv(fy - b / 200);
  return [3.1338561 * X - 1.6168667 * Y - 0.4906146 * Z, -0.9787684 * X + 1.9161415 * Y + 0.0334540 * Z,
    0.0719453 * X - 0.2289914 * Y + 1.4052427 * Z].map(c => 255 * gamma(Math.min(1, Math.max(0, c))));
}

// Hue-chroma, GIMP's formula in CIE LCh(ab): add to lightness, chroma (kept within 0–300) and hue
// (degrees); grays (chroma ≈ 0) keep their hue and chroma.
function hueChroma(r8, g8, b8, { hue, chroma, lightness }) {
  const [L, A, B] = toLab(r8, g8, b8);
  let C = Math.hypot(A, B), H = Math.atan2(B, A);
  if (C > 1e-4) { C += chroma; H += (hue * Math.PI) / 180; }
  C = Math.min(300, Math.max(0, C));
  return fromLab(L + lightness, C * Math.cos(H), C * Math.sin(H));
}

// Gaussian blur (three box passes) of a w×h float buffer in place; edges are clamped.
function blur(buf, w, h, sigma) {
  if (sigma < 0.5) return;
  const n = 3, wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal); if (wl % 2 === 0) wl--;
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  const tmp = new Float32Array(Math.max(w, h)), line = new Float32Array(Math.max(w, h));
  const pass = (len, count, at) => {
    for (const r of [0, 1, 2].map(i => ((i < m ? wl : wl + 2) - 1) / 2)) {
      for (let k = 0; k < count; k++) {
        for (let i = 0; i < len; i++) line[i] = buf[at(k, i)];
        // window [i - r, i + r] with indices clamped to the edges
        const c = j => line[Math.min(Math.max(j, 0), len - 1)];
        let sum = 0;
        for (let j = -r; j <= r; j++) sum += c(j);
        for (let i = 0; i < len; i++) {
          if (i) sum += c(i + r) - c(i - r - 1);
          tmp[i] = sum / (2 * r + 1);
        }
        for (let i = 0; i < len; i++) buf[at(k, i)] = tmp[i];
      }
    }
  };
  pass(w, h, (y, x) => y * w + x);
  pass(h, w, (x, y) => y * w + x);
}

// ---- Spatial filters (per channel, edges clamped; fully transparent pixels are left alone) ----

function channels(imageData) {
  const { width: w, height: h, data: d } = imageData, n = w * h;
  return [0, 1, 2].map(c => { const a = new Float32Array(n); for (let p = 0; p < n; p++) a[p] = d[p * 4 + c]; return a; });
}
function writeBack(imageData, chans) {
  const d = imageData.data, n = imageData.width * imageData.height;
  for (let p = 0; p < n; p++) if (d[p * 4 + 3]) for (let c = 0; c < 3; c++) d[p * 4 + c] = Math.round(Math.min(255, Math.max(0, chans[c][p])));
}
const blurred = (a, w, h, sigma) => { const b = Float32Array.from(a); blur(b, w, h, sigma); return b; };

// Box mean over a (2r+1)² window, edges clamped (two sliding passes).
function boxMean(a, w, h, r) {
  const tmp = new Float32Array(a.length), out = new Float32Array(a.length), k = 2 * r + 1;
  const pass = (src, dst, len, count, idx) => {
    for (let q = 0; q < count; q++) {
      const at = i => src[idx(q, Math.min(Math.max(i, 0), len - 1))];
      let sum = 0;
      for (let i = -r; i <= r; i++) sum += at(i);
      for (let i = 0; i < len; i++) { if (i) sum += at(i + r) - at(i - r - 1); dst[idx(q, i)] = sum / k; }
    }
  };
  pass(a, tmp, w, h, (y, x) => y * w + x);
  pass(tmp, out, h, w, (x, y) => y * w + x);
  return out;
}

// GIMP Unsharp Mask: add back amount × (detail), where |detail| is above the threshold.
export function unsharp(imageData, { radius, amount, threshold }) {
  const { width: w, height: h } = imageData, chans = channels(imageData);
  writeBack(imageData, chans.map(a => {
    const b = blurred(a, w, h, radius);
    return a.map((v, p) => { const diff = v - b[p]; return Math.abs(diff) * 2 < threshold ? v : v + amount * diff; });
  }));
  return imageData;
}

// Noise reduction: a self-guided filter (He et al.) — smooths flat areas, keeps edges. strength sets how big a
// variation still counts as noise; radius the neighbourhood.
export function denoise(imageData, { strength, radius }) {
  const { width: w, height: h } = imageData, eps = (strength * 0.6) ** 2, r = Math.round(radius);
  writeBack(imageData, channels(imageData).map(I => {
    const mean = boxMean(I, w, h, r), corr = boxMean(I.map(v => v * v), w, h, r);
    const a = new Float32Array(I.length), b = new Float32Array(I.length);
    for (let p = 0; p < I.length; p++) { const v = corr[p] - mean[p] * mean[p]; a[p] = v / (v + eps); b[p] = mean[p] - a[p] * mean[p]; }
    const ma = boxMean(a, w, h, r), mb = boxMean(b, w, h, r);
    return I.map((v, p) => ma[p] * v + mb[p]);
  }));
  return imageData;
}

// High pass: the detail only, around mid-gray (put the layer in overlay / soft-light mode to sharpen).
export function highPass(imageData, { radius }) {
  const { width: w, height: h } = imageData;
  writeBack(imageData, channels(imageData).map(a => { const b = blurred(a, w, h, radius); return a.map((v, p) => v - b[p] + 128); }));
  return imageData;
}

// GIMP Pixelize: each size×size block becomes the average color (alpha-weighted) of its non-empty pixels.
export function pixelate(imageData, { size }) {
  const { width: w, height: h, data: d } = imageData, n = Math.max(1, Math.round(size));
  for (let by = 0; by < h; by += n) for (let bx = 0; bx < w; bx += n) {
    let r = 0, g = 0, b = 0, a = 0, c = 0;
    for (let y = by; y < Math.min(h, by + n); y++) for (let x = bx; x < Math.min(w, bx + n); x++) {
      const i = (y * w + x) * 4, al = d[i + 3];
      if (!al) continue; // empty margin around the layer: not part of the block's color or opacity
      r += d[i] * al; g += d[i + 1] * al; b += d[i + 2] * al; a += al; c++;
    }
    const out = a ? [r / a, g / a, b / a, a / c] : [0, 0, 0, 0];
    for (let y = by; y < Math.min(h, by + n); y++) for (let x = bx; x < Math.min(w, bx + n); x++) d.set(out.map(Math.round), (y * w + x) * 4);
  }
  return imageData;
}

// GIMP Emboss (GEGL formula): a distant light (azimuth, elevation) shades the surface whose height is the
// alpha-weighted sum of the color channels; depth sharpens the relief. Gray result, or colors × shade (bump map).
export function emboss(imageData, { azimuth, elevation, depth, keepColor }) {
  const { width: w, height: h, data: d } = imageData, src = Float32Array.from(d, v => v / 255);
  const az = (azimuth * Math.PI) / 180, el = (elevation * Math.PI) / 180;
  const Lx = Math.cos(az) * Math.cos(el), Ly = Math.sin(az) * Math.cos(el), Lz = Math.sin(el), Nz = 1 / depth, Nz2 = Nz * Nz, NzLz = Nz * Lz;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      const yy = y + i - 1, xx = x + j - 1;
      if (yy < 0 || xx < 0 || yy >= h || xx >= w) continue;
      const k = (yy * w + xx) * 4, a = src[k + 3];
      M[i][j] = a * (src[k] + src[k + 1] + src[k + 2]);
    }
    const Nx = M[0][0] + M[1][0] + M[2][0] - M[0][2] - M[1][2] - M[2][2], Ny = M[2][0] + M[2][1] + M[2][2] - M[0][0] - M[0][1] - M[0][2];
    let shade;
    if (Nx === 0 && Ny === 0) shade = Lz;
    else { const NdotL = Nx * Lx + Ny * Ly + NzLz; shade = NdotL < 0 ? 0 : NdotL / Math.sqrt(Nx * Nx + Ny * Ny + Nz2); }
    const o = (y * w + x) * 4;
    if (keepColor >= 0.5) for (let c = 0; c < 3; c++) d[o + c] = Math.round(src[o + c] * shade * 255);
    else d[o] = d[o + 1] = d[o + 2] = Math.round(shade * 255);
  }
  return imageData;
}

// Shadows-highlights, GIMP's (GEGL) formula: works in CIE Lab against a Gaussian-blurred lightness
// mask (std-dev = radius px); shadows/highlights are overlay-blended toward the inverted mask in
// up to two passes each, with "compress" protecting midtones and the color settings scaling a/b.
export function shadowsHighlights(imageData, o) {
  const { width: w, height: h, data: d } = imageData, n = w * h;
  const ya = new Float32Array(n), al = new Float32Array(n);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const a = d[i + 3] / 255;
    ya[p] = lumY(LIN[d[i]], LIN[d[i + 1]], LIN[d[i + 2]]) * a; al[p] = a;
  }
  blur(ya, w, h, o.radius); blur(al, w, h, o.radius);

  const compress = Math.min(o.compress / 100, 0.99), whitepoint = 1 - o.whitepoint / 100;
  const hl = 2 * (o.highlights / 100), hlSign = -Math.sign(hl) || -1;
  const hlColor = (o.highlightsColor / 100 - 0.5) * hlSign + 0.5;
  const sh = 2 * (o.shadows / 100), shSign = Math.sign(sh) || 1;
  const shColor = (o.shadowsColor / 100 - 0.5) * shSign + 0.5;
  const LOW = 0.01, sgn = v => (v > 0 ? 1 : v < 0 ? -1 : 0);
  // One overlay pass toward the mask; colorWeight picks how chroma follows the lightness change.
  const step = (ta, tb0, sign, optrans, colorWeight, flip) => {
    const la = ta[0], inv = 1 - la, lb = (tb0 - 0.5) * sign * sgn(inv) + 0.5;
    const lref = Math.sign(la || 1) / Math.max(Math.abs(la), LOW), href = Math.sign(inv || 1) / Math.max(Math.abs(inv), LOW);
    ta[0] = la * (1 - optrans) + (la > 0.5 ? 1 - (1 - 2 * (la - 0.5)) * (1 - lb) : 2 * la * lb) * optrans;
    const cw = flip ? 1 - colorWeight : colorWeight;
    const k = (1 - optrans) + (ta[0] * lref * cw + (1 - ta[0]) * href * (1 - cw)) * optrans;
    ta[1] *= k; ta[2] *= k;
  };

  for (let p = 0, i = 0; p < n; p++, i += 4) {
    if (d[i + 3] === 0) continue;
    const [L, A, B] = toLab(d[i], d[i + 1], d[i + 2]);
    const ta = [L / 100, A / 128, B / 128];
    let tb0 = (100 - labL(al[p] > 0 ? ya[p] / al[p] : 0)) / 100;
    if (ta[0] > 0) ta[0] /= whitepoint;
    if (tb0 > 0) tb0 /= whitepoint;
    if (tb0 < 1 - compress) {
      const xf = Math.min(1 - tb0 / (1 - compress), 1);
      for (let left = hl * hl; left > 0; left -= 1) step(ta, tb0, hlSign, Math.min(left, 1) * xf, hlColor, true);
    }
    if (tb0 > compress) {
      const xf = Math.min(tb0 / (1 - compress) - compress / (1 - compress), 1);
      for (let left = sh * sh; left > 0; left -= 1) step(ta, tb0, shSign, Math.min(left, 1) * xf, shColor, false);
    }
    const [r, g, b] = fromLab(ta[0] * 100, ta[1] * 128, ta[2] * 128);
    d[i] = Math.round(r); d[i + 1] = Math.round(g); d[i + 2] = Math.round(b);
  }
  return imageData;
}

// Dodge / burn, GIMP's formula on 0–1 values; exposure 0–100 (negated for burn). Per channel, so a LUT.
export const DODGE_RANGES = ['shadows', 'midtones', 'highlights'];
export function dodgeBurnLUT(kind, range = 'midtones', exposure = 50) {
  const e = (kind === 'burn' ? -1 : 1) * (exposure / 100), t = new Uint8ClampedArray(256);
  const f = {
    highlights: v => v * (1 + e / 3),
    midtones: v => v ** (e < 0 ? 1 - e / 3 : 1 / (1 + e)),
    shadows: v => { const k = Math.abs(e) / 3; return e >= 0 ? k + v - k * v : v < k ? 0 : (v - k) / (1 - k); },
  }[range];
  if (!f) throw new Error(`Unknown range "${range}" (expected ${DODGE_RANGES.join(', ')})`);
  for (let v = 0; v < 256; v++) t[v] = Math.round(255 * f(v / 255));
  return t;
}

// Histograms of visible pixels. value = max(r, g, b), as GIMP's Value channel.
export function histogram(imageData) {
  const d = imageData.data, h = { value: new Uint32Array(256), r: new Uint32Array(256), g: new Uint32Array(256), b: new Uint32Array(256) };
  let count = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    count++;
    h.r[d[i]]++; h.g[d[i + 1]]++; h.b[d[i + 2]]++;
    h.value[Math.max(d[i], d[i + 1], d[i + 2])]++;
  }
  return { ...h, count };
}

// Value at a percentile (0–1) of a histogram channel.
export function percentile(hist, count, p) {
  let acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > count * p) return v; }
  return 255;
}

export function histogramStats(h) {
  return Object.fromEntries(TONE_CHANNELS.map(c => {
    let sum = 0;
    for (let v = 0; v < 256; v++) sum += v * h[c][v];
    return [c, { min: percentile(h[c], h.count, 0), p1: percentile(h[c], h.count, 0.01), mean: h.count ? Math.round(sum / h.count) : 0,
      p99: percentile(h[c], h.count, 0.99), max: percentile(h[c], h.count, 0.99999) }];
  }));
}
