// Bezier paths (the Pen tool / GIMP's Paths). Shared by the browser and Node.
// A path is { id, name, subpaths: [{ closed, anchors: [{ x, y, in?: [x, y], out?: [x, y] }] }] } in document
// coordinates. `in` / `out` are the absolute positions of an anchor's handles; a missing handle means a sharp
// corner (the handle sits on the anchor). The segment a → b is a cubic bezier through a.out and b.in.

const pt = a => [a.x, a.y];
const hasHandles = (a, b) => !!(a.out || b.in);

// Each segment of a subpath: [from, to] (plus the closing segment for closed subpaths).
function segments(sp) {
  const a = sp.anchors, out = [];
  for (let i = 1; i < a.length; i++) out.push([a[i - 1], a[i]]);
  if (sp.closed && a.length > 1) out.push([a[a.length - 1], a[0]]);
  return out;
}

// Add the path to ctx's current path (call beginPath first; stroke or fill after).
export function tracePath(ctx, subpaths) {
  for (const sp of subpaths) {
    if (!sp.anchors.length) continue;
    ctx.moveTo(...pt(sp.anchors[0]));
    for (const [a, b] of segments(sp)) {
      if (hasHandles(a, b)) ctx.bezierCurveTo(...(a.out ?? pt(a)), ...(b.in ?? pt(b)), b.x, b.y);
      else ctx.lineTo(b.x, b.y);
    }
    if (sp.closed) ctx.closePath();
  }
}

export const anchorCount = subpaths => subpaths.reduce((n, sp) => n + sp.anchors.length, 0);

// Apply f([x, y]) → [x, y] to every anchor and handle.
export function mapPath(subpaths, f) {
  return subpaths.map(sp => ({
    closed: sp.closed,
    anchors: sp.anchors.map(a => {
      const [x, y] = f(pt(a)), o = { x, y };
      if (a.in) o.in = f(a.in);
      if (a.out) o.out = f(a.out);
      return o;
    }),
  }));
}
export const translatePath = (subpaths, dx, dy) => mapPath(subpaths, ([x, y]) => [x + dx, y + dy]);

// Bounding box of anchors and handles (the curve lies inside it): [x, y, w, h].
export function pathBounds(subpaths) {
  const xs = [], ys = [];
  for (const sp of subpaths) for (const a of sp.anchors) for (const p of [pt(a), a.in, a.out]) if (p) { xs.push(p[0]); ys.push(p[1]); }
  if (!xs.length) return null;
  const x = Math.min(...xs), y = Math.min(...ys);
  return [x, y, Math.max(...xs) - x, Math.max(...ys) - y];
}

export function validatePath(subpaths) {
  const ok = p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
  if (!Array.isArray(subpaths) || !subpaths.length) throw new Error('A path needs at least one subpath');
  for (const sp of subpaths) {
    if (!Array.isArray(sp?.anchors) || !sp.anchors.length) throw new Error('Each subpath needs anchors: [{x, y, in?, out?}]');
    for (const a of sp.anchors) {
      if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) throw new Error('Path anchors need numeric x and y');
      if ((a.in && !ok(a.in)) || (a.out && !ok(a.out))) throw new Error('Path handles must be [x, y]');
    }
  }
}

// ---- SVG path data ("M 10 10 C 20 0 40 0 50 10 Z") ↔ subpaths -----------------------------------

const ARGS = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, Z: 0 };

