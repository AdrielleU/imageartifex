import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OPS, openApiSpec, opCatalog } from '../src/opschema.js';

// Op types the code handles: applyOpMut (model) and materialize (store) switch cases.
function handled() {
  const cases = (file, from, to) => {
    const src = fs.readFileSync(new URL(file, import.meta.url), 'utf8'), a = src.indexOf(from), b = src.indexOf(to, a);
    return [...src.slice(a, b).matchAll(/case '([a-zA-Z]+\.[a-zA-Z]+)'/g)].map(m => m[1]);
  };
  return new Set([...cases('../src/model.js', 'export function applyOpMut', 'export function applyOp('),
    ...cases('../src/store.js', 'async function materialize', 'export async function commit')]);
}

test('every op the code handles is documented, and nothing extra', () => {
  const code = handled(), docs = new Set(Object.keys(OPS));
  assert.deepEqual([...code].filter(t => !docs.has(t)), [], 'ops missing from src/opschema.js');
  assert.deepEqual([...docs].filter(t => !code.has(t)), [], 'documented ops the code does not handle');
});

test('OpenAPI document: refs resolve, examples have their required fields', () => {
  const spec = openApiSpec(), seen = [];
  const walk = v => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) k === '$ref' ? seen.push(x) : walk(x); };
  walk(spec);
  for (const r of seen) {
    const target = r.replace(/^#\//, '').split('/').reduce((o, k) => o?.[k], spec);
    assert.ok(target, `unresolved ${r}`);
  }
  for (const { type, schema, example } of opCatalog()) {
    for (const k of schema.required) assert.ok(k in example, `${type} example lacks required "${k}"`);
    for (const k of Object.keys(example)) assert.ok(k in schema.properties, `${type} example has undocumented "${k}"`);
  }
  assert.equal(spec.openapi, '3.1.0');
});

test('HTTP API: batch ops, catalog, openapi, histogram', async () => {
  const { initProject } = await import('../src/store.js');
  const { serve } = await import('../src/server.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifex-'));
  await initProject(dir, { width: 20, height: 20, background: '#ffffff' });
  const log = console.log; console.log = () => {};
  const server = serve(dir, { port: 0 });
  await new Promise(r => server.once('listening', r));
  console.log = log;
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = body => fetch(`${base}/api/ops`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    let r = await post({ author: 'agent', op: [{ type: 'layer.add', layer: { type: 'shape', name: 'A', w: 5, h: 5 } }, { type: 'layer.update', id: 'A', props: { x: 3 } }] });
    let body = await r.json();
    assert.equal(r.status, 200);
    assert.deepEqual(body.entries.map(e => e.author), ['agent', 'agent']);
    r = await post({ op: [{ type: 'layer.update', id: 'A', props: { y: 1 } }, { type: 'layer.update', id: 'Nope', props: {} }, { type: 'selection.all' }] });
    body = await r.json();
    assert.equal(r.status, 400);
    assert.equal(body.index, 1);
    assert.match(body.error, /op 1 \(layer.update\): No layer "Nope"/);
    assert.equal(body.entries.length, 1); // the first op stayed applied, the third never ran
    const spec = await (await fetch(`${base}/api/openapi.json`)).json();
    assert.match(spec.servers[0].url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal((await (await fetch(`${base}/api/ops/catalog`)).json()).length, Object.keys(OPS).length);
    const h = await (await fetch(`${base}/api/histogram`)).json();
    assert.equal(h.count, 400);
  } finally { server.close(); }
});

test('docs/openapi.json is up to date (regenerate: node bin/artifex.js openapi docs/openapi.json)', () => {
  const file = JSON.parse(fs.readFileSync(new URL('../docs/openapi.json', import.meta.url), 'utf8'));
  assert.deepEqual(file, JSON.parse(JSON.stringify(openApiSpec({ server: 'http://127.0.0.1:4747' }))));
});
