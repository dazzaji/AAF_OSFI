// A very small HTTP layer: routing, JSON bodies, cookies, static files.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from './util.js';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml' };

export function createApp({ name, rateLimit = 0, postLimit = 0, trustProxy = false }) {
  const routes = [];
  // Plain per-address limits (requests a minute): one for everything, and a
  // tighter one for POSTs, which are the requests that can cost work or write.
  // Pages poll with GETs, so those get the roomier limit. Behind the tunnel the
  // client address is the one Cloudflare reports; a client-supplied
  // X-Forwarded-For is never used.
  const hits = new Map(); const posts = new Map();
  if (rateLimit || postLimit) setInterval(() => { hits.clear(); posts.clear(); }, 60_000).unref();
  const bump = (map, who) => { const n = (map.get(who) ?? 0) + 1; map.set(who, n); return n; };
  const limited = (req) => {
    if (!rateLimit && !postLimit) return false;
    const who = (trustProxy && req.headers['cf-connecting-ip']) || req.socket.remoteAddress || 'unknown';
    if (rateLimit && bump(hits, who) > rateLimit) return true;
    return !!postLimit && req.method === 'POST' && bump(posts, who) > postLimit;
  };
  const add = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:[a-zA-Z_]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler });
  };
  const app = {
    get: (p, h) => add('GET', p, h),
    post: (p, h) => add('POST', p, h),
    async handle(req, res) {
      let ctx = { path: String(req.url) };
      try {
        const url = new URL(req.url, 'http://x');
        ctx = { req, res, url, path: url.pathname, query: url.searchParams, params: {}, cookies: parseCookies(req.headers.cookie), rawBody: '', body: null, headers: req.headers };
        if (req.url !== '/healthz' && limited(req)) return send(res, 429, { error: 'rate_limited' }, { 'retry-after': '60' });
        if (req.method === 'OPTIONS') return send(res, 204, null, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST' });
        if (req.method === 'POST') {
          ctx.rawBody = await readBody(req);
          if (ctx.rawBody) { try { ctx.body = JSON.parse(ctx.rawBody); } catch { throw new HttpError(400, 'invalid_json'); } }
          ctx.body ??= {};
        }
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = r.re.exec(ctx.path);
          if (!m) continue;
          r.keys.forEach((k, i) => { ctx.params[k] = safeDecode(m[i + 1]); });
          const out = await r.handler(ctx);
          if (!res.writableEnded) send(res, 200, out ?? { ok: true });
          return;
        }
        send(res, 404, { error: 'not_found' });
      } catch (e) {
        if (e instanceof HttpError) return send(res, e.status, { error: e.code, ...e.detail });
        console.error(`[${name}] ${req.method} ${ctx.path}:`, e);
        send(res, 500, { error: 'internal_error' });
      }
    },
    listen(port, host = '127.0.0.1') {
      const server = http.createServer((req, res) => { app.handle(req, res).catch((e) => { console.error(`[${name}] unhandled`, e); try { send(res, 500, { error: 'internal_error' }); } catch { /* socket gone */ } }); });
      return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
    },
  };
  return app;
}

export function send(res, status, body, headers = {}) {
  if (res.writableEnded) return;
  if (body === null || body === undefined) { res.writeHead(status, headers); return res.end(); }
  const isText = typeof body === 'string' || Buffer.isBuffer(body);
  res.writeHead(status, { 'content-type': isText ? 'text/plain; charset=utf-8' : 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(isText ? body : JSON.stringify(body));
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new HttpError(413, 'body_too_large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Malformed percent-escapes must never take the service down.
function safeDecode(s) { try { return decodeURIComponent(s); } catch { return ''; } }
function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = safeDecode(part.slice(i + 1).trim()); }
  return out;
}

export function setCookie(res, name, value, { maxAge = 86400, secure = false } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (secure) parts.push('Secure');
  res.setHeader('set-cookie', parts.join('; '));
}

export function serveFile(res, file, headers = {}) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, { error: 'not_found' });
  send(res, 200, fs.readFileSync(file), { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', ...headers });
}

// Browser-originated mutations must come from our own page.
export function requireSameOrigin(ctx, origin) {
  const o = ctx.headers.origin;
  if (o && o !== origin) throw new HttpError(403, 'cross_origin_request');
}
