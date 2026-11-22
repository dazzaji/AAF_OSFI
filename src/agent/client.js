// The agent's side of the protocol. This process holds the AGENT key only.
// It never sees the principal's passkey, session or any directory operator
// credential, and it only talks to the directory and counterparties named in
// its own config file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { TYP, newKeyPair, sign, peek } from '../core/tokens.js';
import { b64u, sha256b64u, randomId, nowSec } from '../core/util.js';

export class AgentError extends Error { constructor(code, detail = {}) { super(code); this.code = code; this.detail = detail; } }

export function createAgent({ home = process.env.AAF_AGENT_HOME ?? path.join(os.homedir(), '.aaf-agent'), openBrowser = true } = {}) {
  const file = (name) => path.join(home, name);
  const read = (name, fallback = null) => (fs.existsSync(file(name)) ? JSON.parse(fs.readFileSync(file(name), 'utf8')) : fallback);
  // Written to a temporary file and renamed, so two processes never leave a
  // half-written file. Each pending action and each operation has its own file.
  const write = (name, value) => { fs.mkdirSync(home, { recursive: true, mode: 0o700 }); const tmp = file(`.${name}.${process.pid}.${Date.now()}.tmp`); fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 }); fs.renameSync(tmp, file(name)); };
  const remove = (name) => fs.rmSync(file(name), { force: true });
  const list = (prefix) => (fs.existsSync(home) ? fs.readdirSync(home).filter((f) => f.startsWith(prefix) && f.endsWith('.json')).map((f) => read(f)).filter(Boolean) : []);
  const config = () => read('config.json') ?? (() => { throw new AgentError('not_initialised', { hint: 'run: aaf-agent init <directory-url> --shop <shop-url>' }); })();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Only origins the user configured. A prompt-injected instruction to "call
  // this other URL" fails here.
  function allowed(url) {
    const cfg = config(); const o = new URL(url).origin;
    if (![cfg.directory, ...cfg.counterparties].includes(o)) throw new AgentError('origin_not_configured', { origin: o, configured: [cfg.directory, ...cfg.counterparties] });
    return o;
  }
  function open(url) {
    if (!openBrowser || process.env.AAF_AGENT_NO_BROWSER) return false;
    if (new URL(url).origin !== config().directory) return false; // only ever the directory
    try { spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true }).unref(); return true; } catch { return false; }
  }

  async function dir(method, p, body, { key = read('key.json'), iss = config().agent_id } = {}) {
    const cfg = config();
    const raw = body === undefined ? '' : JSON.stringify(body);
    const auth = await sign(TYP.agentReq, { iss: iss ?? 'unregistered', aud: cfg.directory, htm: method, htu: p.split('?')[0], body_hash: sha256b64u(raw), iat: nowSec(), jti: randomId() }, key.privateJwk);
    let res;
    try { res = await fetch(cfg.directory + p, { method, redirect: 'error', headers: { 'aaf-agent-auth': auth, ...(raw ? { 'content-type': 'application/json' } : {}) }, body: raw || undefined, signal: AbortSignal.timeout(10000) }); } catch { throw new AgentError('directory_unreachable', { directory: cfg.directory }); }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new AgentError(json.error ?? 'directory_error', { ...json, http_status: res.status });
    return json;
  }

  return {
    home,
    init({ directory, shops = [] }) {
      const cfg = read('config.json', {});
      write('config.json', { ...cfg, directory: new URL(directory).origin, counterparties: [...new Set([...(cfg.counterparties ?? []), ...shops.map((s) => new URL(s).origin)])] });
      return config();
    },

    // Ask the directory to register this agent. The principal approves in the
    // browser with a passkey; nothing this process can do completes it.
    async register({ name, harness, wait = 0 } = {}) {
      const cfg = config();
      if (cfg.agent_id) return { status: 'already_registered', agent_id: cfg.agent_id };
      let pending = read('pairing.json');
      if (!pending || pending.expires_at <= nowSec()) {
        const key = read('key.json') ?? (await newKeyPair());
        write('key.json', key);
        const out = await dir('POST', '/api/pairings', { name: name ?? `Agent on ${os.hostname()}`, harness, public_jwk: key.publicJwk }, { key, iss: 'unregistered' });
        pending = { ...out, expires_at: nowSec() + out.expires_in };
        write('pairing.json', pending);
        open(pending.verify_url);
      }
      const check = async () => {
        const s = await dir('GET', `/api/pairings/${pending.pairing_id}`, undefined, { iss: 'unregistered' });
        if (s.status === 'approved') { write('config.json', { ...config(), agent_id: s.agent_id }); remove('pairing.json'); return { status: 'registered', agent_id: s.agent_id }; }
        if (s.status === 'denied' || s.status === 'expired') { remove('pairing.json'); return { status: 'registration_' + s.status }; }
        return null;
      };
      const deadline = Date.now() + wait * 1000;
      for (;;) { const r = await check(); if (r) return r; if (Date.now() >= deadline) break; await sleep(1500); }
      return { status: 'waiting_for_principal', user_code: pending.user_code, key_fingerprint: pending.fingerprint, approve_at: pending.verify_url, next: 'Ask the user to open the link, check the code and fingerprint match, and approve with their passkey. Then run: aaf-agent register' };
    },

    async status() {
      const cfg = config();
      if (!cfg.agent_id) return { registered: false, directory: cfg.directory, counterparties: cfg.counterparties };
      const me = await dir('GET', '/api/agent/me');
      return { registered: true, directory: cfg.directory, counterparties: cfg.counterparties, ...me, pending_actions: list('pending-').map((x) => ({ approval_id: x.approval_id, review_at: x.review_url })) };
    },

    // Obtain an ID (and any claims) for one counterparty, bound to a fresh key.
    async issue({ aud, want = [], approvalId, mode = 'ephemeral' }) {
      const cfg = config();
      if (!cfg.agent_id) throw new AgentError('not_registered', { hint: 'run: aaf-agent register' });
      const pres = await newKeyPair();
      const keyPop = await sign(TYP.keyPop, { aud: cfg.directory, agent: cfg.agent_id, iat: nowSec() }, pres.privateJwk);
      const out = await dir('POST', '/api/issue', { aud, mode, want, approval_id: approvalId, presentation_jwk: pres.publicJwk, key_pop: keyPop });
      const creds = { aud, id: out.id, claims: out.claims, key: pres.privateJwk, sub: out.sub, expires_at: out.expires_at, withheld: out.withheld };
      write('last-credentials.json', creds);
      return creds;
    },

    // One signed request to a counterparty.
    async present({ method, url, body, creds, extraClaims = [], idempotencyKey }) {
      const o = allowed(url); const u = new URL(url);
      const ch = await (await fetch(o + '/api/challenge', { redirect: 'error', signal: AbortSignal.timeout(10000) })).json();
      const raw = body === undefined ? '' : JSON.stringify(body);
      const claims = [...creds.claims, ...extraClaims];
      const proof = await sign(TYP.proof, { aud: o, htm: method, htu: u.pathname, body_hash: sha256b64u(raw), creds_hash: sha256b64u([creds.id, ...claims].join('.')), nonce: ch.nonce, op: idempotencyKey ?? undefined, iat: nowSec(), jti: randomId() }, creds.key);
      const res = await fetch(url, { method, redirect: 'error', headers: { 'aaf-presentation': b64u(JSON.stringify({ id: creds.id, claims, proof })), ...(raw ? { 'content-type': 'application/json' } : {}) }, body: raw || undefined, signal: AbortSignal.timeout(15000) });
      return { http_status: res.status, ...(await res.json().catch(() => ({}))) };
    },

    // A claim signed only by the agent itself. Counterparties can tell.
    async selfClaim(creds, type, value) {
      const p = peek(creds.id).payload;
      return sign(TYP.claim, { iss: 'self', sub: p.sub, aud: p.aud, iat: nowSec(), exp: p.exp, attested_by: 'self', claim: { type, value } }, creds.key);
    },

    // Do one thing at a counterparty, following its requests for more.
    async act({ method = 'POST', url, body, mode = 'ephemeral', wait = 45, useCached = false, approvalId = null, want = [], requestKey = null, fresh = false }) {
      const aud = allowed(url);
      // One operation ID per intended write, kept in its own file until the
      // answer is actually received. If the answer is lost and the same request
      // is made again within 15 minutes, the same ID is sent and the
      // counterparty writes once. The ID is signed into every proof.
      const opFile = `op-${sha256b64u(JSON.stringify([method, url, body])).slice(0, 24)}.json`;
      if (!requestKey) {
        const stale = read(opFile); if (fresh || (stale && stale.at <= nowSec() - 900)) remove(opFile);
        // Reserved atomically: if two processes start the same request at
        // once, exactly one creates the file and both use its ID.
        fs.mkdirSync(home, { recursive: true, mode: 0o700 });
        try { fs.writeFileSync(file(opFile), JSON.stringify({ key: randomId(), at: nowSec() }), { mode: 0o600, flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
        requestKey = read(opFile).key;
      }
      const dropPending = (id) => remove(`pending-${id}.json`);
      const disclosed = (creds) => ({ id: `${creds.sub} (${mode === 'pairwise' ? 'stable for this service' : 'single-use'})`, claims: creds.claims.map((c) => peek(c).payload.claim.type), withheld_by_policy: creds.withheld ?? [] });
      for (let round = 0; round < 5; round++) {
        let creds;
        if (useCached) {
          creds = read('last-credentials.json');
          if (!creds || creds.aud !== aud) throw new AgentError('no_cached_credentials');
        } else {
          try { creds = await this.issue({ aud, want, approvalId, mode }); } catch (e) {
            if (e.code === 'registration_revoked') {
              // The directory will not issue. Show what the counterparty says to
              // the last credentials this agent still holds.
              // Read-only check only: never retry a write with old credentials.
              const cached = read('last-credentials.json');
              const shop = cached && cached.aud === aud ? await this.present({ method: 'POST', url: aud + '/api/check', body: {}, creds: cached }) : null;
              return { status: 'refused', reason: 'registration_revoked', directory: 'refused to issue a new ID: this agent\'s registration is revoked', counterparty: shop ? { decision: shop.decision, reason: shop.error ?? 'still_accepted_until_status_refreshes', note: 'read-only check of the last credentials still held' } : null };
            }
            throw e;
          }
        }
        const res = await this.present({ method, url, body, creds, idempotencyKey: requestKey });
        const base = { disclosed: disclosed(creds), receipt: res.receipt };
        // The reservation is released only when a complete, signed answer has arrived.
        if (res.http_status === 200 && !res.receipt) throw new AgentError('incomplete_answer', { hint: 'Repeat the same request; it will not be written twice.' });
        if (res.http_status === 200) { remove(opFile); if (approvalId) dropPending(approvalId); return { status: 'done', result: res.quote ?? res.order ?? res, repeated: res.repeated, ...base }; }
        if (useCached) return { status: 'refused', reason: res.error, decision: res.decision, required: res.required, ...base };
        if (res.error === 'claim_required' || res.error === 'presentation_required') {
          const next = (res.required ?? []).filter((r) => ['authorization', 'principal_verification', 'principal_identity'].includes(r.type)).map((r) => ({ type: r.type, action: r.action }));
          const stillMissing = next.filter((n) => (creds.withheld ?? []).some((w) => w.type === n.type));
          if (stillMissing.length || JSON.stringify(next) === JSON.stringify(want)) {
            const me = await dir('GET', '/api/agent/me');
            return { status: 'needs_principal', reason: 'The service asks for something the directory will not attest for this agent.', required: res.required, withheld: creds.withheld, open: me.grants_url, next: 'Ask the user to open the link and grant or adjust the authorization with their passkey, then repeat the request.', ...base };
          }
          want = next; continue;
        }
        if (res.error === 'authorization_insufficient') {
          const me = await dir('GET', '/api/agent/me');
          return { status: 'needs_principal', reason: 'The standing authorization does not cover this amount. Only the user can widen it.', required: res.required, open: me.grants_url, next: 'Ask the user to open the link and change the limit with their passkey, then repeat the request.', ...base };
        }
        if (res.error === 'approval_required') {
          const ap = await dir('POST', '/api/approvals', { ticket: res.ticket });
          write(`pending-${ap.approval_id}.json`, { method, url, body, mode, want, requestKey, approval_id: ap.approval_id, review_url: ap.review_url, at: nowSec() });
          open(ap.review_url);
          const deadline = Date.now() + wait * 1000;
          let st = ap.status;
          while (st === 'pending' && Date.now() < deadline) { await sleep(1500); st = (await dir('GET', `/api/approvals/${ap.approval_id}`)).status; }
          if (st === 'approved') { approvalId = ap.approval_id; continue; }
          if (st === 'pending') return { status: 'approval_pending', reason: 'The service needs the user to approve this exact action with their passkey.', review_at: ap.review_url, next: 'Ask the user to review and approve in the browser, then run: aaf-agent continue', ...base };
          dropPending(ap.approval_id);
          return { status: 'refused', reason: 'approval_' + st, ...base };
        }
        return { status: 'refused', reason: res.error, decision: res.decision, required: res.required, ...base };
      }
      throw new AgentError('too_many_rounds');
    },

    // Resume after the user says they approved.
    async continue({ wait = 5, approvalId } = {}) {
      const all = list('pending-').sort((a, b) => b.at - a.at);
      const p = approvalId ? all.find((x) => x.approval_id === approvalId) : all[0];
      if (!p) return { status: 'nothing_pending' };
      const dropPending = (id) => remove(`pending-${id}.json`);
      const deadline = Date.now() + wait * 1000;
      let st;
      for (;;) { st = (await dir('GET', `/api/approvals/${p.approval_id}`)).status; if (st !== 'pending' || Date.now() >= deadline) break; await sleep(1500); }
      if (st === 'pending') return { status: 'approval_pending', review_at: p.review_url, next: 'The user has not approved yet.' };
      if (st !== 'approved') { dropPending(p.approval_id); return { status: 'refused', reason: 'approval_' + st }; }
      return this.act({ method: p.method, url: p.url, body: p.body, mode: p.mode, want: p.want, approvalId: p.approval_id, requestKey: p.requestKey, wait: 0 });
    },

    async catalog(shopUrl) { const o = allowed(shopUrl); return (await fetch(o + '/api/catalog', { redirect: 'error' })).json(); },
    shop() { const c = config().counterparties; if (!c.length) throw new AgentError('no_counterparty_configured'); return c[0]; },
    _read: read, _write: write, _dir: dir,
  };
}
