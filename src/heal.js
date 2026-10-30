// Healing, GIMP's method: take the difference between the destination and the cloned source, solve the
// Laplace equation for that difference inside the brush (its value outside the brush stays fixed), then add
// the source back. The patch keeps the source's texture but blends into the surrounding colors and light.
// Solver: red/black Gauss–Seidel with over-relaxation, at most 500 sweeps.

const MAX_ITER = 500, EPSILON = 0.1 / 255;

// src, dest: RGBA Uint8ClampedArray (w×h); inside: Uint8Array, 1 where the brush paints. Returns RGBA.
export function heal(src, dest, inside, w, h) {
  const n = w * h, diff = new Float32Array(n * 4);
  for (let i = 0; i < n * 4; i++) diff[i] = (dest[i] - src[i]) / 255;
  // Unknown pixels in checkerboard order, so each half-sweep only reads already-updated neighbours.
  const cells = [];
  for (let parity = 0; parity < 2; parity++)
    for (let y = 0; y < h; y++)
      for (let x = (y & 1) ^ parity; x < w; x += 2) if (inside[y * w + x]) cells.push(y * w + x);
  // Neighbours off the patch edge are left out (no condition there), as GIMP does at the canvas edge.
  const nbs = cells.map(p => {
    const x = p % w, y = (p - x) / w;
    return [x > 0 && p - 1, x < w - 1 && p + 1, y > 0 && p - w, y < h - 1 && p + w].filter(q => q !== false).map(q => q * 4);
  });
  const omega = 2 - 1 / (0.1575 * Math.sqrt(cells.length) + 0.8);
  for (let iter = 0; iter < MAX_ITER && cells.length; iter++) {
    let err = 0;
    for (let k = 0; k < cells.length; k++) {
      const p4 = cells[k] * 4, nb = nbs[k];
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (const q of nb) sum += diff[q + c];
        const delta = omega * (sum / nb.length - diff[p4 + c]);
        diff[p4 + c] += delta;
        err += delta * delta;
      }
    }
    if (err < EPSILON * EPSILON) break;
  }
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n * 4; i++) out[i] = Math.round(src[i] + diff[i] * 255);
  return out;
}
