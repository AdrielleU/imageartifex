// Smudge, GIMP's method: an accumulator the size of the brush follows the stroke. At each dab
//   accum = rate·accum + (1 − rate)·pixels under the brush      (alpha-weighted)
//   paint = flow·color + (1 − flow)·accum                        (flow 0 = pure smudge)
// and the pixels under the brush are replaced by paint, weighted by the brush mask. Dabs are spaced at 10%
// of the brush size, as GIMP's default brush spacing.

// Alpha-weighted mix of two RGBA pixels (0–1 floats), written to out.
function blend(a, ai, wa, b, bi, wb, out, oi) {
  const aa = wa * a[ai + 3], ba = wb * b[bi + 3], ra = aa + ba;
  if (ra === 0) { out[oi] = out[oi + 1] = out[oi + 2] = out[oi + 3] = 0; return; }
  for (let c = 0; c < 3; c++) out[oi + c] = (a[ai + c] * aa + b[bi + c] * ba) / ra;
  out[oi + 3] = ra;
}

// Round brush, fully opaque up to hardness × radius, then a smooth falloff to the edge.
export function brushMask(size, hardness) {
  const n = Math.ceil(size) + 2, r = size / 2, m = new Float32Array(n * n), c = (n - 1) / 2;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const d = Math.hypot(x - c, y - c) / r;
    m[y * n + x] = d >= 1 ? 0 : d <= hardness ? 1 : 0.5 + 0.5 * Math.cos((Math.PI * (d - hardness)) / (1 - hardness));
  }
  return { n, m };
}

// Points along the stroke every `spacing` px (the first point always included).
export function dabs(points, spacing) {
  const out = [points[0]];
  let carry = 0;
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1], [x1, y1] = points[i], len = Math.hypot(x1 - x0, y1 - y0);
    let t = spacing - carry;
    for (; t <= len; t += spacing) out.push([x0 + ((x1 - x0) * t) / len, y0 + ((y1 - y0) * t) / len]);
    carry = len - (t - spacing);
  }
  return out;
}

// work: RGBA float (0–1) of a w×h region, smudged in place. limit: optional Float32Array (0–1) per pixel
// (the selection). Returns per-pixel coverage (how much the brush touched each pixel, 0–1).
export function smudge(work, w, h, points, { size, hardness = 0.75, rate = 0.5, flow = 0, color = [0, 0, 0, 1], limit = null }) {
  const { n, m } = brushMask(size, hardness), accum = new Float32Array(n * n * 4), coverage = new Float32Array(w * h);
  const paint = new Float32Array(4), col = Float32Array.from(color);
  const list = dabs(points, Math.max(1, size * 0.1));
  const origin = ([x, y]) => [Math.round(x - (n - 1) / 2), Math.round(y - (n - 1) / 2)];
  // Start with the pixels under the first dab (clamped at the region edge, as GIMP pre-fills).
  const [sx, sy] = origin(list[0]);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const px = Math.min(w - 1, Math.max(0, sx + x)), py = Math.min(h - 1, Math.max(0, sy + y));
    accum.set(work.subarray((py * w + px) * 4, (py * w + px) * 4 + 4), (y * n + x) * 4);
  }
  for (const p of list) {
    const [ox, oy] = origin(p);
    for (let y = 0; y < n; y++) {
      const py = oy + y;
      if (py < 0 || py >= h) continue;
      for (let x = 0; x < n; x++) {
        const px = ox + x;
        if (px < 0 || px >= w) continue;
        const a = (y * n + x) * 4, wi = (py * w + px) * 4;
        blend(accum, a, rate, work, wi, 1 - rate, accum, a);
        if (flow > 0) blend(col, 0, flow, accum, a, 1 - flow, paint, 0);
        else paint.set(accum.subarray(a, a + 4));
        const k = m[y * n + x] * (limit ? limit[py * w + px] : 1);
        if (k <= 0) continue;
        for (let c = 0; c < 4; c++) work[wi + c] += (paint[c] - work[wi + c]) * k;
        coverage[py * w + px] = Math.max(coverage[py * w + px], k);
      }
    }
  }
  return coverage;
}
