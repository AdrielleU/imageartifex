// Local HTTP server for the browser editor. The browser and the CLI both write to the same
// history.jsonl; a file watcher pushes changes to open editors over Server-Sent Events.
// Several projects: every endpoint takes ?project=<folder name> (a project folder inside `root`, which defaults
// to the folder containing the project the server was started with); without it, that starting project is used.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadState, undoneSeqs, commit, importAsset, historyFile, pickColor, layerHistogram, histogramStats, exportBuffer, isProject, initProject } from './store.js';
import crypto from 'node:crypto';
import { openApiSpec, opCatalog } from './opschema.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.avif': 'image/avif' };

const EXPORT_TYPES = { xcf: 'image/x-xcf', psd: 'image/vnd.adobe.photoshop', pdf: 'application/pdf', svg: 'image/svg+xml', jpeg: 'image/jpeg', jpg: 'image/jpeg' };

function sendFile(res, base, rel, cache) {
  const file = path.resolve(base, '.' + path.posix.normalize('/' + rel));
  if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, { error: 'not found' });
  res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': cache || 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

function stateJson(dir) {
  const state = loadState(dir), undone = undoneSeqs(state);
  return {
    doc: state.doc,
    canUndo: state.active.length > 1, // never undo the initial canvas.new
    canRedo: state.redo.length > 0,
    entries: state.entries.map(e => ({ seq: e.seq, ts: e.ts, author: e.author, type: e.op.type, text: e.text, undone: undone.has(e.seq) })),
  };
}

const PROJECT_NAME = /^[\w][\w .-]{0,79}$/;

export function serve(startDir, { port = 4747, host = '127.0.0.1', root = path.dirname(path.resolve(startDir)) } = {}) {
  root = path.resolve(root);
  const watchers = new Map(); // project dir → { watcher, clients, timer }
  const channel = dir => {
    if (!watchers.has(dir)) {
      const ch = { clients: new Set(), timer: null };
      ch.watcher = fs.watch(historyFile(dir), () => {
        clearTimeout(ch.timer);
        ch.timer = setTimeout(() => { for (const res of ch.clients) res.write('event: change\ndata: {}\n\n'); }, 50);
      });
      watchers.set(dir, ch);
    }
    return watchers.get(dir);
  };
  channel(path.resolve(startDir));
  const projectDir = name => {
    if (!name) return path.resolve(startDir);
    const d = path.resolve(root, name);
    if (!PROJECT_NAME.test(name) || path.dirname(d) !== root || !isProject(d)) throw new Error(`No project "${name}" in ${root}`);
    return d;
  };
  const listProjects = () => fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && isProject(path.join(root, e.name))).map(e => {
    const d = path.join(root, e.name), { doc } = loadState(d);
    return { name: e.name, width: doc.width, height: doc.height, layers: doc.layers.length, modified: fs.statSync(historyFile(d)).mtime.toISOString(), start: d === path.resolve(startDir) };
  }).sort((a, b) => b.modified.localeCompare(a.modified));

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    try {
      if (p === '/' || p === '/index.html') return sendFile(res, path.join(ROOT, 'web'), 'index.html');
      if (p.startsWith('/web/')) return sendFile(res, path.join(ROOT, 'web'), p.slice(5));
      if (['/src/model.js', '/src/render.js', '/src/tone.js', '/src/paths.js', '/src/smartselect.js'].includes(p)) return sendFile(res, path.join(ROOT, 'src'), p.slice(5));
      if (p === '/api/projects' && req.method === 'POST') {
        const { name, width = 1200, height = 800, background = '#ffffff' } = JSON.parse(await readBody(req) || '{}');
        if (!PROJECT_NAME.test(name || '')) throw new Error('Project names use letters, numbers, spaces, dot, dash, underscore');
        const d = path.join(root, name);
        if (fs.existsSync(d)) throw new Error(`"${name}" already exists`);
        await initProject(d, { width, height, background });
        return send(res, 200, { name });
      }
      if (p === '/api/projects') return send(res, 200, { root, projects: listProjects() });
      const dir = projectDir(url.searchParams.get('project'));
      if (p.startsWith('/assets/')) return sendFile(res, path.join(dir, 'assets'), p.slice(8), 'max-age=31536000, immutable');
      if (p === '/api/state') return send(res, 200, stateJson(dir));
      if (p === '/api/pick') {
        const q = url.searchParams;
        return send(res, 200, await pickColor(dir, loadState(dir).doc, Number(q.get('x')), Number(q.get('y')), { layer: q.get('layer') || undefined }));
      }
      if (p === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write('retry: 1000\n\n');
        const ch = channel(dir);
        ch.clients.add(res);
        req.on('close', () => ch.clients.delete(res));
        return;
      }
      if (p === '/api/ops' && req.method === 'POST') {
        const { op, author = 'user' } = JSON.parse(await readBody(req));
        if (!Array.isArray(op)) return send(res, 200, { entry: await commit(dir, op, author) });
        // A batch is applied in order and stops at the first failing op (earlier ones stay applied).
        const entries = [];
        for (const [index, o] of op.entries()) {
          try { entries.push(await commit(dir, o, author)); } catch (err) { return send(res, 400, { error: `op ${index} (${o?.type}): ${err.message}`, index, entries }); }
        }
        return send(res, 200, { entries });
      }
      if (p === '/api/openapi.json') {
        return send(res, 200, openApiSpec({ server: `http://${req.headers.host || `${host}:${port}`}` }));
      }
      if (p === '/api/ops/catalog') return send(res, 200, opCatalog());
      if (p === '/api/histogram') {
        const h = await layerHistogram(dir, loadState(dir).doc, url.searchParams.get('layer') || undefined);
        return send(res, 200, { count: h.count, ...histogramStats(h) });
      }
      if (p === '/api/upload' && req.method === 'POST') {
        const body = await readBody(req), name = url.searchParams.get('name') || 'upload.png';
        const layered = name.match(/\.(psd|xcf)$/i);
        if (layered) { // layered files are kept as-is; import them with {"type":"doc.import","src": file}
          fs.mkdirSync(path.join(dir, 'imports'), { recursive: true });
          const file = `imports/${crypto.createHash('sha1').update(body).digest('hex').slice(0, 12)}.${layered[1].toLowerCase()}`;
          fs.writeFileSync(path.join(dir, file), body);
          return send(res, 200, { file, name });
        }
        return send(res, 200, await importAsset(dir, body, name));
      }
      if (p === '/api/export') {
        const format = (url.searchParams.get('format') || 'png').toLowerCase();
        const { buffer, notes } = await exportBuffer(dir, format, { dpi: Number(url.searchParams.get('dpi')) || undefined });
        res.writeHead(200, { 'content-type': EXPORT_TYPES[format] || TYPES['.' + format] || 'application/octet-stream',
          'content-disposition': `attachment; filename="export.${format}"`, ...(notes.length ? { 'x-artifex-notes': encodeURIComponent(notes.join('; ')) } : {}) });
        return res.end(buffer);
      }
      send(res, 404, { error: 'not found' });
    } catch (err) {
      send(res, 400, { error: err.message });
    }
  });
  server.on('close', () => { for (const ch of watchers.values()) { ch.watcher.close(); for (const res of ch.clients) res.end(); } });
  server.listen(port, host, () => console.log(`ImageArtifex editor: http://${host}:${port}  (project: ${startDir}; other projects in ${root} via ?project=<name>)`));
  return server;
}
