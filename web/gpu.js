// GPU (WebGL2) version of tone.js's applyTone for the browser: the same lookup tables (built by
// toneProgram) are uploaded as textures and the per-pixel steps (color balance, hue-chroma, threshold,
// color to alpha) run in a fragment shader. Node exports keep using the CPU path, which stays the reference;
// results match it to within ±1 per channel. Shadows-highlights (a large blur) is left to the CPU.

const VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uSrc, uAll, uPre, uPost;
uniform highp sampler2D uBal;
uniform ivec2 uSize;
uniform bool uPerPixel, uBalOn, uPreserve, uHcOn, uThOn, uC2aOn;
uniform vec3 uHc;          // hue (radians), chroma, lightness
uniform vec3 uTh;          // low, high, channel (-1 = value, 0..2 = r, g, b)
uniform vec3 uC2aColor;    // 0–1
uniform vec2 uC2aT;        // transparency, opacity thresholds
out vec4 outColor;

float idx(float v) { return floor(clamp(v, 0.0, 255.0) + 0.5); }
vec3 lut(sampler2D t, vec3 c) {
  return floor(vec3(texelFetch(t, ivec2(int(idx(c.r)), 0), 0).r, texelFetch(t, ivec2(int(idx(c.g)), 0), 0).g,
              texelFetch(t, ivec2(int(idx(c.b)), 0), 0).b) * 255.0 + 0.5);
}

vec3 rgbToHsl(vec3 c) {
  c /= 255.0;
  float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b)), l = (mx + mn) / 2.0, d = mx - mn;
  if (d == 0.0) return vec3(0.0, 0.0, l);
  float s = l > 0.5 ? d / (2.0 - mx - mn) : d / (mx + mn);
  float h = mx == c.r ? (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0) : mx == c.g ? (c.b - c.r) / d + 2.0 : (c.r - c.g) / d + 4.0;
  return vec3(h / 6.0, s, l);
}
float hue2(float p, float q, float t) {
  t = t < 0.0 ? t + 1.0 : t > 1.0 ? t - 1.0 : t;
  return t < 1.0 / 6.0 ? p + (q - p) * 6.0 * t : t < 0.5 ? q : t < 2.0 / 3.0 ? p + (q - p) * (2.0 / 3.0 - t) * 6.0 : p;
}
vec3 hslToRgb(float h, float s, float l) {
  if (s == 0.0) return vec3(l * 255.0);
  float q = l < 0.5 ? l * (1.0 + s) : l + s - l * s, p = 2.0 * l - q;
  return 255.0 * vec3(hue2(p, q, h + 1.0 / 3.0), hue2(p, q, h), hue2(p, q, h - 1.0 / 3.0));
}

// sRGB ↔ CIE Lab (D50), as tone.js.
const float E = 216.0 / 24389.0, K = 24389.0 / 27.0, XN = 0.96420, ZN = 0.82491;
float lin(float c) { c /= 255.0; return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4); }
float gam(float c) { return c <= 0.0031308 ? 12.92 * c : 1.055 * pow(c, 1.0 / 2.4) - 0.055; }
float f(float t) { return t > E ? pow(t, 1.0 / 3.0) : (K * t + 16.0) / 116.0; }
float finv(float t) { return t * t * t > E ? t * t * t : (116.0 * t - 16.0) / K; }
vec3 toLab(vec3 c) {
  vec3 l = vec3(lin(c.r), lin(c.g), lin(c.b));
  float fx = f(dot(vec3(0.4360747, 0.3850649, 0.1430804), l) / XN), fy = f(dot(vec3(0.2225045, 0.7168786, 0.0606169), l));
  float fz = f(dot(vec3(0.0139322, 0.0971045, 0.7141733), l) / ZN);
  return vec3(116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz));
}
vec3 fromLab(vec3 lab) {
  float fy = (lab.x + 16.0) / 116.0, X = XN * finv(fy + lab.y / 500.0), Z = ZN * finv(fy - lab.z / 200.0);
  float Y = lab.x > K * E ? fy * fy * fy : lab.x / K;
  vec3 c = clamp(vec3(3.1338561 * X - 1.6168667 * Y - 0.4906146 * Z, -0.9787684 * X + 1.9161415 * Y + 0.0334540 * Z,
                      0.0719453 * X - 0.2289914 * Y + 1.4052427 * Z), 0.0, 1.0);
  return 255.0 * vec3(gam(c.r), gam(c.g), gam(c.b));
}

