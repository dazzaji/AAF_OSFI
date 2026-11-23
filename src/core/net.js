// Outbound fetches for metadata, keys, status lists and reports.
// One place for the rules: only origins the operator configured, no redirects,
// a timeout, a size limit, and HTTPS unless this is a local or staging build
// talking to localhost.
import { HttpError } from './util.js';

const isLocalhost = (u) => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(u).hostname);

// local: any scheme. staging: plain HTTP only to localhost. hosted: HTTPS only.
export function schemeAllowed(url, { mode = 'local', staging = false } = {}) {
  const u = new URL(url);
  if (u.protocol === 'https:') return true;
  if (u.protocol !== 'http:') return false;
  return mode === 'local' || (staging && isLocalhost(url));
}

// Optional private routes between services on the same host, written as
// "https://public-a=http://internal-a:port,https://public-b=http://internal-b:port".
// Only the connection is redirected. Which origins are allowed, and every
// issuer and audience check, still use the public address; signatures do the
// authenticating, so the private hop needs no TLS of its own.
export function parseRoutes(routes) {
  const out = [];
  for (const pair of String(routes ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const i = pair.indexOf('=');
    if (i < 0) throw new Error('AAF_INTERNAL_ROUTES entries must look like https://public=http://internal:port');
    const from = new URL(pair.slice(0, i).trim()); const to = new URL(pair.slice(i + 1).trim());
    if (!['http:', 'https:'].includes(to.protocol) || to.pathname !== '/' || to.search || from.pathname !== '/' || from.search) throw new Error('AAF_INTERNAL_ROUTES entries must be plain origins');
    out.push({ from: from.origin, to: to.origin });
  }
  return out;
}
// The path and query are assigned to a URL already fixed at the private
// target, never resolved against it, so no path (for example one starting
// with "//") can change the host. The result is checked all the same.
function routed(u, routes) {
  const hit = parseRoutes(routes).find((x) => x.from === u.origin);
  if (!hit) return u;
  const t = new URL(hit.to); t.pathname = u.pathname; t.search = u.search;
  if (t.origin !== hit.to) throw new HttpError(400, 'route_escaped');
  return t;
}

export async function safeFetch(url, { allow = null, mode = 'local', staging = false, routes = '', method = 'GET', headers, body, timeout = 4000, maxBytes = 256 * 1024 } = {}) {
  let u; try { u = new URL(url); } catch { throw new HttpError(400, 'invalid_url'); }
  if (allow && !allow.includes(u.origin)) throw new HttpError(403, 'destination_not_allowed', { origin: u.origin });
  if (!schemeAllowed(url, { mode, staging })) throw new HttpError(400, 'destination_must_use_https', { origin: u.origin });
  const res = await fetch(routed(u, routes), { method, headers, body, redirect: 'error', signal: AbortSignal.timeout(timeout) });
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > maxBytes) throw new Error('response too large');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error('response too large');
  const text = buf.toString('utf8');
  return { ok: res.ok, status: res.status, text, json: () => JSON.parse(text) };
}

export const originList = (raw) => String(raw ?? '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean).map((s) => new URL(s).origin);
export { isLocalhost };
