// Production server (Railway): serves the built app from dist/, runs the
// circuit agent at POST /api/agent, and puts everything behind a password.
//
// Built with `npm run build` into dist-server/ and started with `npm start`.
// Environment:
//   APP_PASSWORD       required: the password for the site (HTTP Basic Auth; any username)
//   ANTHROPIC_API_KEY  required for the assistant
//   PORT               set by Railway (defaults to 3000)
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import zlib from 'node:zlib';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runAgent, describeError } from './agent.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
const PORT = Number(process.env.PORT) || 3000;
const PASSWORD = process.env.APP_PASSWORD;
const MAX_BODY = 2 * 1024 * 1024;   // agent requests carry the circuit, not photos

if (!PASSWORD) {
  console.error('APP_PASSWORD is not set. Refusing to start without a password.');
  process.exit(1);
}

// ---------- password (HTTP Basic Auth, any username) ----------

const digest = s => crypto.createHash('sha256').update(s).digest();
const PASSWORD_DIGEST = digest(PASSWORD);

// Slow down guessing: after FAIL_LIMIT wrong passwords from one address in
// FAIL_WINDOW, that address gets 429s until the window passes. The address
// comes from X-Forwarded-For, which a client can fake to look like many
// addresses, so there's also a cap on wrong passwords from everyone together.
const FAIL_LIMIT = 10, GLOBAL_FAIL_LIMIT = 200, FAIL_WINDOW = 15 * 60 * 1000;
const failures = new Map();   // ip → { count, since }
let globalFails = { count: 0, since: Date.now() };

const clientIp = req => (req.headers['x-forwarded-for']?.split(',')[0] ?? req.socket.remoteAddress ?? '').trim();

function checkAuth(req, res) {
  const ip = clientIp(req), now = Date.now();
  const f = failures.get(ip);
  if (f && now - f.since > FAIL_WINDOW) failures.delete(ip);
  if (now - globalFails.since > FAIL_WINDOW) globalFails = { count: 0, since: now };
  if (failures.get(ip)?.count >= FAIL_LIMIT || globalFails.count >= GLOBAL_FAIL_LIMIT) {
    res.writeHead(429, { 'Retry-After': String(Math.ceil(FAIL_WINDOW / 1000)) });
    res.end('Too many wrong passwords. Try again later.');
    return false;
  }

  const m = /^Basic (.+)$/.exec(req.headers.authorization ?? '');
  if (m) {
    const decoded = Buffer.from(m[1], 'base64').toString('utf8');
    const given = decoded.slice(decoded.indexOf(':') + 1);
    // Hashing first makes the comparison constant-time whatever the lengths.
    if (crypto.timingSafeEqual(digest(given), PASSWORD_DIGEST)) {
      failures.delete(ip);
      return true;
    }
    const cur = failures.get(ip) ?? { count: 0, since: now };
    failures.set(ip, { ...cur, count: cur.count + 1 });
    globalFails.count++;
  }
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Circuit Max", charset="UTF-8"', 'Content-Type': 'text/plain' });
  res.end('Password required.');
  return false;
}

setInterval(() => {   // forget old failures
  const now = Date.now();
  for (const [ip, f] of failures) if (now - f.since > FAIL_WINDOW) failures.delete(ip);
}, FAIL_WINDOW).unref();

// ---------- static files ----------

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.webp': 'image/webp', '.wasm': 'application/wasm',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt', '.map', '.wasm']);

// File contents (and their gzip) cached in memory: the simulator bundle is
// ~20 MB of JavaScript, and compressing it on every request would be slow.
const cache = new Map();   // file → { body, gz, mtime }
async function load(file) {
  const s = await stat(file);
  if (!s.isFile()) return null;
  const hit = cache.get(file);
  if (hit && hit.mtime === s.mtimeMs) return hit;
  const body = await readFile(file);
  const ext = path.extname(file);
  const gz = COMPRESSIBLE.has(ext) && body.length > 1024 ? zlib.gzipSync(body, { level: 6 }) : null;
  const entry = { body, gz, mtime: s.mtimeMs, type: TYPES[ext] ?? 'application/octet-stream' };
  cache.set(file, entry);
  return entry;
}

async function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { rel = '/'; }
  let file = path.resolve(ROOT, '.' + rel);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end(); }

  let entry = await load(file).catch(() => null);
  // Unknown paths without a file extension get the app (it has no client-side routes, but this keeps reloads safe).
  if (!entry && !path.extname(rel)) entry = await load(file = path.join(ROOT, 'index.html')).catch(() => null);
  if (!entry) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }

  const immutable = rel.startsWith('/assets/');   // Vite puts a content hash in these names
  const useGz = entry.gz && /\bgzip\b/.test(req.headers['accept-encoding'] ?? '');
  const body = useGz ? entry.gz : entry.body;
  res.writeHead(200, {
    'Content-Type': entry.type,
    'Content-Length': body.length,
    'Cache-Control': immutable ? 'private, max-age=31536000, immutable' : 'no-cache',
    ...(useGz && { 'Content-Encoding': 'gzip' }),
    ...(entry.gz && { Vary: 'Accept-Encoding' }),
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

// ---------- assistant ----------

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Request too large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function agentApi(req, res) {
  if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
  let input;
  try {
    input = JSON.parse(await readBody(req));
  } catch (err) {
    res.writeHead(err.status ?? 400, { 'Content-Type': 'text/plain' });
    return res.end(err.status ? err.message : 'Bad request');
  }
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  const emit = event => { if (!res.writableEnded) res.write(JSON.stringify(event) + '\n'); };
  const { messages, userText, components, boards, capVoltages } = input;
  try {
    await runAgent({ messages, userText, components, boards, capVoltages, apiKey: process.env.ANTHROPIC_API_KEY }, emit);
  } catch (err) {
    console.error(err.stack ?? String(err));
    emit({ type: 'error', message: describeError(err) });
  }
  res.end();
}

// ---------- server ----------

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const { pathname } = new URL(req.url, 'http://localhost');

  if (pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (!checkAuth(req, res)) return;

  try {
    if (pathname === '/api/agent') return await agentApi(req, res);
    if (pathname.startsWith('/api/')) { res.writeHead(404); return res.end(); }   // e.g. training export: dev only
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    await serveStatic(req, res, pathname);
  } catch (err) {
    console.error(err.stack ?? String(err));
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

server.listen(PORT, () => console.log(`Circuit Max listening on port ${PORT}`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
