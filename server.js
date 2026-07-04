/**
 * StudyQuest backend.
 * Handles: register / login / logout, session auth, and cross-device
 * data sync (one JSON "profile" per user). Also serves the PWA files.
 *
 * Storage:
 *   - If MONGODB_URI is set, everything is stored in MongoDB, so data
 *     survives restarts, redeploys, and free-tier disk wipes.
 *   - If MONGODB_URI is NOT set, falls back to the original local
 *     data/db.json file — handy for quick local testing without
 *     needing a Mongo connection, but NOT persistent on most hosts.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MONGODB_URI = process.env.MONGODB_URI || '';

// ============================================================
// STORAGE LAYER — one interface, two implementations.
// store.getUser(key) -> { username, salt, hash, createdAt } | null
// store.createUser(key, userDoc, recordDoc) -> void
// store.getRecord(key) -> record | null
// store.saveRecord(key, record) -> void
// store.getSession(token) -> { username, createdAt } | null
// store.createSession(token, sessionDoc) -> void
// store.deleteSession(token) -> void
// ============================================================

function defaultRecord() {
  return {
    tasks: [],
    stats: { xp: 0, tasksCompleted: 0, streak: 0, lastActiveDate: null, achievements: [], journalCount: 0 },
    questLog: {},       // { "2026-07-04": { math: "done", gs: "skipped", eng1: "done", eng2: null } }
    journal: {},        // { "2026-07-04": { content, images } }
    updatedAt: 0
  };
}

let store;

function makeFileStore() {
  const DATA_DIR = path.join(__dirname, 'data');
  const DB_FILE = path.join(DATA_DIR, 'db.json');

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
    writeQueue = writeQueue.then(() => {
      const tmp = DB_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
      fs.renameSync(tmp, DB_FILE);
    });
    return writeQueue;
  }

  return {
    async init() {},
    async getUser(key) {
      const db = readDB();
      return db.users[key] || null;
    },
    async createUser(key, userDoc, recordDoc) {
      const db = readDB();
      db.users[key] = userDoc;
      db.records[key] = recordDoc;
      await writeDB(db);
    },
    async getRecord(key) {
      const db = readDB();
      return db.records[key] || null;
    },
    async saveRecord(key, record) {
      const db = readDB();
      db.records[key] = record;
      await writeDB(db);
    },
    async getSession(token) {
      const db = readDB();
      return db.sessions[token] || null;
    },
    async createSession(token, sessionDoc) {
      const db = readDB();
      db.sessions[token] = sessionDoc;
      await writeDB(db);
    },
    async deleteSession(token) {
      const db = readDB();
      delete db.sessions[token];
      await writeDB(db);
    }
  };
}

function makeMongoStore(uri) {
  const { MongoClient } = require('mongodb');
  const client = new MongoClient(uri);
  let users, sessions, records;

  return {
    async init() {
      await client.connect();
      const db = client.db(); // uses the database name from the connection string
      users = db.collection('users');
      sessions = db.collection('sessions');
      records = db.collection('records');
      await users.createIndex({ key: 1 }, { unique: true });
      await records.createIndex({ key: 1 }, { unique: true });
      await sessions.createIndex({ token: 1 }, { unique: true });
      // sessions auto-expire after 90 days of inactivity
      await sessions.createIndex({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });
      console.log('Connected to MongoDB.');
    },
    async getUser(key) {
      const doc = await users.findOne({ key });
      return doc ? { username: doc.username, salt: doc.salt, hash: doc.hash, createdAt: doc.createdAt } : null;
    },
    async createUser(key, userDoc, recordDoc) {
      await users.insertOne({ key, ...userDoc });
      await records.insertOne({ key, ...recordDoc });
    },
    async getRecord(key) {
      const doc = await records.findOne({ key });
      if (!doc) return null;
      const { _id, key: _k, ...rest } = doc;
      return rest;
    },
    async saveRecord(key, record) {
      await records.updateOne({ key }, { $set: record }, { upsert: true });
    },
    async getSession(token) {
      const doc = await sessions.findOne({ token });
      return doc ? { username: doc.username, createdAt: doc.createdAt } : null;
    },
    async createSession(token, sessionDoc) {
      await sessions.insertOne({ token, ...sessionDoc });
    },
    async deleteSession(token) {
      await sessions.deleteOne({ token });
    }
  };
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
async function requireAuth(req) {
  const token = getToken(req);
  if (!token) return null;
  const session = await store.getSession(token);
  return session; // { username, createdAt } | null
}
const USERNAME_RE = /^[a-zA-Z0-9_]{3,24}$/;

// ---------- API routes ----------
async function handleApi(req, res, pathname) {
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
    if (await store.getUser(key)) {
      return sendJSON(res, 409, { error: 'That username is already taken.' });
    }
    const salt = makeSalt();
    const userDoc = { username, salt, hash: hashPassword(password, salt), createdAt: Date.now() };
    const recordDoc = defaultRecord();
    await store.createUser(key, userDoc, recordDoc);
    const token = makeToken();
    await store.createSession(token, { username: key, createdAt: Date.now() });
    return sendJSON(res, 200, { token, username, record: recordDoc });
  }

  if (pathname === '/api/login' && req.method === 'POST') {
    const body = await readBody(req).catch(() => null);
    if (!body) return sendJSON(res, 400, { error: 'Invalid request body' });
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const key = username.toLowerCase();
    const user = await store.getUser(key);
    if (!user || hashPassword(password, user.salt) !== user.hash) {
      return sendJSON(res, 401, { error: 'Incorrect username or password.' });
    }
    const token = makeToken();
    await store.createSession(token, { username: key, createdAt: Date.now() });
    const record = (await store.getRecord(key)) || defaultRecord();
    return sendJSON(res, 200, { token, username: user.username, record });
  }

  if (pathname === '/api/logout' && req.method === 'POST') {
    const token = getToken(req);
    if (token) await store.deleteSession(token);
    return sendJSON(res, 200, { ok: true });
  }

  if (pathname === '/api/state' && req.method === 'GET') {
    const session = await requireAuth(req);
    if (!session) return sendJSON(res, 401, { error: 'Not logged in.' });
    const record = (await store.getRecord(session.username)) || defaultRecord();
    return sendJSON(res, 200, { record });
  }

  if (pathname === '/api/state' && req.method === 'POST') {
    const session = await requireAuth(req);
    if (!session) return sendJSON(res, 401, { error: 'Not logged in.' });
    const body = await readBody(req).catch(() => null);
    if (!body || typeof body !== 'object') return sendJSON(res, 400, { error: 'Invalid request body' });

    const existing = (await store.getRecord(session.username)) || defaultRecord();
    // last-write-wins by client timestamp, so an offline device that syncs
    // late doesn't overwrite newer data pushed by the other device
    const incomingUpdatedAt = Number(body.updatedAt || 0);
    if (incomingUpdatedAt >= (existing.updatedAt || 0)) {
      const newRecord = {
        tasks: Array.isArray(body.tasks) ? body.tasks : existing.tasks,
        stats: body.stats || existing.stats,
        questLog: body.questLog || existing.questLog,
        journal: body.journal || existing.journal,
        updatedAt: incomingUpdatedAt || Date.now()
      };
      await store.saveRecord(session.username, newRecord);
      return sendJSON(res, 200, { ok: true, record: newRecord });
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

// ---------- boot ----------
(async function boot() {
  store = MONGODB_URI ? makeMongoStore(MONGODB_URI) : makeFileStore();
  try {
    await store.init();
  } catch (err) {
    console.error('Failed to connect to storage:', err.message);
    process.exit(1);
  }
  if (!MONGODB_URI) {
    console.warn('⚠️  MONGODB_URI not set — using local data/db.json. This will NOT survive a redeploy on most hosts.');
  }
  server.listen(PORT, () => {
    console.log(`StudyQuest server running on http://localhost:${PORT}`);
  });
})();