export function parseSvgPath(d) {
  const tokens = String(d).match(/[a-zA-Z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) || [];
  const subpaths = [];
  let sp = null, cur = [0, 0], start = [0, 0], lastCtrl = null, lastCmd = '', i = 0;
  const num = () => {
    const v = Number(tokens[i++]);
    if (!Number.isFinite(v)) throw new Error(`Bad number in path data near "${tokens.slice(i - 2, i + 2).join(' ')}"`);
    return v;
  };
  const last = () => sp.anchors[sp.anchors.length - 1];
  const lineTo = p => { sp.anchors.push({ x: p[0], y: p[1] }); cur = p; };
  const curveTo = (c1, c2, p) => {
    if (c1[0] !== cur[0] || c1[1] !== cur[1]) last().out = c1;
    const a = { x: p[0], y: p[1] };
    if (c2[0] !== p[0] || c2[1] !== p[1]) a.in = c2;
    sp.anchors.push(a);
    cur = p;
  };
  while (i < tokens.length) {
    let cmd = tokens[i];
    if (/[a-zA-Z]/.test(cmd)) i++;
    else if (lastCmd && lastCmd.toUpperCase() !== 'Z') cmd = lastCmd.toUpperCase() === 'M' ? (lastCmd === 'M' ? 'L' : 'l') : lastCmd; // repeated arguments
    else throw new Error(`Path data must start with a command (M, L, C, ...), got "${cmd}"`);
    const C = cmd.toUpperCase(), rel = cmd !== C, o = rel ? cur : [0, 0];
    if (!(C in ARGS)) throw new Error(`Unsupported path command "${cmd}" (use M L H V C S Q T Z)`);
    const P = () => { const x = num(), y = num(); return [o[0] + x, o[1] + y]; };
    if (C !== 'M' && !sp) throw new Error('Path data must start with M');
    let ctrl = null;
    switch (C) {
      case 'M': {
        const p = P();
        sp = { closed: false, anchors: [{ x: p[0], y: p[1] }] };
        subpaths.push(sp);
        cur = start = p;
        break;
      }
      case 'L': lineTo(P()); break;
      case 'H': lineTo([(rel ? cur[0] : 0) + num(), cur[1]]); break;
      case 'V': lineTo([cur[0], (rel ? cur[1] : 0) + num()]); break;
      case 'C': { const c1 = P(), c2 = P(), p = P(); curveTo(c1, c2, p); ctrl = c2; break; }
      case 'S': {
        const c1 = lastCtrl && /[CS]/i.test(lastCmd) ? [2 * cur[0] - lastCtrl[0], 2 * cur[1] - lastCtrl[1]] : cur;
        const c2 = P(), p = P();
        curveTo(c1, c2, p); ctrl = c2;
        break;
      }
      case 'Q': case 'T': {
        const q = C === 'Q' ? P() : lastCtrl && /[QT]/i.test(lastCmd) ? [2 * cur[0] - lastCtrl[0], 2 * cur[1] - lastCtrl[1]] : cur;
        const p = P(), p0 = cur;
        curveTo([p0[0] + (2 / 3) * (q[0] - p0[0]), p0[1] + (2 / 3) * (q[1] - p0[1])], [p[0] + (2 / 3) * (q[0] - p[0]), p[1] + (2 / 3) * (q[1] - p[1])], p);
        ctrl = q;
        break;
      }
      case 'Z': {
        sp.closed = true;
        // a final anchor on top of the first one is the same point: merge them
        const a = sp.anchors, f = a[0], l = a[a.length - 1];
        if (a.length > 1 && Math.abs(l.x - f.x) < 1e-9 && Math.abs(l.y - f.y) < 1e-9) { if (l.in) f.in = l.in; a.pop(); }
        cur = start;
        break;
      }
    }
    lastCtrl = ctrl;
    lastCmd = cmd;
  }
  if (!subpaths.length) throw new Error('Empty path data');
  return subpaths;
}

const n2 = v => String(Math.round(v * 100) / 100);
export function toSvgPath(subpaths) {
  const parts = [];
  for (const sp of subpaths) {
    if (!sp.anchors.length) continue;
    parts.push(`M ${n2(sp.anchors[0].x)} ${n2(sp.anchors[0].y)}`);
    for (const [a, b] of segments(sp)) {
      const closing = sp.closed && b === sp.anchors[0];
      if (hasHandles(a, b)) parts.push(`C ${[...(a.out ?? pt(a)), ...(b.in ?? pt(b)), b.x, b.y].map(n2).join(' ')}`);
      else if (!closing) parts.push(`L ${n2(b.x)} ${n2(b.y)}`);
    }
    if (sp.closed) parts.push('Z');
  }
  return parts.join(' ');
}

// The first subpath as a polyline with cumulative lengths: { pts: [[x, y]], len: [0, ...], total }.
export function flatten(sp, steps = 32) {
  const pts = [];
  const seg = (a, b) => {
    const p0 = [a.x, a.y], p1 = a.out ?? p0, p3 = [b.x, b.y], p2 = b.in ?? p3;
    for (let i = pts.length ? 1 : 0; i <= steps; i++) {
      const t = i / steps, u = 1 - t;
      pts.push([0, 1].map(k => u * u * u * p0[k] + 3 * u * u * t * p1[k] + 3 * u * t * t * p2[k] + t * t * t * p3[k]));
    }
  };
  const a = sp.anchors;
  if (a.length === 1) pts.push([a[0].x, a[0].y]);
  for (let i = 1; i < a.length; i++) seg(a[i - 1], a[i]);
  if (sp.closed && a.length > 1) seg(a[a.length - 1], a[0]);
  const len = [0];
  for (let i = 1; i < pts.length; i++) len.push(len[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return { pts, len, total: len.at(-1) };
}

// Point and direction (radians) at distance s along a flattened path (clamped to its ends).
export function pointAt({ pts, len, total }, s) {
  if (pts.length < 2) return { x: pts[0]?.[0] ?? 0, y: pts[0]?.[1] ?? 0, angle: 0 };
  s = Math.max(0, Math.min(total, s));
  let i = 1;
  while (i < len.length - 1 && len[i] < s) i++;
  const t = (s - len[i - 1]) / (len[i] - len[i - 1] || 1), [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
  return { x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t, angle: Math.atan2(y1 - y0, x1 - x0) };
}

