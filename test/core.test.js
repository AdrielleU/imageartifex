import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { replay, applyOp, newDoc } from '../src/model.js';
import { initProject, commit, loadState, undoneSeqs, renderCanvas, importAsset } from '../src/store.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'artifex-'));

test('undo/redo replay keeps the right ops active', () => {
  const e = (seq, op) => ({ seq, op });
  const entries = [
    e(1, { type: 'canvas.new', width: 10, height: 10, background: null }),
    e(2, { type: 'layer.add', layer: { id: 'L1', type: 'shape' } }),
    e(3, { type: 'layer.update', id: 'L1', props: { x: 5 } }),
    e(4, { type: 'history.undo' }),
  ];
  assert.equal(replay(entries).doc.layers[0].x, 0);
  assert.equal(replay([...entries, e(5, { type: 'history.redo' })]).doc.layers[0].x, 5);
  // a new op after undo clears the redo stack
  const r = replay([...entries, e(5, { type: 'layer.update', id: 'L1', props: { y: 2 } }), e(6, { type: 'history.redo' })]);
  assert.deepEqual([r.doc.layers[0].x, r.doc.layers[0].y], [0, 2]);
});

test('invalid ops are rejected', () => {
  assert.throws(() => applyOp(newDoc(), { type: 'layer.update', id: 'nope', props: {} }), /No layer/);
  const doc = applyOp(newDoc(), { type: 'layer.add', layer: { id: 'L1', type: 'shape' } });
  assert.throws(() => applyOp(doc, { type: 'layer.update', id: 'L1', props: { blend: 'sparkle' } }), /blend mode/);
});

