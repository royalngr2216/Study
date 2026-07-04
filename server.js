/**
 * StudyQuest backend — plain Node.js, ZERO external dependencies.
 * Handles: register / login / logout, session auth, and cross-device
 * data sync (one JSON "profile" per user). Also serves the PWA files.
 *
 * Why no express/bcrypt/etc: keeps this deployable anywhere (Render,
 * Railway, a Pi, your laptop) with just `node server.js` — no npm
 * install, no native build steps, nothing that can fail on a free tier.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- tiny JSON "database" ----------
function ensureDB() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ users: {}, sessions: {}, records: {} }, null, 2));
  }
}
ensureDB();

let writeQueue = Promise.resolve();
function readDB() {
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}
function writeDB(db) {
  // serialize writes so two requests can't corrupt the file
  writeQueue = writeQueue.then(() => {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_FILE);
  });
  return writeQueue;
}

// ---------- password hashing (built-in crypto, no bcrypt needed) ----------
function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 120000, 64, 'sha512').toString('hex');
}
function makeSalt() {
  return crypto.randomBytes(16).toString('hex');
}
function makeToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ---------- default profile for a brand-new user ----------
function defaultRecord() {
  return {
    tasks: [],
    stats: { xp: 0, tasksCompleted: 0, streak: 0, lastActiveDate: null, achievements: [], journalCount: 0 },
    questLog: {},       // { "2026-07-04": { math: "done", gs: "skipped", eng1: "done", eng2: null } }
    journal: {},        // { "2026-07-04": { content, images } }
    updatedAt: 0
  };
}

// ---------- helpers ----------
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 5 * 1024 * 1024) { reject(new Error('Body too large')); req.destroy(); return; }
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}
function getToken(req) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer (.+)$/);
  return m ? m[1] : null;
}
function requireAuth(req, db) {
  const token = getToken(req);
  if (!token || !db.sessions[token]) return null;
  return db.sessions[token]; // { username, createdAt }
}
const USERNAME_RE = /^[a-zA-Z0-9_]{3,24}$/;

// ---------- API routes ----------
async function handleApi(req, res, pathname) {
  const db = readDB();

  if (pathname === '/api/register' && req.method === 'POST') {
    const body = await readBody(req).catch(() => null);
    if (!body) return sendJSON(res, 400, { error: 'Invalid request body' });
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (!USERNAME_RE.test(username)) {
      return sendJSON(res, 400, { error: 'Username must be 3-24 characters: letters, numbers, underscore.' });
    }
    if (password.length < 6) {
      return sendJSON(res, 400, { error: 'Password must be at least 6 characters.' });
    }
    const key = username.toLowerCase();
    if (db.users[key]) {
      return sendJSON(res, 409, { error: 'That username is already taken.' });
    }
    const salt = makeSalt();
    db.users[key] = { username, salt, hash: hashPassword(password, salt), createdAt: Date.now() };
    db.records[key] = defaultRecord();
    const token = makeToken();
    db.sessions[token] = { username: key, createdAt: Date.now() };
    await writeDB(db);
    return sendJSON(res, 200, { token, username, record: db.records[key] });
  }

  if (pathname === '/api/login' && req.method === 'POST') {
    const body = await readBody(req).catch(() => null);
    if (!body) return sendJSON(res, 400, { error: 'Invalid request body' });
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const key = username.toLowerCase();
    const user = db.users[key];
    if (!user || hashPassword(password, user.salt) !== user.hash) {
      return sendJSON(res, 401, { error: 'Incorrect username or password.' });
    }
    const token = makeToken();
    db.sessions[token] = { username: key, createdAt: Date.now() };
    await writeDB(db);
    return sendJSON(res, 200, { token, username: user.username, record: db.records[key] || defaultRecord() });
  }

  if (pathname === '/api/logout' && req.method === 'POST') {
    const token = getToken(req);
    if (token && db.sessions[token]) {
      delete db.sessions[token];
      await writeDB(db);
    }
    return sendJSON(res, 200, { ok: true });
  }

  if (pathname === '/api/state' && req.method === 'GET') {
    const session = requireAuth(req, db);
    if (!session) return sendJSON(res, 401, { error: 'Not logged in.' });
    return sendJSON(res, 200, { record: db.records[session.username] || defaultRecord() });
  }

  if (pathname === '/api/state' && req.method === 'POST') {
    const session = requireAuth(req, db);
    if (!session) return sendJSON(res, 401, { error: 'Not logged in.' });
    const body = await readBody(req).catch(() => null);
    if (!body || typeof body !== 'object') return sendJSON(res, 400, { error: 'Invalid request body' });

    const existing = db.records[session.username] || defaultRecord();
    // last-write-wins by client timestamp, so an offline device that syncs
    // late doesn't overwrite newer data pushed by the other device
    const incomingUpdatedAt = Number(body.updatedAt || 0);
    if (incomingUpdatedAt >= (existing.updatedAt || 0)) {
      db.records[session.username] = {
        tasks: Array.isArray(body.tasks) ? body.tasks : existing.tasks,
        stats: body.stats || existing.stats,
        questLog: body.questLog || existing.questLog,
        journal: body.journal || existing.journal,
        updatedAt: incomingUpdatedAt || Date.now()
      };
      await writeDB(db);
      return sendJSON(res, 200, { ok: true, record: db.records[session.username] });
    }
    // our copy is newer than what the client is trying to push — tell it so
    return sendJSON(res, 200, { ok: true, stale: true, record: existing });
  }

  return sendJSON(res, 404, { error: 'Not found' });
}

// ---------- static file serving ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};
function serveStatic(req, res, pathname) {
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(PUBLIC_DIR, filePath);
  if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(full, (err, data) => {
    if (err) {
      // SPA-ish fallback: unknown paths just get index.html
      return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, data2) => {
        if (e2) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(data2);
      });
    }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------- server ----------
const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(req.url.split('?')[0]);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    });
    return res.end();
  }

  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname).catch((err) => {
      console.error(err);
      sendJSON(res, 500, { error: 'Server error' });
    });
    return;
  }

  serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  console.log(`StudyQuest server running on http://localhost:${PORT}`);
});
