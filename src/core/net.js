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

export async function safeFetch(url, { allow = null, mode = 'local', staging = false, method = 'GET', headers, body, timeout = 4000, maxBytes = 256 * 1024 } = {}) {
  let u; try { u = new URL(url); } catch { throw new HttpError(400, 'invalid_url'); }
  if (allow && !allow.includes(u.origin)) throw new HttpError(403, 'destination_not_allowed', { origin: u.origin });
  if (!schemeAllowed(url, { mode, staging })) throw new HttpError(400, 'destination_must_use_https', { origin: u.origin });
  const res = await fetch(u, { method, headers, body, redirect: 'error', signal: AbortSignal.timeout(timeout) });
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > maxBytes) throw new Error('response too large');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error('response too large');
  const text = buf.toString('utf8');
  return { ok: res.ok, status: res.status, text, json: () => JSON.parse(text) };
}

export const originList = (raw) => String(raw ?? '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean).map((s) => new URL(s).origin);
export { isLocalhost };
