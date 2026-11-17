// Kleine server voor het inrichtingsmodel: serveert de site, bewaart de ontwerpen
// op de schijf van Render en stuurt wijzigingen live door naar iedereen die kijkt.
// Geen externe pakketten nodig (Node 18 of nieuwer).
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = +process.env.PORT || 10000;
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const STORE = path.join(DATA_DIR, 'store.json');
const BACKUPS = path.join(DATA_DIR, 'backups');
const PASSWORD = process.env.HUIS_WACHTWOORD || '';
const MAX_BODY = 3 * 1024 * 1024;
const COLLECTIONS = new Set(['variants', 'custom', 'inspo', 'meta']);
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/ontwerp.json': ['ontwerp.json', 'application/json; charset=utf-8'],
};

fs.mkdirSync(BACKUPS, { recursive: true });

/* ---------- opslag ---------- */
let docs = {};       // "variants/var0" -> data
let profiles = {};   // user id -> {name, color}
try {
  const s = JSON.parse(fs.readFileSync(STORE, 'utf8'));
  docs = s.docs || {}; profiles = s.profiles || {};
} catch (e) {
  try {
    const seed = JSON.parse(fs.readFileSync(path.join(ROOT, 'seed.json'), 'utf8'));
    docs = seed.docs || {};
    console.log('Startdata geladen uit seed.json:', Object.keys(docs).length, 'documenten');
  } catch (e2) { console.log('Lege opslag'); }
}
let writeT = null, lastBackup = 0;
function persist() {
  clearTimeout(writeT);
  writeT = setTimeout(() => {
    const body = JSON.stringify({ docs, profiles, at: new Date().toISOString() });
    const tmp = STORE + '.tmp';
    fs.writeFile(tmp, body, err => {
      if (err) return console.error('Opslaan mislukt', err);
      fs.rename(tmp, STORE, err2 => { if (err2) console.error('Opslaan mislukt', err2); });
      // elk uur een reservekopie, de laatste 72 bewaren
      if (Date.now() - lastBackup > 3600e3) {
        lastBackup = Date.now();
        const name = 'store-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
        fs.writeFile(path.join(BACKUPS, name), body, () => {
          fs.readdir(BACKUPS, (e, list) => {
            if (e) return;
            list.filter(f => f.startsWith('store-')).sort().slice(0, -72)
              .forEach(f => fs.unlink(path.join(BACKUPS, f), () => {}));
          });
        });
      }
    });
  }, 300);
}

