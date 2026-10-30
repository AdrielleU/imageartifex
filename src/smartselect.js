// Smart selections, shared by the browser (live preview) and Node (the ops):
// - Intelligent scissors (live-wire): the cheapest path between anchors over a cost map that is low on strong
//   edges, so the outline snaps to object boundaries.
// - Foreground select (a simplified SIOX, GIMP's old algorithm): color clusters for the object (painted strokes,
//   or the middle of the rough outline) and for the surroundings; pixels inside the outline go to the closer
//   model, then only regions connected to the object are kept, holes filled and the edge smoothed.

// Edge cost per pixel (0 on the strongest edges … 1 on flat areas), from the Sobel gradient of luminance.
export function edgeCost(rgba, w, h) {
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) lum[i] = (0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]) * (rgba[i * 4 + 3] / 255);
  const g = new Float32Array(w * h);
  let max = 1e-6;
  const L = (x, y) => lum[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const gx = L(x + 1, y - 1) + 2 * L(x + 1, y) + L(x + 1, y + 1) - L(x - 1, y - 1) - 2 * L(x - 1, y) - L(x - 1, y + 1);
    const gy = L(x - 1, y + 1) + 2 * L(x, y + 1) + L(x + 1, y + 1) - L(x - 1, y - 1) - 2 * L(x, y - 1) - L(x + 1, y - 1);
    const v = Math.hypot(gx, gy);
    g[y * w + x] = v;
    if (v > max) max = v;
  }
  return g.map(v => 1 - v / max);
}

// Cheapest 8-connected path from a to b ([x, y]), searching a box around both (margin px). Returns [[x, y], ...].
export function liveWire(cost, w, h, a, b, margin = 40) {
  const [ax, ay] = a.map(Math.round), [bx, by] = b.map(Math.round);
  const x0 = Math.max(0, Math.min(ax, bx) - margin), y0 = Math.max(0, Math.min(ay, by) - margin);
  const x1 = Math.min(w - 1, Math.max(ax, bx) + margin), y1 = Math.min(h - 1, Math.max(ay, by) + margin);
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1, n = bw * bh;
  const dist = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1), done = new Uint8Array(n);
  const idx = (x, y) => (y - y0) * bw + (x - x0);
  const heap = []; // binary heap of [d, i]
  const push = (d, i) => { heap.push([d, i]); let k = heap.length - 1; while (k) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; } };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) { heap[0] = last; let k = 0; for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m; } }
    return top;
  };
  const start = idx(ax, ay), goal = idx(bx, by);
  dist[start] = 0; push(0, start);
  while (heap.length) {
    const [d, i] = pop();
    if (done[i]) continue;
    done[i] = 1;
    if (i === goal) break;
    const x = (i % bw) + x0, y = Math.floor(i / bw) + y0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < x0 || ny < y0 || nx > x1 || ny > y1) continue;
      const j = idx(nx, ny);
      if (done[j]) continue;
      const nd = d + (0.05 + cost[ny * w + nx]) * (dx && dy ? Math.SQRT2 : 1);
      if (nd < dist[j]) { dist[j] = nd; prev[j] = i; push(nd, j); }
    }
  }
  const path = [];
  for (let i = goal; i !== -1; i = prev[i]) path.push([(i % bw) + x0, Math.floor(i / bw) + y0]);
  return path.reverse();
}

// The full scissors outline through the anchors (closed back to the first), thinned to every 2nd point.
export function scissorsOutline(cost, w, h, anchors) {
  const pts = [];
  for (let i = 0; i < anchors.length; i++) {
    const seg = liveWire(cost, w, h, anchors[i], anchors[(i + 1) % anchors.length]);
    pts.push(...(i ? seg.slice(1) : seg));
  }
  return pts.filter((_, i) => i % 2 === 0);
}

