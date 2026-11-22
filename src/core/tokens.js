// Signed tokens. Everything on the wire is an EdDSA (Ed25519) JWS with an
// explicit `typ`, so a token made for one purpose cannot be replayed as another.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SignJWT, jwtVerify, generateKeyPair, exportJWK, importJWK, calculateJwkThumbprint, decodeJwt, decodeProtectedHeader } from 'jose';

export const TYP = {
  id: 'aaf-id+jwt',               // directory -> agent: the ID, bound to a presentation key
  claim: 'aaf-claim+jwt',         // directory (or the agent itself): one claim about the same ID
  proof: 'aaf-proof+jwt',         // agent -> counterparty: holder proof over one HTTP request
  agentReq: 'aaf-agent-req+jwt',  // agent -> directory: request authentication
  keyPop: 'aaf-key-pop+jwt',      // proof of possession of a freshly made presentation key
  ticket: 'aaf-ticket+jwt',       // counterparty -> principal (via agent): "approve exactly this"
  receipt: 'aaf-receipt+jwt',     // counterparty: signed record of one decision
  status: 'aaf-statuslist+jwt',   // directory: signed status list snapshot
};

export async function newKeyPair() {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const privateJwk = await exportJWK(privateKey);
  const kid = await calculateJwkThumbprint(publicJwk);
  return { publicJwk: { ...publicJwk, kid }, privateJwk: { ...privateJwk, kid }, kid };
}

// Load a service signing key from disk, creating it on first run.
export async function loadOrCreateKey(file) {
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const key = await newKeyPair();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(key, null, 2), { mode: 0o600 });
  return key;
}

export const thumbprint = (jwk) => calculateJwkThumbprint({ kty: jwk.kty, crv: jwk.crv, x: jwk.x });

export async function sign(typ, payload, privateJwk) {
  const key = await importJWK(privateJwk, 'EdDSA');
  return new SignJWT(payload).setProtectedHeader({ alg: 'EdDSA', typ, kid: privateJwk.kid }).sign(key);
}

// Verify signature and typ. Time checks (exp, iat) are done by the caller so
// each caller can apply its own clock rules and report its own reasons.
export async function verify(token, publicJwk, typ) {
  const key = await importJWK({ kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x }, 'EdDSA');
  const { payload, protectedHeader } = await jwtVerify(token, key, { algorithms: ['EdDSA'], typ, currentDate: new Date(0) });
  return { payload, header: protectedHeader };
}

// Synchronous signing, for use inside a database transaction so that a record
// and its signed receipt are written together or not at all.
export function signSync(typ, payload, privateJwk) {
  const key = crypto.createPrivateKey({ key: { kty: privateJwk.kty, crv: privateJwk.crv, x: privateJwk.x, d: privateJwk.d }, format: 'jwk' });
  const head = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ, kid: privateJwk.kid })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${head}.${body}.${crypto.sign(null, Buffer.from(`${head}.${body}`), key).toString('base64url')}`;
}

export const peek = (token) => ({ payload: decodeJwt(token), header: decodeProtectedHeader(token) });
