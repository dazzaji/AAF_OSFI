// Small shared helpers: encoding, hashing, canonical JSON, time.
import crypto from 'node:crypto';

export const b64u = (buf) => Buffer.from(buf).toString('base64url');
export const unb64u = (s) => Buffer.from(s, 'base64url');
export const sha256 = (data) => crypto.createHash('sha256').update(data).digest();
export const sha256b64u = (data) => b64u(sha256(data));
export const randomId = (bytes = 16) => b64u(crypto.randomBytes(bytes));
export const nowSec = () => Math.floor(Date.now() / 1000);

// Canonical JSON: object keys sorted, no whitespace. Used wherever two parties
// must derive the same digest from the same object (actions, bindings).
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}
export const digestOf = (value) => sha256b64u(canonical(value));

// A short code a human can compare across two screens (pairing).
const WORDS = ['AMBER', 'BIRCH', 'CEDAR', 'DELTA', 'EMBER', 'FJORD', 'GROVE', 'HERON', 'INLET', 'JUNCO', 'KELP', 'LARCH', 'MAPLE', 'NORTH', 'OTTER', 'PINE', 'QUILL', 'RIVER', 'STONE', 'TIDE', 'UMBER', 'VALE', 'WREN', 'YARROW'];
export function userCode() {
  const pick = () => WORDS[crypto.randomInt(WORDS.length)];
  return `${pick()}-${pick()}-${String(crypto.randomInt(100)).padStart(2, '0')}`;
}

export class HttpError extends Error {
  constructor(status, code, detail = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}
export const fail = (status, code, detail) => { throw new HttpError(status, code, detail); };