/* ---------- live verbindingen ---------- */
const clients = new Map(); // peer -> res
const peers = new Map();   // peer -> {peer, id, name, color, presence, ts}
function send(res, event, data) { try { res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'); } catch (e) {} }
function broadcast(event, data) { for (const res of clients.values()) send(res, event, data); }
function peerList() {
  const now = Date.now();
  for (const [k, p] of peers) if (now - p.ts > 15000 || !clients.has(k)) peers.delete(k);
  return [...peers.values()].map(p => ({ peer: p.peer, id: p.id, name: p.name, color: p.color, presence: p.presence }));
}
setInterval(() => {
  for (const res of clients.values()) { try { res.write(': ping\n\n'); } catch (e) {} }
  broadcast('peers', peerList());
}, 20000);

/* ---------- hulpjes ---------- */
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(new Error('te groot')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
const fails = new Map(); // ip -> {n, until}
function clientIp(req) { return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(); }
function authorized(req) {
  if (!PASSWORD) return false;
  const ip = clientIp(req); const f = fails.get(ip);
  if (f && f.until > Date.now()) return false;
  const got = Buffer.from(String(req.headers['x-huis-key'] || ''));
  const want = Buffer.from(PASSWORD);
  const ok = got.length === want.length && crypto.timingSafeEqual(got, want);
  if (!ok && got.length) {
    const n = (f && f.until > Date.now() - 600e3 ? f.n : 0) + 1;
    fails.set(ip, { n, until: n >= 8 ? Date.now() + 600e3 : 0 });
  }
  return ok;
}
function cleanName(s) { return String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40); }
function decodeHeader(s) { try { return decodeURIComponent(String(s || '')); } catch (e) { return ''; } }
function rememberProfile(req) {
  const id = String(req.headers['x-huis-user'] || ''); const name = cleanName(decodeHeader(req.headers['x-huis-name']));
  if (ID_RE.test(id) && name && (!profiles[id] || profiles[id].name !== name)) { profiles[id] = { name, color: profiles[id] && profiles[id].color || colorFor(id) }; persist(); }
}
function colorFor(id) { const c = ['#2f5d50', '#8a4f7d', '#b5651d', '#3d5a80', '#6a7f3a', '#9b2f2f']; let h = 0; for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return c[h % c.length]; }

/* ---------- server ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    if (p === '/healthz') return json(res, 200, { ok: true });

    if (p === '/api/state' && req.method === 'GET') return json(res, 200, { docs });

    if (p === '/api/check' && req.method === 'GET') {
      if (!PASSWORD) return json(res, 503, { error: 'Er is op de server nog geen wachtwoord ingesteld (HUIS_WACHTWOORD).' });
      return authorized(req) ? json(res, 200, { ok: true }) : json(res, 401, { error: 'Onjuist wachtwoord' });
    }

    if (p === '/api/stream' && req.method === 'GET') {
      const peer = String(url.searchParams.get('peer') || '');
      if (!ID_RE.test(peer)) return json(res, 400, { error: 'peer' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 3000\n\n');
      const old = clients.get(peer); if (old) { try { old.end(); } catch (e) {} }
      clients.set(peer, res);
      send(res, 'init', { docs });
      send(res, 'peers', peerList());
      req.on('close', () => { if (clients.get(peer) === res) { clients.delete(peer); peers.delete(peer); broadcast('peers', peerList()); } });
      return;
    }

    if (p === '/api/presence' && req.method === 'POST') {
      const b = await readBody(req) || {};
      const peer = String(b.peer || ''), id = String(b.id || '');
      if (!ID_RE.test(peer) || !ID_RE.test(id)) return json(res, 400, { error: 'peer' });
      const name = cleanName(b.name) || 'Kijker';
      const prev = peers.get(peer);
      peers.set(peer, { peer, id, name, color: profiles[id] && profiles[id].color || colorFor(id), presence: b.presence && typeof b.presence === 'object' ? b.presence : {}, ts: Date.now() });
      const changed = !prev || prev.name !== name || JSON.stringify(prev.presence) !== JSON.stringify(b.presence);
      if (changed) broadcast('peers', peerList());
      return json(res, 200, { ok: true });
    }

    if (p === '/api/profiles' && req.method === 'GET') {
      const ids = String(url.searchParams.get('ids') || '').split(',').filter(x => ID_RE.test(x)).slice(0, 50);
      const out = {}; ids.forEach(id => { if (profiles[id]) out[id] = profiles[id]; });
      return json(res, 200, out);
    }

    const m = p.match(/^\/api\/doc\/([a-z]+)\/([A-Za-z0-9_-]{1,80})$/);
    if (m && (req.method === 'PUT' || req.method === 'DELETE')) {
      if (!COLLECTIONS.has(m[1])) return json(res, 404, { error: 'onbekende verzameling' });
      if (!authorized(req)) return json(res, 401, { error: 'Onjuist wachtwoord' });
      rememberProfile(req);
      const key = m[1] + '/' + m[2];
      if (req.method === 'DELETE') { delete docs[key]; persist(); broadcast('doc', { path: key, data: null }); return json(res, 200, { ok: true }); }
      let body;
      try { body = await readBody(req); } catch (e) { return json(res, 413, { error: 'Te groot of ongeldig' }); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'Ongeldig' });
      docs[key] = body; persist(); broadcast('doc', { path: key, data: body });
      return json(res, 200, { ok: true });
    }

    if (STATIC[p] && (req.method === 'GET' || req.method === 'HEAD')) {
      const [file, type] = STATIC[p];
      return fs.readFile(path.join(ROOT, file), (err, buf) => {
        if (err) return json(res, 404, { error: 'niet gevonden' });
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
        res.end(req.method === 'HEAD' ? undefined : buf);
      });
    }
    json(res, 404, { error: 'niet gevonden' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: 'serverfout' });
  }
});
server.keepAliveTimeout = 65000;
server.listen(PORT, () => console.log('Inrichtingsmodel draait op poort ' + PORT + (PASSWORD ? '' : ' (LET OP: geen HUIS_WACHTWOORD ingesteld, opslaan staat uit)')));
function shutdown() { clearTimeout(writeT); try { fs.writeFileSync(STORE, JSON.stringify({ docs, profiles, at: new Date().toISOString() })); } catch (e) {} process.exit(0); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