// ---- Foreground select ---------------------------------------------------------------------------------------
const lin = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const LIN = Float32Array.from({ length: 256 }, (_, v) => lin(v));
const fLab = t => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
function lab(r, g, b) {
  const R = LIN[r], G = LIN[g], B = LIN[b];
  const fx = fLab((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.9505), fy = fLab(0.2126 * R + 0.7152 * G + 0.0722 * B), fz = fLab((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.089);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function kmeans(samples, k, iters = 10) {
  if (!samples.length) return [];
  let s = 12345; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const centers = Array.from({ length: Math.min(k, samples.length) }, () => samples[Math.floor(rnd() * samples.length)].slice());
  for (let it = 0; it < iters; it++) {
    const sum = centers.map(() => [0, 0, 0, 0]);
    for (const p of samples) {
      let best = 0, bd = Infinity;
      centers.forEach((c, i) => { const d = (c[0] - p[0]) ** 2 + (c[1] - p[1]) ** 2 + (c[2] - p[2]) ** 2; if (d < bd) { bd = d; best = i; } });
      const t = sum[best]; t[0] += p[0]; t[1] += p[1]; t[2] += p[2]; t[3]++;
    }
    sum.forEach((t, i) => { if (t[3]) centers[i] = [t[0] / t[3], t[1] / t[3], t[2] / t[3]]; });
  }
  return centers;
}

// rgba: image; region: Uint8 (1 = inside the rough outline); fg: Uint8 painted object pixels or null.
// Returns a Uint8 mask (1 = selected).
export function foregroundMask(rgba, w, h, region, fg = null) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (region[y * w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const out = new Uint8Array(w * h);
  if (x1 < 0) return out;
  const pad = 12, X0 = Math.max(0, x0 - pad), Y0 = Math.max(0, y0 - pad), X1 = Math.min(w - 1, x1 + pad), Y1 = Math.min(h - 1, y1 + pad);
  const colorAt = i => lab(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
  // object samples: the painted strokes, else the core of the outline (the outline shrunk by 35% of its size)
  let core = fg;
  if (!core || !core.some(Boolean)) {
    const r = Math.max(2, Math.round(Math.min(x1 - x0, y1 - y0) * 0.35));
    core = new Uint8Array(w * h);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (!region[y * w + x]) continue;
      let inside = true;
      for (const [dx, dy] of [[r, 0], [-r, 0], [0, r], [0, -r], [r * 0.7, r * 0.7], [-r * 0.7, r * 0.7], [r * 0.7, -r * 0.7], [-r * 0.7, -r * 0.7]]) {
        const xx = Math.round(x + dx), yy = Math.round(y + dy);
        if (xx < 0 || yy < 0 || xx >= w || yy >= h || !region[yy * w + xx]) { inside = false; break; }
      }
      if (inside) core[y * w + x] = 1;
    }
    if (!core.some(Boolean)) core = region;
  }
  const fgS = [], bgS = [], step = Math.max(1, Math.floor(Math.sqrt(((X1 - X0 + 1) * (Y1 - Y0 + 1)) / 6000)));
  for (let y = Y0; y <= Y1; y += step) for (let x = X0; x <= X1; x += step) {
    const i = y * w + x;
    if (!rgba[i * 4 + 3]) continue;
    if (core[i]) fgS.push(colorAt(i)); else if (!region[i]) bgS.push(colorAt(i));
  }
  const near = (cs, c) => cs.reduce((m, k) => Math.min(m, (k[0] - c[0]) ** 2 + (k[1] - c[1]) ** 2 + (k[2] - c[2]) ** 2), Infinity);
  const B = kmeans(bgS, 6);
  // object samples that look like the background (the guess overlapped it) don't describe the object
  const clean = fg?.some?.(Boolean) ? fgS : fgS.filter(c => !B.length || near(B, c) > 12 ** 2); // (checked once)
  const F = kmeans(clean.length >= 20 ? clean : fgS, 6);
  const sel = new Uint8Array(w * h);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = y * w + x;
    if (!region[i]) continue;
    if (fg?.[i]) { sel[i] = 1; continue; }
    const c = colorAt(i);
    sel[i] = !B.length || near(F, c) <= near(B, c) ? 1 : 0;
  }
  // keep the parts connected to the object samples (or the biggest part)
  const painted = !!fg?.some?.(Boolean), seed = painted ? fg : core;
  const label = new Int32Array(w * h).fill(-1), sizes = [], touches = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const s0 = y * w + x;
    if (!sel[s0] || label[s0] >= 0) continue;
    const id = sizes.length, stack = [s0];
    label[s0] = id; sizes.push(0); touches.push(false);
    while (stack.length) {
      const i = stack.pop(); sizes[id]++;
      if (seed[i]) touches[id] = true;
      const xx = i % w, yy = (i - xx) / w;
      for (const [nx, ny] of [[xx + 1, yy], [xx - 1, yy], [xx, yy + 1], [xx, yy - 1]]) {
        if (nx < x0 || ny < y0 || nx > x1 || ny > y1) continue;
        const j = ny * w + nx;
        if (sel[j] && label[j] < 0) { label[j] = id; stack.push(j); }
      }
    }
  }
  const biggest = sizes.reduce((m, v) => Math.max(m, v), 0), keep = touches.some(Boolean) ? touches : sizes.map(v => v === biggest);
  for (let i = 0; i < w * h; i++) out[i] = label[i] >= 0 && keep[label[i]] ? 1 : 0;
  // fill holes: background not reachable from the box edge becomes selected
  const outside = new Uint8Array(w * h), stack = [];
  for (let x = X0; x <= X1; x++) stack.push(Y0 * w + x, Y1 * w + x);
  for (let y = Y0; y <= Y1; y++) stack.push(y * w + X0, y * w + X1);
  while (stack.length) {
    const i = stack.pop();
    if (outside[i] || out[i]) continue;
    outside[i] = 1;
    const xx = i % w, yy = (i - xx) / w;
    if (xx > X0) stack.push(i - 1); if (xx < X1) stack.push(i + 1); if (yy > Y0) stack.push(i - w); if (yy < Y1) stack.push(i + w);
  }
  for (let y = Y0; y <= Y1; y++) for (let x = X0; x <= X1; x++) { const i = y * w + x; if (!outside[i] && region[i]) out[i] = 1; }
  // smooth the edge: 3×3 majority, twice
  for (let pass = 0; pass < 2; pass++) {
    const copy = out.slice();
    for (let y = Math.max(1, y0); y <= Math.min(h - 2, y1); y++) for (let x = Math.max(1, x0); x <= Math.min(w - 2, x1); x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) n += copy[(y + dy) * w + x + dx];
      out[y * w + x] = region[y * w + x] && n >= 5 ? 1 : 0;
    }
  }
  return out;
}