test('project commits, describes, merges and renders', async () => {
  const dir = tmp();
  await initProject(dir, { width: 20, height: 10, background: '#ffffff' });
  const a = await commit(dir, { type: 'layer.add', layer: { type: 'shape', name: 'Red', x: 0, y: 0, w: 10, h: 10, fill: '#ff0000' } }, 'claude');
  assert.match(a.text, /Added rect 10×10 fill #ff0000 as layer "Red" \(L1\)/);
  await commit(dir, { type: 'layer.add', layer: { type: 'shape', name: 'Blue', x: 10, y: 0, w: 10, h: 10, fill: '#0000ff' } });
  const moved = await commit(dir, { type: 'layer.update', id: 'Blue', props: { x: 8, opacity: 0.5 } }, 'user');
  assert.equal(moved.text, 'Layer "Blue": moved (10, 0) → (8, 0); opacity 100% → 50%');

  const merged = await commit(dir, { type: 'layer.merge', down: 'Blue' });
  let state = loadState(dir);
  assert.equal(state.doc.layers.length, 1);
  assert.equal(state.doc.layers[0].id, merged.op.newId);

  const px = async (x, y) => (await renderCanvas(dir, loadState(dir).doc)).getContext('2d').getImageData(x, y, 1, 1).data;
  assert.deepEqual([...await px(2, 5)], [255, 0, 0, 255]);
  assert.deepEqual([...await px(15, 5)].slice(2), [255, 255]); // blue at 50% over white

  await commit(dir, { type: 'history.undo' });
  state = loadState(dir);
  assert.equal(state.doc.layers.length, 2);
  assert.ok(undoneSeqs(state).has(merged.seq));
});

test('imported images are content-addressed and centred', async () => {
  const dir = tmp();
  await initProject(dir, { width: 100, height: 100, background: null });
  const c = createCanvas(20, 10);
  c.getContext('2d').fillRect(0, 0, 20, 10);
  const file = path.join(dir, 'in.png');
  fs.writeFileSync(file, await c.encode('png'));
  const e = await commit(dir, { type: 'layer.add', layer: { type: 'image', src: file } });
  assert.deepEqual([e.op.layer.x, e.op.layer.y, e.op.layer.name], [40, 45, 'in.png']);
  assert.equal((await importAsset(dir, file)).asset, e.op.layer.asset);
});

test('selections: modes, wand, clear, copy, clipped strokes, crop', async () => {
  const dir = tmp();
  await initProject(dir, { width: 40, height: 20, background: null });
  const px = async (x, y) => [...(await renderCanvas(dir, loadState(dir).doc)).getContext('2d').getImageData(x, y, 1, 1).data];
  await commit(dir, { type: 'layer.add', layer: { type: 'shape', name: 'Left', x: 0, y: 0, w: 20, h: 20, fill: '#ff0000' } });
  await commit(dir, { type: 'layer.add', layer: { type: 'shape', name: 'Right', x: 20, y: 0, w: 20, h: 20, fill: '#00ff00' } });

  // fuzzy select picks only the contiguous red half
  const wand = await commit(dir, { type: 'selection.set', shape: { type: 'wand', x: 5, y: 5, threshold: 10 } });
  assert.deepEqual(wand.op.shape.bbox, [0, 0, 20, 20]);

  // subtract a rect, then clear: only the remaining part of Left disappears
  await commit(dir, { type: 'selection.set', mode: 'subtract', shape: { type: 'rect', x: 0, y: 0, w: 10, h: 20 } });
  await commit(dir, { type: 'edit.clear', id: 'Left' });
  assert.equal((await px(5, 5))[3], 255);
  assert.equal((await px(15, 5))[3], 0);

  // copy the right half of the green layer to a new layer and move it; the mask moves with it
  await commit(dir, { type: 'selection.set', shape: { type: 'rect', x: 30, y: 0, w: 10, h: 20 } });
  const copy = await commit(dir, { type: 'layer.fromSelection', id: 'Right' });
  await commit(dir, { type: 'layer.update', id: copy.op.newId, props: { x: 0 } }); // was 20 → copy shows at 10..20
  await commit(dir, { type: 'layer.update', id: 'Right', props: { visible: false } });
  assert.deepEqual(await px(15, 5), [0, 255, 0, 255]);
  assert.equal((await px(25, 5))[3], 0);

  // strokes are clipped to the selection
  await commit(dir, { type: 'layer.add', layer: { type: 'paint', name: 'Ink' } });
  const st = await commit(dir, { type: 'paint.stroke', id: 'Ink', stroke: { color: '#0000ff', size: 4, points: [[0, 10], [39, 10]] } });
  assert.ok(st.op.stroke.clip);
  assert.deepEqual(await px(35, 10), [0, 0, 255, 255]);
  assert.equal((await px(25, 10))[3], 0);

  // crop to selection keeps the selection aligned with the content
  const crop = await commit(dir, { type: 'canvas.crop', toSelection: true });
  assert.deepEqual([crop.op.x, crop.op.width], [30, 10]);
  const s = loadState(dir).doc.selection.items[0];
  assert.deepEqual([s.dx, s.shape.x], [-30, 30]);

  // grow/shrink/feather produce mask selections; undo restores the previous selection
  await commit(dir, { type: 'selection.set', shape: { type: 'rect', x: 2, y: 2, w: 4, h: 4 } });
  const grown = await commit(dir, { type: 'selection.modify', kind: 'grow', radius: 2 });
  assert.deepEqual(grown.op.shape.bbox, [0, 0, 8, 8]);
  await commit(dir, { type: 'history.undo' });
  assert.equal(loadState(dir).doc.selection.items[0].shape.type, 'rect');
  await commit(dir, { type: 'selection.none' });
  await assert.rejects(commit(dir, { type: 'edit.clear', id: 'Ink' }), /Nothing is selected/);
});

test('levels, curves and gradients', async () => {
  const { curveFn, toneLUTs } = await import('../src/tone.js');
  // curves pass through their points and stay monotone between them
  const f = curveFn([[0, 0], [128, 200], [255, 255]]);
  assert.equal(Math.round(f(128)), 200);
  for (let v = 1; v < 256; v++) assert.ok(f(v) >= f(v - 1));
  const [lr] = toneLUTs({ levels: { value: { inLow: 50, inHigh: 150 } } });
  assert.deepEqual([lr[50], lr[100], lr[150], lr[200]], [0, 128, 255, 255]);

  const dir = tmp();
  await initProject(dir, { width: 10, height: 10, background: null });
  await commit(dir, { type: 'layer.add', layer: { type: 'shape', name: 'Gray', x: 0, y: 0, w: 10, h: 10, fill: '#646464' } });
  const px = async (x, y) => [...(await renderCanvas(dir, loadState(dir).doc)).getContext('2d').getImageData(x, y, 1, 1).data];
  await commit(dir, { type: 'layer.update', id: 'Gray', props: { levels: { value: { inLow: 50, inHigh: 150 } } } });
  assert.deepEqual(await px(5, 5), [128, 128, 128, 255]);
  await commit(dir, { type: 'layer.update', id: 'Gray', props: { curves: { r: [[0, 255], [255, 0]] } } });
  assert.equal((await px(5, 5))[0], 128); // inverted 127.5, rounded
  const auto = await commit(dir, { type: 'layer.autoLevels', id: 'Gray' });
  assert.equal(auto.op.type, 'layer.update');
  assert.match(auto.text, /Auto levels/);
  await assert.rejects(commit(dir, { type: 'layer.update', id: 'Gray', props: { levels: { value: { gamma: 0 } } } }), /gamma/);

  // gradient limited to a selection
  await commit(dir, { type: 'selection.set', shape: { type: 'rect', x: 0, y: 0, w: 5, h: 10 } });
  const g = await commit(dir, { type: 'edit.gradient', x1: 0, y1: 0, x2: 9, y2: 0, from: '#ff0000', to: '#0000ff' });
  assert.match(g.text, /Drew a linear gradient #ff0000 → #0000ff/);
  await commit(dir, { type: 'layer.update', id: 'Gray', props: { visible: false } });
  const left = await px(0, 5), right = await px(8, 5);
  assert.ok(left[0] > 200 && left[2] < 50);
  assert.equal(right[3], 0);
});

test('color balance, posterize and threshold', async () => {
  const dir = tmp();
  await initProject(dir, { width: 4, height: 4, background: null });
  await commit(dir, { type: 'layer.add', layer: { type: 'shape', name: 'Gray', x: 0, y: 0, w: 4, h: 4, fill: '#808080' } });
  const px = async () => [...(await renderCanvas(dir, loadState(dir).doc)).getContext('2d').getImageData(1, 1, 1, 1).data].slice(0, 3);

  const bal = await commit(dir, { type: 'layer.update', id: 'Gray', props: { colorBalance: { midtones: { cyanRed: 50 }, preserveLuminosity: false } } });
  assert.match(bal.text, /color balance \(midtones\) neutral → cyan–red 50/);
  // GIMP's formula: L≈0.5 is pure midtones, weight 0.7 → +0.5 × 0.7 × 255
  assert.deepEqual(await px(), [217, 128, 128]);
  const { balanceWeights } = await import('../src/tone.js');
  for (const L of [0, 0.3, 0.5, 0.7, 1]) {
    const w = balanceWeights(L);
    assert.ok(Math.abs(w.shadows + w.midtones + w.highlights - 0.7) < 1e-9);
  }
  // preserving luminosity keeps (max+min)/2 the same
  await commit(dir, { type: 'layer.update', id: 'Gray', props: { colorBalance: { preserveLuminosity: true } } });
  const kept = await px();
  assert.ok(Math.abs((Math.max(...kept) + Math.min(...kept)) / 2 - 128) <= 1 && kept[0] > kept[1]);
  await commit(dir, { type: 'layer.update', id: 'Gray', props: { colorBalance: null } });

  await commit(dir, { type: 'layer.update', id: 'Gray', props: { posterize: 2 } });
  assert.deepEqual(await px(), [255, 255, 255]);
  await commit(dir, { type: 'layer.update', id: 'Gray', props: { posterize: null, threshold: { low: 200 } } });
  assert.deepEqual(await px(), [0, 0, 0]);
  const t = await commit(dir, { type: 'layer.update', id: 'Gray', props: { threshold: { low: 100 } } });
  assert.match(t.text, /threshold 200–255 \(value\) → white, rest black → 100–255/);
  assert.deepEqual(await px(), [255, 255, 255]);
  await assert.rejects(commit(dir, { type: 'layer.update', id: 'Gray', props: { posterize: 1 } }), /posterize/);
});

test('shadows-highlights, color to alpha and picking', async () => {
  const { pickColor } = await import('../src/store.js');
  const dir = tmp();
  await initProject(dir, { width: 20, height: 10, background: null });
  await commit(dir, { type: 'layer.add', layer: { type: 'shape', name: 'Dark', x: 0, y: 0, w: 10, h: 10, fill: '#202020' } });
  await commit(dir, { type: 'layer.add', layer: { type: 'shape', name: 'White', x: 10, y: 0, w: 10, h: 10, fill: '#ffffff' } });

  // shadows lift dark pixels; picking reports the layer before and after its adjustments
  const sh = await commit(dir, { type: 'layer.update', id: 'Dark', props: { shadowsHighlights: { shadows: 80, radius: 2 } } });
  assert.match(sh.text, /shadows-highlights on \(shadows 80, highlights 0/);
  const p = await pickColor(dir, loadState(dir).doc, 5, 5, { layer: 'Dark' });
  assert.equal(p.before.hex, '#202020');
  assert.ok(p.after.r > 0x20 + 10);
  await assert.rejects(commit(dir, { type: 'layer.update', id: 'Dark', props: { shadowsHighlights: { radius: 0 } } }), /radius/);

  // color to alpha: white sampled at a point becomes fully transparent; 50% gray over white → black at 50%
  const c = await commit(dir, { type: 'layer.colorToAlpha', id: 'White', at: [15, 5] });
  assert.match(c.text, /Color to alpha \(color #ffffff picked at \(15, 5\)\)/);
  assert.equal((await pickColor(dir, loadState(dir).doc, 15, 5)).image.alpha, 0);
  await commit(dir, { type: 'layer.update', id: 'White', props: { fill: '#808080' } });
  const g = (await pickColor(dir, loadState(dir).doc, 15, 5)).image;
  assert.deepEqual([g.r, g.g, g.b], [0, 0, 0]);
  assert.ok(Math.abs(g.alpha - 0.5) < 0.01);
  await assert.rejects(commit(dir, { type: 'layer.update', id: 'White', props: { colorToAlpha: { transparency: 0.9, opacity: 0.5 } } }), /threshold/);
});

test('exposure and hue-chroma', async () => {
  const dir = tmp();
  await initProject(dir, { width: 4, height: 4, background: null });
  await commit(dir, { type: 'layer.add', layer: { type: 'shape', name: 'Px', x: 0, y: 0, w: 4, h: 4, fill: '#808080' } });
  const px = async () => [...(await renderCanvas(dir, loadState(dir).doc)).getContext('2d').getImageData(1, 1, 1, 1).data].slice(0, 3);

  // +1 stop doubles linear light: sRGB 128 (0.216 linear) → 0.432 linear ≈ 176
  const e = await commit(dir, { type: 'layer.update', id: 'Px', props: { exposure: { stops: 1 } } });
  assert.match(e.text, /exposure on \(stops 1, black level 0\)/);
  assert.deepEqual(await px(), [176, 176, 176]);
  await assert.rejects(commit(dir, { type: 'layer.update', id: 'Px', props: { exposure: { blackLevel: 0.5 } } }), /black/i);
  await commit(dir, { type: 'layer.update', id: 'Px', props: { exposure: null } });

  // grays keep their hue/chroma; lightness still applies; colors rotate in LCh
  await commit(dir, { type: 'layer.update', id: 'Px', props: { hueChroma: { hue: 90 } } });
  assert.deepEqual(await px(), [128, 128, 128]);
  await commit(dir, { type: 'layer.update', id: 'Px', props: { fill: '#c85028', hueChroma: { hue: 180 } } });
  const [r, , b] = await px();
  assert.ok(b > r, 'orange rotated 180° turns blue');
  const h = await commit(dir, { type: 'layer.update', id: 'Px', props: { hueChroma: { chroma: -100 } } });
  assert.match(h.text, /hue-chroma chroma 0 → -100/);
  const [gr, gg, gb] = await px();
  assert.ok(Math.max(gr, gg, gb) - Math.min(gr, gg, gb) <= 1, 'chroma -100 makes it gray');
});

test('clone and heal', async () => {
  const { heal } = await import('../src/heal.js');
  // heal: a flat source patch takes on the destination's surroundings (here a constant 200)
  const w = 9, h = 9, src = new Uint8ClampedArray(w * h * 4).fill(50), dest = new Uint8ClampedArray(w * h * 4).fill(200);
  const inside = new Uint8Array(w * h);
  for (let y = 2; y < 7; y++) for (let x = 2; x < 7; x++) inside[y * w + x] = 1;
  assert.ok(Math.abs(heal(src, dest, inside, w, h)[(4 * w + 4) * 4] - 200) <= 1);

  const dir = tmp();
  await initProject(dir, { width: 40, height: 20, background: null });
  await commit(dir, { type: 'layer.add', layer: { type: 'shape', name: 'Left', x: 0, y: 0, w: 20, h: 20, fill: '#0000ff' } });
  await commit(dir, { type: 'layer.add', layer: { type: 'shape', name: 'Right', x: 20, y: 0, w: 20, h: 20, fill: '#ffff00' } });
  await commit(dir, { type: 'layer.add', layer: { type: 'paint', name: 'Fix' } });
  await assert.rejects(commit(dir, { type: 'paint.clone', id: 'Left', points: [[30, 10]], from: [10, 10] }), /paint layer/);
  const px = async (x, y) => [...(await renderCanvas(dir, loadState(dir).doc)).getContext('2d').getImageData(x, y, 1, 1).data];

  // clone copies the blue from the left onto the yellow right
  const c = await commit(dir, { type: 'paint.clone', id: 'Fix', points: [[30, 10]], from: [10, 10], size: 8, hardness: 1 });
  assert.match(c.text, /Cloned a 1-point stroke on "Fix" from the image 20px left/);
  assert.deepEqual(await px(30, 10), [0, 0, 255, 255]);
  // heal from the same place blends into the yellow instead
  await commit(dir, { type: 'history.undo' });
  await commit(dir, { type: 'paint.heal', id: 'Fix', points: [[30, 10]], from: [10, 10], size: 8, hardness: 1 });
  const [r, g, b] = await px(30, 10);
  assert.ok(r > 240 && g > 240 && b < 15, `healed pixel ${r},${g},${b} should match the yellow`);
  await assert.rejects(commit(dir, { type: 'paint.clone', id: 'Fix', points: [[5, 5]], offset: [-100, 0] }), /Nothing to clone/);
});

test('smudge, dodge and burn', async () => {
  const { dodgeBurnLUT } = await import('../src/tone.js');
  // GIMP's formulas: midtones dodge 50% → v^(1/1.5); burn highlights 30% → v·0.9; shadows dodge lifts black
  assert.equal(dodgeBurnLUT('dodge', 'midtones', 50)[128], Math.round(255 * (128 / 255) ** (1 / 1.5)));
  assert.equal(dodgeBurnLUT('burn', 'highlights', 30)[200], Math.round(200 * 0.9));
  assert.ok(dodgeBurnLUT('dodge', 'shadows', 60)[0] > 40);

  const dir = tmp();
  await initProject(dir, { width: 40, height: 20, background: null });
  await commit(dir, { type: 'layer.add', layer: { type: 'shape', name: 'Red', x: 0, y: 0, w: 20, h: 20, fill: '#ff0000' } });
  await commit(dir, { type: 'layer.add', layer: { type: 'shape', name: 'Gray', x: 20, y: 0, w: 20, h: 20, fill: '#808080' } });
  await commit(dir, { type: 'layer.add', layer: { type: 'paint', name: 'Fix' } });
  const px = async (x, y) => [...(await renderCanvas(dir, loadState(dir).doc)).getContext('2d').getImageData(x, y, 1, 1).data];

  // smudging from red into gray carries red along
  const s = await commit(dir, { type: 'paint.smudge', id: 'Fix', points: [[12, 10], [30, 10]], size: 8, rate: 80 });
  assert.match(s.text, /Smudged a 2-point stroke on "Fix" \(rate 80\)/);
  const [r, g] = await px(24, 10);
  assert.ok(r > g + 40, `smudged pixel ${r},${g} should lean red`);
  assert.deepEqual(await px(30, 2), [128, 128, 128, 255]); // outside the brush: untouched

  await commit(dir, { type: 'paint.dodge', id: 'Fix', points: [[35, 15]], size: 6, hardness: 1, exposure: 50 });
  assert.ok((await px(35, 15))[0] > 150);
  await commit(dir, { type: 'paint.burn', id: 'Fix', points: [[35, 3]], size: 4, hardness: 1, range: 'midtones', exposure: 100 });
  assert.equal((await px(35, 3))[0], 102); // 128 → 255·(128/255)^(4/3)
  await assert.rejects(commit(dir, { type: 'paint.dodge', id: 'Fix', points: [[1, 1]], range: 'all' }), /Unknown range/);
});

test('paths: SVG data, fill, stroke, selection, crop', async () => {
  const { parseSvgPath, toSvgPath } = await import('../src/paths.js');
  const d = 'M 10 10 C 20 0 40 0 50 10 L 50 30 Z';
  assert.equal(toSvgPath(parseSvgPath(d)), d);
  assert.equal(toSvgPath(parseSvgPath('m 0 0 h 10 v 10 h -10 z')), 'M 0 0 L 10 0 L 10 10 L 0 10 Z');
  assert.throws(() => parseSvgPath('M 0 0 A 1 1 0 0 1 5 5'), /Unsupported/);

  const dir = tmp();
  await initProject(dir, { width: 40, height: 40, background: null });
  const px = async (x, y) => [...(await renderCanvas(dir, loadState(dir).doc)).getContext('2d').getImageData(x, y, 1, 1).data];
  const a = await commit(dir, { type: 'path.add', path: { name: 'Box', d: 'M 10 10 L 30 10 L 30 30 L 10 30 Z' } });
  assert.equal(a.text, 'Added path "Box" (P1): 4 anchors, closed');

  const f = await commit(dir, { type: 'path.fill', id: 'Box', color: '#ff0000' });
  assert.match(f.text, /Filled path "Box" with #ff0000 as new layer "Fill Box"/);
  assert.deepEqual(await px(20, 20), [255, 0, 0, 255]);
  assert.equal((await px(5, 5))[3], 0);

  const s = await commit(dir, { type: 'path.stroke', id: 'P1', color: '#0000ff', size: 4 });
  assert.match(s.text, /Stroked path "Box" with #0000ff, 4px as new layer "Stroke Box"/);
  assert.deepEqual(await px(10, 20), [0, 0, 255, 255]);
  assert.deepEqual(await px(20, 20), [255, 0, 0, 255]); // inside untouched

  const sel = await commit(dir, { type: 'path.select', id: 'Box' });
  assert.match(sel.text, /Selected path "Box" \(4 anchors\)/);
  // moving and cropping keep paths aligned with the image
  await commit(dir, { type: 'path.update', id: 'Box', dx: 2, dy: 0 });
  await commit(dir, { type: 'canvas.crop', x: 5, y: 5, width: 30, height: 30 });
  assert.equal(toSvgPath(loadState(dir).doc.paths[0].subpaths), 'M 7 5 L 27 5 L 27 25 L 7 25 Z');
  await commit(dir, { type: 'path.remove', id: 'Box' });
  assert.equal(loadState(dir).doc.paths.length, 0);
  await commit(dir, { type: 'history.undo' });
  assert.equal(loadState(dir).doc.paths.length, 1);
});

test('groups, clipping masks and locks', async () => {
  const dir = tmp();
  await initProject(dir, { width: 40, height: 20, background: '#ffffff' });
  const px = async (x, y) => [...(await renderCanvas(dir, loadState(dir).doc)).getContext('2d').getImageData(x, y, 1, 1).data];
  await commit(dir, { type: 'layer.add', layer: { type: 'shape', name: 'Red', x: 0, y: 0, w: 20, h: 20, fill: '#ff0000' } });
  await commit(dir, { type: 'layer.add', layer: { type: 'shape', name: 'Blue', x: 10, y: 0, w: 20, h: 20, fill: '#0000ff' } });

  // group: opacity applies to the group as a whole (overlap is not double-transparent)
  const g = await commit(dir, { type: 'layer.group', ids: ['Red', 'Blue'], name: 'Pair' });
  assert.match(g.text, /Grouped "Red", "Blue" into group "Pair"/);
  await commit(dir, { type: 'layer.update', id: 'Pair', props: { opacity: 0.5 } });
  const half = await px(15, 10); // 50% blue over white: red is fully covered inside the group, so no red shows through
  assert.ok(Math.abs(half[0] - 128) <= 2 && Math.abs(half[1] - 128) <= 2 && half[2] === 255, `got ${half}`);
  const m = await commit(dir, { type: 'layer.move', id: 'Pair', dx: 5, dy: 0 });
  assert.match(m.text, /Moved group "Pair" by \(5, 0\)/);
  assert.deepEqual(loadState(dir).doc.layers.filter(l => l.type === 'shape').map(l => l.x), [5, 15]);
  await commit(dir, { type: 'layer.update', id: 'Pair', props: { visible: false } });
  assert.deepEqual(await px(20, 10), [255, 255, 255, 255]);
  await commit(dir, { type: 'layer.ungroup', id: 'Pair' });
  assert.ok(loadState(dir).doc.layers.every(l => !l.parent && l.type !== 'group'));

  // clipping mask: the green layer only shows where Red (below) has pixels
  await commit(dir, { type: 'layer.reorder', id: 'Blue', index: 'bottom' });
  await commit(dir, { type: 'layer.add', layer: { type: 'shape', name: 'Green', x: 0, y: 0, w: 40, h: 10, fill: '#00ff00' } });
  const c = await commit(dir, { type: 'layer.update', id: 'Green', props: { clip: true } });
  assert.match(c.text, /clipped to the layer below/);
  assert.deepEqual(await px(10, 5), [0, 255, 0, 255]);   // over Red → green
  assert.deepEqual(await px(30, 5), [0, 0, 255, 255]);   // outside Red → no green (Blue below shows)
  assert.deepEqual(await px(38, 5), [255, 255, 255, 255]);

  // locks
  await commit(dir, { type: 'layer.update', id: 'Red', props: { locks: { position: true } } });
  await assert.rejects(commit(dir, { type: 'layer.update', id: 'Red', props: { x: 1 } }), /locked \(position\)/);
  await commit(dir, { type: 'layer.add', layer: { type: 'paint', name: 'Ink' } });
  await commit(dir, { type: 'paint.stroke', id: 'Ink', stroke: { color: '#000000', size: 4, points: [[2, 15], [12, 15]] } });
  await commit(dir, { type: 'layer.update', id: 'Ink', props: { locks: { alpha: true } } });
  await commit(dir, { type: 'paint.stroke', id: 'Ink', stroke: { color: '#ffff00', size: 10, points: [[0, 15], [39, 15]] } });
  assert.deepEqual(await px(5, 15), [255, 255, 0, 255]);  // repainted where Ink already had pixels
  assert.deepEqual((await px(30, 15)).slice(0, 3), [0, 0, 255]); // not elsewhere
  await commit(dir, { type: 'layer.update', id: 'Ink', props: { locks: { pixels: true } } });
  await assert.rejects(commit(dir, { type: 'paint.stroke', id: 'Ink', stroke: { points: [[1, 1]] } }), /locked \(pixels\)/);
});

test('adjustment layers apply to everything below', async () => {
  const dir = tmp();
  await initProject(dir, { width: 30, height: 10, background: '#808080' });
  const px = async (x, y) => [...(await renderCanvas(dir, loadState(dir).doc)).getContext('2d').getImageData(x, y, 1, 1).data];
  await commit(dir, { type: 'layer.add', layer: { type: 'shape', name: 'Red', x: 0, y: 0, w: 10, h: 10, fill: '#c80000' } });
  await commit(dir, { type: 'layer.add', layer: { type: 'adjustment', name: 'Invert' } });
  await commit(dir, { type: 'layer.add', layer: { type: 'shape', name: 'Top', x: 20, y: 0, w: 10, h: 10, fill: '#0000ff' } });
  await commit(dir, { type: 'layer.update', id: 'Invert', props: { curves: { value: [[0, 255], [255, 0]] } } });
  assert.deepEqual(await px(5, 5), [55, 255, 255, 255]);   // red below → inverted
  assert.deepEqual(await px(15, 5), [127, 127, 127, 255]); // background too
  assert.deepEqual(await px(25, 5), [0, 0, 255, 255]);     // the layer above is untouched
  await commit(dir, { type: 'layer.update', id: 'Invert', props: { opacity: 0.5 } });
  assert.ok(Math.abs((await px(15, 5))[0] - 128) <= 2);     // half-strength: halfway between 128 and 127
  // clipped to Red: only Red changes
  await commit(dir, { type: 'layer.update', id: 'Invert', props: { opacity: 1, clip: true } });
  assert.deepEqual(await px(5, 5), [55, 255, 255, 255]);
  assert.deepEqual(await px(15, 5), [128, 128, 128, 255]);
  // auto levels on an adjustment layer measures what is below it
  const { layerHistogram } = await import('../src/store.js');
  assert.equal((await layerHistogram(dir, loadState(dir).doc, 'Invert')).count, 300);
});

test('mask painting, quick mask and moving the selection', async () => {
  const dir = tmp();
  await initProject(dir, { width: 40, height: 20, background: '#ffffff' });
  const px = async (x, y) => [...(await renderCanvas(dir, loadState(dir).doc)).getContext('2d').getImageData(x, y, 1, 1).data];
  await commit(dir, { type: 'layer.add', layer: { type: 'shape', name: 'Red', x: 0, y: 0, w: 40, h: 20, fill: '#ff0000' } });
  // hide a band by painting the mask, then bring part of it back
  const h = await commit(dir, { type: 'layer.maskStroke', id: 'Red', mode: 'hide', stroke: { points: [[0, 10], [39, 10]], size: 8, hardness: 1 } });
  assert.match(h.text, /Hid part of layer "Red" by painting its mask/);
  assert.deepEqual(await px(20, 10), [255, 255, 255, 255]);
  assert.deepEqual(await px(20, 2), [255, 0, 0, 255]);
  await commit(dir, { type: 'layer.maskStroke', id: 'Red', mode: 'reveal', stroke: { points: [[30, 10]], size: 6, hardness: 1 } });
  assert.deepEqual(await px(30, 10), [255, 0, 0, 255]);
  assert.deepEqual(await px(10, 10), [255, 255, 255, 255]);
  // the painted mask follows the layer when it moves
  await commit(dir, { type: 'layer.update', id: 'Red', props: { y: 2 } });
  assert.deepEqual(await px(20, 12), [255, 255, 255, 255]);

  // quick mask: paint a selection, subtract part, move the outline, then use it
  await commit(dir, { type: 'selection.paint', stroke: { points: [[5, 5], [15, 5]], size: 6, hardness: 1 } });
  await commit(dir, { type: 'selection.paint', mode: 'subtract', stroke: { points: [[15, 5]], size: 6, hardness: 1 } });
  const t = await commit(dir, { type: 'selection.translate', dx: 20, dy: 0 });
  assert.match(t.text, /Moved the selection outline by \(20, 0\)/);
  await commit(dir, { type: 'edit.fill', color: '#0000ff' });
  assert.deepEqual(await px(26, 5), [0, 0, 255, 255]);   // painted part, moved by 20
  assert.notDeepEqual(await px(35, 5), [0, 0, 255, 255]); // subtracted part
  assert.notDeepEqual(await px(6, 5), [0, 0, 255, 255]);  // original place is empty now
});

test('brush: opacity, hardness, blend, pressure; blur and sharpen brushes', async () => {
  const dir = tmp();
  await initProject(dir, { width: 60, height: 20, background: '#ffffff' });
  const px = async (x, y) => [...(await renderCanvas(dir, loadState(dir).doc)).getContext('2d').getImageData(x, y, 1, 1).data];
  await commit(dir, { type: 'layer.add', layer: { type: 'paint', name: 'Ink' } });
  // opacity applies to the whole stroke: where it crosses itself it is not darker
  const s = await commit(dir, { type: 'paint.stroke', id: 'Ink', stroke: { color: '#000000', size: 6, opacity: 0.5, points: [[5, 10], [25, 10], [15, 4], [15, 16]] } });
  assert.match(s.text, /opacity 50%/);
  const once = (await px(8, 10))[0], cross = (await px(15, 10))[0];
  assert.ok(Math.abs(once - 128) <= 2 && Math.abs(cross - once) <= 1, `${once} vs ${cross}`);
  // soft edge: partial alpha at the rim, full in the middle
  await commit(dir, { type: 'paint.stroke', id: 'Ink', stroke: { color: '#000000', size: 12, hardness: 0, points: [[45, 10]] } });
  assert.ok((await px(45, 10))[0] < 60 && (await px(50, 10))[0] > 60);
  // blend mode on the stroke: multiply red over the gray stroke
  await commit(dir, { type: 'paint.stroke', id: 'Ink', stroke: { color: '#ff0000', size: 6, blend: 'multiply', points: [[8, 10]] } });
  const mul = await px(8, 10);
  assert.ok(mul[0] > 100 && mul[1] < 20, `${mul}`);
  // pressure: thin where pressure is low
  await commit(dir, { type: 'layer.add', layer: { type: 'paint', name: 'Pen' } });
  await commit(dir, { type: 'paint.stroke', id: 'Pen', stroke: { color: '#0000ff', size: 10, points: [[30, 3, 0.1], [40, 3, 0.1], [50, 17, 1], [58, 17, 1]] } });
  assert.ok((await px(35, 6)).slice(0, 3).every(v => v >= 250)); // ~1px wide where pressure is low: nothing 3px away
  assert.ok((await px(35, 3))[0] < 200);                           // but the thin line is there
  assert.deepEqual(await px(54, 13), [0, 0, 255, 255]); // full width (10px) at the end
  // blur and sharpen brushes
  const dir2 = tmp();
  await initProject(dir2, { width: 40, height: 20, background: '#ffffff' });
  await commit(dir2, { type: 'layer.add', layer: { type: 'shape', name: 'Black', x: 20, y: 0, w: 20, h: 20, fill: '#000000' } });
  await commit(dir2, { type: 'layer.add', layer: { type: 'paint', name: 'Fix' } });
  const b = await commit(dir2, { type: 'paint.blur', id: 'Fix', points: [[20, 10]], size: 16, hardness: 1, strength: 3 });
  assert.match(b.text, /Blurred along a 1-point stroke on "Fix" \(strength 3\)/);
  const edge = [...(await renderCanvas(dir2, loadState(dir2).doc)).getContext('2d').getImageData(18, 10, 1, 1).data];
  assert.ok(edge[0] > 30 && edge[0] < 240, `blurred edge ${edge}`);
  await assert.rejects(commit(dir2, { type: 'paint.sharpen', id: 'Fix', points: [[5, 5]], strength: 500 }), /strength/);
});

test('image size resamples everything; guides follow the canvas', async () => {
  const dir = tmp();
  await initProject(dir, { width: 40, height: 20, background: '#ffffff' });
  const px = async (x, y) => [...(await renderCanvas(dir, loadState(dir).doc)).getContext('2d').getImageData(x, y, 1, 1).data];
  await commit(dir, { type: 'layer.add', layer: { type: 'shape', name: 'Box', x: 20, y: 0, w: 20, h: 20, fill: '#ff0000' } });
  await commit(dir, { type: 'layer.maskStroke', id: 'Box', mode: 'hide', stroke: { points: [[30, 10]], size: 6, hardness: 1 } });
  await commit(dir, { type: 'selection.set', shape: { type: 'rect', x: 20, y: 0, w: 5, h: 20 } });
  await commit(dir, { type: 'layer.mask', id: 'Box', mode: 'hide' });
  await commit(dir, { type: 'guide.add', axis: 'x', pos: 20 });
  await commit(dir, { type: 'path.add', path: { d: 'M 0 0 L 40 20' } });
  const r = await commit(dir, { type: 'canvas.scale', percent: 200 });
  assert.match(r.text, /Image size 40×20 → 80×40/);
  const d = loadState(dir).doc;
  assert.deepEqual([d.width, d.height, d.guides[0].pos], [80, 40, 40]);
  assert.deepEqual(d.selection.items[0].m, [2, 0, 0, 2, 0, 0]); // the selection scales with the image
  assert.deepEqual(d.paths[0].subpaths[0].anchors.at(-1), { x: 80, y: 40 });
  assert.deepEqual(await px(70, 20), [255, 0, 0, 255]);      // box doubled
  assert.deepEqual(await px(60, 20), [255, 255, 255, 255]);  // painted mask hole doubled too (centre 60,20)
  assert.deepEqual(await px(45, 20), [255, 255, 255, 255]);  // selection-mask strip (was x 20–25, now 40–50)
  assert.deepEqual(await px(52, 5), [255, 0, 0, 255]);
  await commit(dir, { type: 'canvas.crop', x: 10, y: 0, width: 70, height: 40 });
  assert.equal(loadState(dir).doc.guides[0].pos, 30);
  await commit(dir, { type: 'guide.remove', axis: 'x', pos: 30 });
  assert.equal(loadState(dir).doc.guides.length, 0);
});

test('filters: unsharp mask, noise reduction, high pass', async () => {
  const { unsharp, denoise, highPass } = await import('../src/tone.js');
  const img = (w, h, f) => { const d = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < w * h; i++) { const v = f(i % w, Math.floor(i / w)); d.set([v, v, v, 255], i * 4); } return { width: w, height: h, data: d }; };
  // unsharp: an edge gets more contrast on both sides
  const e = unsharp(img(20, 4, x => (x < 10 ? 100 : 160)), { radius: 2, amount: 1, threshold: 0 });
  assert.ok(e.data[(1 * 20 + 8) * 4] < 100 && e.data[(1 * 20 + 11) * 4] > 160);
  // threshold: small differences are left alone
  const t = unsharp(img(20, 4, x => (x < 10 ? 100 : 104)), { radius: 2, amount: 1, threshold: 20 });
  assert.equal(t.data[(1 * 20 + 9) * 4], 100);
  // high pass: flat areas become mid-gray
  assert.equal(highPass(img(10, 10, () => 30), { radius: 3 }).data[0], 128);
  // noise reduction: noise on a flat area shrinks, a strong edge stays sharp
  let s = 5; const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const noisy = img(40, 20, x => (x < 20 ? 60 : 200) + Math.round((r() - 0.5) * 30));
  const spread = (im, x0, x1) => { const v = []; for (let y = 2; y < 18; y++) for (let x = x0; x < x1; x++) v.push(im.data[(y * 40 + x) * 4]); const m = v.reduce((a, b) => a + b) / v.length; return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length); };
  const before = spread(noisy, 3, 16);
  denoise(noisy, { strength: 40, radius: 2 });
  assert.ok(spread(noisy, 3, 16) < before * 0.6, 'noise reduced');
  assert.ok(noisy.data[(10 * 40 + 18) * 4] < 100 && noisy.data[(10 * 40 + 21) * 4] > 160, 'edge kept');

  // as layer properties, through commit
  const dir = tmp();
  await initProject(dir, { width: 10, height: 10, background: null });
  await commit(dir, { type: 'layer.add', layer: { type: 'shape', name: 'Gray', x: 0, y: 0, w: 10, h: 10, fill: '#202020' } });
  const hp = await commit(dir, { type: 'layer.update', id: 'Gray', props: { highPass: { radius: 2 } } });
  assert.match(hp.text, /high pass on \(radius 2\)/);
  assert.equal([...(await renderCanvas(dir, loadState(dir).doc)).getContext('2d').getImageData(5, 5, 1, 1).data][0], 128);
  await assert.rejects(commit(dir, { type: 'layer.update', id: 'Gray', props: { sharpen: { amount: 50 } } }), /amount/);
});

test('PSD export/import round trip, PDF and SVG export', async () => {
  const { exportBuffer } = await import('../src/store.js');
  const dir = tmp();
  await initProject(dir, { width: 40, height: 20, background: '#ffffff' });
  await commit(dir, { type: 'layer.add', layer: { type: 'shape', name: 'Red', x: 0, y: 0, w: 20, h: 20, fill: '#ff0000' } });
  await commit(dir, { type: 'layer.add', layer: { type: 'shape', name: 'Blue', x: 10, y: 5, w: 20, h: 10, fill: '#0000ff', opacity: 0.5, blend: 'multiply' } });
  await commit(dir, { type: 'layer.group', ids: ['Blue'], name: 'G' });
  await commit(dir, { type: 'layer.add', layer: { type: 'adjustment', name: 'Adj' } });
  const psd = await exportBuffer(dir, 'psd');
  assert.match(psd.notes.join(), /adjustment layers left out: Adj/);
  const file = path.join(dir, 'x.psd');
  fs.writeFileSync(file, psd.buffer);

  const dir2 = tmp();
  await initProject(dir2, { width: 5, height: 5, background: null });
  const e = await commit(dir2, { type: 'doc.import', src: file });
  assert.match(e.text, /Imported "x.psd": 3 layers in 1 group, canvas set to 40×20/);
  const d = loadState(dir2).doc, blue = d.layers.find(l => l.name === 'Blue');
  assert.deepEqual([blue.opacity, blue.blend, d.layers.find(l => l.id === blue.parent).name], [0.5, 'multiply', 'G']);
  const a = (await renderCanvas(dir, loadState(dir).doc)).getContext('2d').getImageData(0, 0, 40, 20).data;
  const b = (await renderCanvas(dir2, d)).getContext('2d').getImageData(0, 0, 40, 20).data;
  assert.ok(a.every((v, i) => Math.abs(v - b[i]) <= 2), 'round trip renders the same');
  await commit(dir2, { type: 'history.undo' });
  assert.equal(loadState(dir2).doc.layers.length, 0); // one op, one undo

  const pdf = (await exportBuffer(dir, 'pdf')).buffer.toString('latin1');
  assert.ok(pdf.startsWith('%PDF-1.4') && pdf.trimEnd().endsWith('%%EOF') && pdf.includes('/MediaBox [0 0 40.00 20.00]'));
  const svg = (await exportBuffer(dir, 'svg')).buffer.toString();
  assert.match(svg, /^<svg [^>]*viewBox="0 0 40 20"/);
  assert.match(svg, /adjustment|<image/); // an adjustment layer makes it embed the flattened image
  await commit(dir, { type: 'layer.remove', id: 'Adj' });
  const vec = (await exportBuffer(dir, 'svg')).buffer.toString();
  assert.match(vec, /<rect transform="matrix\(1 0 0 1 0 0\)" width="20" height="20" fill="#ff0000"\/>/);
  assert.match(vec, /<g><rect [^>]*fill="#0000ff" opacity="0.5" style="mix-blend-mode:multiply"\/><\/g>/);
});

test('selection outline transform and saved channels', async () => {
  const { selectionCanvas, maskStats } = await import('../src/store.js');
  const dir = tmp();
  await initProject(dir, { width: 100, height: 100, background: null });
  const bbox = async () => maskStats(await selectionCanvas(dir, loadState(dir).doc, loadState(dir).doc.selection)).bbox;
  await commit(dir, { type: 'selection.set', shape: { type: 'rect', x: 40, y: 45, w: 20, h: 10 } });
  const t = await commit(dir, { type: 'selection.transform', scale: 2 });
  assert.match(t.text, /scaled 200% about \(50, 50\)/);
  assert.deepEqual(await bbox(), [30, 40, 40, 20]);
  await commit(dir, { type: 'selection.transform', rotate: 90 });
  assert.deepEqual(await bbox(), [40, 30, 20, 40]);
  await commit(dir, { type: 'selection.translate', dx: 10, dy: 0 });   // still works after a transform
  assert.deepEqual(await bbox(), [50, 30, 20, 40]);
  // channels: save, change the selection, load back (replace / add)
  await commit(dir, { type: 'channel.save', name: 'Tall' });
  await commit(dir, { type: 'selection.set', shape: { type: 'rect', x: 0, y: 0, w: 10, h: 10 } });
  await commit(dir, { type: 'channel.load', name: 'Tall', mode: 'add' });
  assert.deepEqual(await bbox(), [0, 0, 70, 70]);
  await commit(dir, { type: 'channel.load', name: 'Tall' });
  assert.deepEqual(await bbox(), [50, 30, 20, 40]);
  // the channel follows a crop and image size
  await commit(dir, { type: 'canvas.crop', x: 10, y: 0, width: 90, height: 100 });
  await commit(dir, { type: 'canvas.scale', percent: 50 });
  await commit(dir, { type: 'channel.load', name: 'Tall' });
  assert.deepEqual(await bbox(), [20, 15, 10, 20]);
  await commit(dir, { type: 'channel.remove', name: 'Tall' });
  await assert.rejects(commit(dir, { type: 'channel.load', name: 'Tall' }), /No channel/);
});

test('perspective and warp meshes', async () => {
  const { squareToQuad } = await import('../src/render.js');
  const H = squareToQuad([[10, 10], [90, 20], [80, 90], [5, 70]]);
  assert.deepEqual([H(0, 0), H(1, 0), H(1, 1), H(0, 1)].map(p => p.map(v => Math.round(v))), [[10, 10], [90, 20], [80, 90], [5, 70]]);
  const dir = tmp();
  await initProject(dir, { width: 40, height: 40, background: '#ffffff' });
  const px = async (x, y) => [...(await renderCanvas(dir, loadState(dir).doc)).getContext('2d').getImageData(x, y, 1, 1).data];
  const red = async (x, y) => { const c = await px(x, y); return c[0] > 240 && c[1] < 40 && c[2] < 40; };
  const white = async (x, y) => (await px(x, y)).slice(0, 3).every(v => v > 230);
  await commit(dir, { type: 'layer.add', layer: { type: 'shape', name: 'Sq', x: 10, y: 10, w: 20, h: 20, fill: '#ff0000' } });
  const p = await commit(dir, { type: 'layer.perspective', id: 'Sq', corners: [[0, 0], [40, 0], [40, 40], [0, 40]] });
  assert.match(p.text, /Perspective — perspective \(4 corners\)/);
  assert.ok(await red(2, 37));   // stretched to the canvas corners
  // keystone: narrow at the top
  await commit(dir, { type: 'layer.perspective', id: 'Sq', corners: [[15, 0], [25, 0], [40, 40], [0, 40]] });
  assert.ok(await white(5, 2));
  assert.ok(await red(5, 38));
  // warp: pull the middle of the bottom edge down → it bulges below the original box
  await commit(dir, { type: 'layer.update', id: 'Sq', props: { mesh: null } });
  const w = await commit(dir, { type: 'layer.warp', id: 'Sq', cols: 2, rows: 1, moves: [{ i: 1, j: 1, dx: 0, dy: 8 }] });
  assert.match(w.text, /Warp — warp \(2×1 grid\)/);
  assert.ok(await red(20, 35));   // was white (box ended at y=30)
  assert.ok(await white(11, 32)); // the corners stay
  await assert.rejects(commit(dir, { type: 'layer.update', id: 'Sq', props: { mesh: { kind: 'warp', cols: 2, rows: 2, points: [[0, 0]] } } }), /needs 9 points/);
});

test('liquify and distort filters', async () => {
  const dir = tmp();
  await initProject(dir, { width: 80, height: 40, background: '#ffffff' });
  const px = async (x, y) => [...(await renderCanvas(dir, loadState(dir).doc)).getContext('2d').getImageData(x, y, 1, 1).data];
  const red = async (x, y) => (await px(x, y))[1] < 60;
  // left half red, right half white (inside one 80×40 image layer)
  const c = createCanvas(80, 40), cx = c.getContext('2d');
  cx.fillStyle = '#fff'; cx.fillRect(0, 0, 80, 40); cx.fillStyle = '#f00'; cx.fillRect(0, 0, 40, 40);
  fs.writeFileSync(path.join(dir, 'half.png'), await c.encode('png'));
  await commit(dir, { type: 'layer.add', layer: { type: 'image', src: path.join(dir, 'half.png'), x: 0, y: 0 } });
  assert.equal(await red(46, 20), false);
  // push the red edge to the right
  const l = await commit(dir, { type: 'layer.liquify', id: 'half.png', stroke: { mode: 'push', points: [[30, 20], [50, 20]], size: 40, strength: 1 } });
  assert.match(l.text, /Liquify \(push\) on "half.png": a 2-point stroke/);
  assert.equal(await red(46, 20), true);
  assert.equal(await red(46, 2), false); // outside the brush: unchanged
  // the effect stays with the layer when it moves
  await commit(dir, { type: 'layer.update', id: 'half.png', props: { x: 10 } });
  assert.equal(await red(56, 20), true);
  await commit(dir, { type: 'layer.update', id: 'half.png', props: { x: 0, liquify: null } });
  assert.equal(await red(46, 20), false);
  // twirl distort turns the vertical edge sideways near the centre
  await commit(dir, { type: 'layer.update', id: 'half.png', props: { distort: { kind: 'twirl', amount: 90, radius: 1 } } });
  assert.notEqual(await red(40, 12), await red(40, 28)); // above/below the centre the edge moved opposite ways
  await commit(dir, { type: 'layer.update', id: 'half.png', props: { distort: null } });
  await assert.rejects(commit(dir, { type: 'layer.update', id: 'half.png', props: { distort: { kind: 'melt' } } }), /distort kind/);
});

test('text on a path', async () => {
  const { flatten, pointAt, parseSvgPath } = await import('../src/paths.js');
  const f = flatten(parseSvgPath('M 0 0 L 100 0 L 100 100')[0]);
  assert.equal(Math.round(f.total), 200);
  assert.deepEqual(Object.values(pointAt(f, 150)).map(v => Math.round(v * 100) / 100), [100, 50, 1.57]);
  const dir = tmp();
  await initProject(dir, { width: 200, height: 120, background: '#ffffff' });
  await commit(dir, { type: 'path.add', path: { name: 'Line', d: 'M 20 100 L 180 20' } });
  await commit(dir, { type: 'layer.add', layer: { type: 'text', text: 'WWWWWWWW', size: 20, color: '#000000', name: 'T' } });
  const e = await commit(dir, { type: 'text.onPath', id: 'T', path: 'Line' });
  assert.match(e.text, /Put the text on path "Line" — moved \(0, 0\) → \(-4, -4\); text follows a path/);
  const ink = async (x, y) => { const d = (await renderCanvas(dir, loadState(dir).doc)).getContext('2d').getImageData(x - 6, y - 6, 12, 12).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 100) n++; return n; };
  assert.ok(await ink(60, 74) > 5, 'glyphs along the slanted line');
  assert.equal(await ink(60, 20), 0, 'nothing where flat text would have been');
  await commit(dir, { type: 'layer.update', id: 'T', props: { path: null } });
  await assert.rejects(commit(dir, { type: 'text.onPath', id: 'T', path: 'Nope' }), /No path/);
});

test('GIMP XCF: export/import, and reading v3 RLE / v11 64-bit / raw files', async () => {
  const { writeXcf, readXcf } = await import('../src/xcf.js');
  // reader against every writer variant, including a mix of runs and literals in the pixels
  const w = 70, h = 66, rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) rgba.set(i % w < 30 ? [200, 10, 10, 255] : [(i * 7) % 256, (i * 13) % 256, 50, i % 3 ? 255 : 128], i * 4);
  const layers = [{ name: 'Group', blend: 'normal', opacity: 1, visible: true, children: [{ name: 'Inner', x: 5, y: 6, w, h, rgba, blend: 'multiply', opacity: 0.5, visible: false }] },
    { name: 'Bottom', x: 0, y: 0, w, h, rgba, blend: 'screen', opacity: 1, visible: true }];
  for (const opts of [{}, { version: 3, compression: 'rle' }, { version: 11, compression: 'zlib' }, { version: 11, compression: 'rle' }, { version: 10, compression: 'none' }]) {
    const x = readXcf(writeXcf({ width: 100, height: 80, layers }, opts));
    const names = x.layers.map(l => `${l.name}${l.group ? '/' : ''}${l.path ? JSON.stringify(l.path) : ''}`);
    assert.deepEqual(names, ['Group/', 'Inner[0,0]', 'Bottom'], JSON.stringify(opts));
    const inner = x.layers[1];
    assert.deepEqual([inner.x, inner.y, inner.blend, inner.opacity, inner.visible], [5, 6, 'multiply', 0.5, false]);
    assert.ok(inner.rgba.every((v, i) => v === rgba[i]), `pixels survive ${JSON.stringify(opts)}`);
  }
  // through the app: groups and modes come back
  const { exportBuffer } = await import('../src/store.js');
  const dir = tmp();
  await initProject(dir, { width: 40, height: 20, background: '#ffffff' });
  await commit(dir, { type: 'layer.add', layer: { type: 'shape', name: 'Red', x: 0, y: 0, w: 20, h: 20, fill: '#ff0000' } });
  await commit(dir, { type: 'layer.add', layer: { type: 'shape', name: 'Blue', x: 10, y: 5, w: 20, h: 10, fill: '#0000ff', opacity: 0.5, blend: 'multiply' } });
  await commit(dir, { type: 'layer.group', ids: ['Blue'], name: 'G' });
  const file = path.join(dir, 'x.xcf');
  fs.writeFileSync(file, (await exportBuffer(dir, 'xcf')).buffer);
  const dir2 = tmp();
  await initProject(dir2, { width: 5, height: 5, background: null });
  const e = await commit(dir2, { type: 'doc.import', src: file });
  assert.match(e.text, /Imported "x.xcf": 3 layers in 1 group, canvas set to 40×20/);
  const d = loadState(dir2).doc, blue = d.layers.find(l => l.name === 'Blue');
  assert.deepEqual([blue.opacity, blue.blend, d.layers.find(l => l.id === blue.parent).name], [0.5, 'multiply', 'G']);
  const a = (await renderCanvas(dir, loadState(dir).doc)).getContext('2d').getImageData(0, 0, 40, 20).data;
  const b = (await renderCanvas(dir2, d)).getContext('2d').getImageData(0, 0, 40, 20).data;
  assert.ok(a.every((v, i) => Math.abs(v - b[i]) <= 2), 'renders the same');
});

test('pixelate, emboss, lens; stroke selection; paste between projects; scissors and foreground select', async () => {
  const { pixelate, emboss } = await import('../src/tone.js');
  const img = (w, h, f) => { const d = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < w * h; i++) d.set([...f(i % w, Math.floor(i / w)), 255], i * 4); return { width: w, height: h, data: d }; };
  const p = pixelate(img(8, 8, x => [x * 30, 0, 0]), { size: 4 });
  assert.equal(p.data[0], p.data[3 * 4]); assert.equal(p.data[0], Math.round((0 + 30 + 60 + 90) / 4));
  const em = emboss(img(10, 10, x => (x < 5 ? [0, 0, 0] : [255, 255, 255])), { azimuth: 0, elevation: 45, depth: 10, keepColor: 0 });
  assert.ok(em.data[(5 * 10 + 1) * 4] === em.data[(5 * 10 + 1) * 4 + 1] && em.data[(5 * 10 + 4) * 4] !== em.data[(5 * 10 + 1) * 4], 'gray relief at the edge');

  const dir = tmp();
  await initProject(dir, { width: 40, height: 40, background: '#ffffff' });
  const px = async (x, y) => [...(await renderCanvas(dir, loadState(dir).doc)).getContext('2d').getImageData(x, y, 1, 1).data];
  // lens: barrel distortion samples further out near the corners, so the square's corners empty out
  await commit(dir, { type: 'layer.add', layer: { type: 'shape', name: 'Sq', x: 10, y: 10, w: 20, h: 20, fill: '#ff0000' } });
  await commit(dir, { type: 'layer.update', id: 'Sq', props: { distort: { kind: 'lens', main: 100 } } });
  assert.deepEqual(await px(11, 11), [255, 255, 255, 255]);
  assert.deepEqual(await px(20, 20), [255, 0, 0, 255]);
  await commit(dir, { type: 'layer.update', id: 'Sq', props: { distort: null } });
  // stroke selection: a band along the edge, centred
  await commit(dir, { type: 'selection.set', shape: { type: 'rect', x: 10, y: 10, w: 20, h: 20 } });
  const s = await commit(dir, { type: 'edit.strokeSelection', color: '#0000ff', width: 4 });
  assert.match(s.text, /Stroked the selection outline with #0000ff, 4px centered on the edge/);
  assert.deepEqual(await px(9, 20), [0, 0, 255, 255]); assert.deepEqual(await px(11, 20), [0, 0, 255, 255]);
  assert.deepEqual(await px(20, 20), [255, 0, 0, 255]);
  await commit(dir, { type: 'edit.strokeSelection', color: '#00ff00', width: 3, position: 'outside' });
  assert.deepEqual(await px(7, 20), [0, 255, 0, 255]);

  // paste layers from another project: groups, masks and assets come along
  const other = tmp();
  await initProject(other, { width: 80, height: 40, background: null });
  const c = createCanvas(10, 10); c.getContext('2d').fillStyle = '#123456'; c.getContext('2d').fillRect(0, 0, 10, 10);
  fs.writeFileSync(path.join(other, 'p.png'), await c.encode('png'));
  await commit(other, { type: 'layer.add', layer: { type: 'image', src: path.join(other, 'p.png'), x: 35, y: 15, name: 'Pic' } });
  await commit(other, { type: 'layer.group', ids: ['Pic'], name: 'Grp' });
  const pa = await commit(dir, { type: 'layer.paste', from: other, ids: ['Grp'] });
  assert.match(pa.text, /Pasted "Grp" from project ".*": 1 layer in 1 group/);
  const pic = loadState(dir).doc.layers.find(l => l.name === 'Pic');
  assert.deepEqual([pic.x, pic.y, loadState(dir).doc.layers.find(l => l.id === pic.parent).name], [15, 15, 'Grp']); // centred: (40−80)/2 shift
  assert.ok(fs.existsSync(path.join(dir, 'assets', pic.asset)), 'image file copied');
  assert.deepEqual(await px(20, 20), [0x12, 0x34, 0x56, 255]);
  await commit(dir, { type: 'history.undo' });
  assert.ok(!loadState(dir).doc.layers.some(l => l.name === 'Pic'));

  // smart selections on a disc (centre 50,50 r 25) over a gradient
  const d2 = tmp();
  await initProject(d2, { width: 100, height: 100, background: null });
  const b = createCanvas(100, 100), bx = b.getContext('2d'), g = bx.createLinearGradient(0, 0, 100, 100);
  g.addColorStop(0, '#5d8aa8'); g.addColorStop(1, '#a3c4dc'); bx.fillStyle = g; bx.fillRect(0, 0, 100, 100);
  bx.fillStyle = '#e8743b'; bx.beginPath(); bx.arc(50, 50, 25, 0, 7); bx.fill();
  fs.writeFileSync(path.join(d2, 'b.png'), await b.encode('png'));
  await commit(d2, { type: 'layer.add', layer: { type: 'image', src: path.join(d2, 'b.png'), x: 0, y: 0 } });
  const { selectionCanvas, maskStats } = await import('../src/store.js');
  const bbox = async () => maskStats(await selectionCanvas(d2, loadState(d2).doc, loadState(d2).doc.selection)).bbox;
  const sc = await commit(d2, { type: 'selection.scissors', anchors: [[50, 25], [75, 50], [50, 75], [25, 50]] });
  assert.match(sc.text, /intelligent scissors through 4 anchors/);
  const sb = await bbox();
  assert.ok(sb.every((v, i) => Math.abs(v - [25, 25, 51, 51][i]) <= 2), `scissors follow the disc: ${sb}`);
  await commit(d2, { type: 'selection.foreground', outline: [[10, 10], [90, 10], [90, 90], [10, 90]] });
  const fb = await bbox();
  assert.ok(fb.every((v, i) => Math.abs(v - [25, 25, 51, 51][i]) <= 2), `foreground finds the disc: ${fb}`);
});