void main() {
  ivec2 p = ivec2(int(gl_FragCoord.x), uSize.y - 1 - int(gl_FragCoord.y));
  vec4 s = texelFetch(uSrc, p, 0);
  if (s.a == 0.0) { outColor = s; return; }
  vec3 c = floor(s.rgb * 255.0 + 0.5);
  float a = s.a;
  if (!uPerPixel) c = lut(uAll, c);
  else {
    c = lut(uPre, c);
    if (uBalOn) {
      float sum = max(c.r, max(c.g, c.b)) + min(c.r, min(c.g, c.b));
      c = clamp(c + texelFetch(uBal, ivec2(int(sum), 0), 0).rgb, 0.0, 255.0);
      if (uPreserve) { vec3 h = rgbToHsl(c); c = hslToRgb(h.x, h.y, sum / 510.0); }
    }
    if (uHcOn) {
      vec3 lab = toLab(floor(c + 0.5));
      float C = length(lab.yz), H = atan(lab.z, lab.y);
      if (C > 1e-4) { C += uHc.y; H += uHc.x; }
      C = clamp(C, 0.0, 300.0);
      c = fromLab(vec3(lab.x + uHc.z, C * cos(H), C * sin(H)));
    }
    c = lut(uPost, c);
  }
  if (uThOn) {
    float v = uTh.z < 0.0 ? max(c.r, max(c.g, c.b)) : c[int(uTh.z)];
    c = vec3(v >= uTh.x && v <= uTh.y ? 255.0 : 0.0);
  }
  if (uC2aOn) {
    vec3 px = c / 255.0;
    float alpha = 0.0, dist = 0.0;
    for (int i = 0; i < 3; i++) {
      float d = abs(px[i] - uC2aColor[i]), al;
      if (d < uC2aT.x + 0.00001) al = 0.0;
      else if (d > uC2aT.y - 0.00001) al = 1.0;
      else al = (d - uC2aT.x) / (min(uC2aT.y, px[i] < uC2aColor[i] ? uC2aColor[i] : 1.0 - uC2aColor[i]) - uC2aT.x);
      if (al > alpha) { alpha = al; dist = d; }
    }
    if (alpha > 0.00001) {
      float ratio = uC2aT.x / dist;
      vec3 base = uC2aColor + (px - uC2aColor) * ratio;
      px = clamp(base + (px - base) / alpha, 0.0, 1.0);
    }
    c = floor(px * 255.0 + 0.5);
    a = floor(a * 255.0 * min(1.0, alpha) + 0.5) / 255.0;
  }
  outColor = vec4(floor(c + 0.5) / 255.0, a);
}`;

// Returns { apply(canvas, prog) → canvas | null, info } or null when WebGL2 is unavailable.
export function createGpuTone() {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false });
  if (!gl) return null;
  const shader = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const prog = gl.createProgram();
  try {
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  } catch (err) {
    console.warn('GPU adjustments disabled:', err.message);
    return null;
  }
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, 'aPos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
  const u = name => gl.getUniformLocation(prog, name);

  const texture = unit => {
    const t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    return t;
  };
  const tex = { src: texture(0), all: texture(1), pre: texture(2), post: texture(3), bal: texture(4) };
  ['uSrc', 'uAll', 'uPre', 'uPost', 'uBal'].forEach((n, i) => gl.uniform1i(u(n), i));
  const zeroBal = new Float32Array(511 * 4);

  // Three per-channel 256-entry LUTs → one 256×1 RGBA texture.
  const lutData = luts => {
    const d = new Uint8Array(256 * 4);
    for (let v = 0; v < 256; v++) { d[v * 4] = luts[0][v]; d[v * 4 + 1] = luts[1][v]; d[v * 4 + 2] = luts[2][v]; d[v * 4 + 3] = 255; }
    return d;
  };
  let lastProg = null;
  const upload = p => {
    if (p === lastProg) return;
    lastProg = p;
    for (const [unit, name] of [[1, 'all'], [2, 'pre'], [3, 'post']]) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, lutData(p[name]));
    }
    let bal = zeroBal;
    if (p.balance) {
      bal = new Float32Array(511 * 4);
      for (let s = 0; s < 511; s++) for (let c = 0; c < 3; c++) bal[s * 4 + c] = p.balance.shift[c][s];
    }
    gl.activeTexture(gl.TEXTURE4);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 511, 1, 0, gl.RGBA, gl.FLOAT, bal);
    gl.uniform1i(u('uPerPixel'), p.balance || p.hc ? 1 : 0);
    gl.uniform1i(u('uBalOn'), p.balance ? 1 : 0);
    gl.uniform1i(u('uPreserve'), p.balance?.preserve ? 1 : 0);
    gl.uniform1i(u('uHcOn'), p.hc ? 1 : 0);
    if (p.hc) gl.uniform3f(u('uHc'), (p.hc.hue * Math.PI) / 180, p.hc.chroma, p.hc.lightness);
    gl.uniform1i(u('uThOn'), p.threshold ? 1 : 0);
    if (p.threshold) gl.uniform3f(u('uTh'), p.threshold.low, p.threshold.high, { r: 0, g: 1, b: 2 }[p.threshold.channel] ?? -1);
    gl.uniform1i(u('uC2aOn'), p.c2a ? 1 : 0);
    if (p.c2a) { gl.uniform3f(u('uC2aColor'), ...p.c2a.rgb); gl.uniform2f(u('uC2aT'), p.c2a.transparency, p.c2a.opacity); }
  };

  const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  // Steps of toneProgram this shader implements; anything new in tone.js falls back to the CPU until added here.
  const SUPPORTED = new Set(['all', 'pre', 'post', 'balance', 'hc', 'threshold', 'c2a', 'sh']);
  return {
    // Tone-map a whole canvas; returns the WebGL canvas holding the result (valid until the next call).
    apply(src, p) {
      if (p.sh || Object.keys(p).some(k => p[k] && !SUPPORTED.has(k)) || src.width > maxSize || src.height > maxSize || gl.isContextLost()) return null;
      upload(p);
      if (canvas.width !== src.width || canvas.height !== src.height) { canvas.width = src.width; canvas.height = src.height; }
      gl.viewport(0, 0, src.width, src.height);
      gl.activeTexture(gl.TEXTURE0);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src);
      gl.uniform2i(u('uSize'), src.width, src.height);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return canvas;
    },
    info: gpuInfo(gl),
  };
}

// Which GPU the browser is drawing with, and whether that is a software fallback.
export function gpuInfo(gl = document.createElement('canvas').getContext('webgl2') || document.createElement('canvas').getContext('webgl')) {
  if (!gl) return { renderer: 'WebGL unavailable', software: true, webgl2: false };
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = (ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || 'unknown';
  return { renderer, software: /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/i.test(renderer), webgl2: typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext };
}
