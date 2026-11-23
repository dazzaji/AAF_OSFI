// The agent's side of the protocol. This process holds the AGENT key only.
// It never sees the principal's passkey, session or any directory operator
// credential, and it only talks to the directory and counterparties named in
// its own config file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TYP, newKeyPair, sign, peek, verify } from '../core/tokens.js';
import { b64u, sha256b64u, randomId, nowSec } from '../core/util.js';

export const VERSION = '0.2.0';
export class AgentError extends Error { constructor(code, detail = {}) { super(code); this.code = code; this.detail = detail; } }

// Where this client is installed. The release ZIP's launcher sets it; from a
// source checkout it is this file's folder.
export const installRoot = () => process.env.AAF_AGENT_INSTALL_ROOT ?? path.dirname(fileURLToPath(import.meta.url));
// The profile folder holds the agent's key. In order: the environment, then
// the folder chosen with `init --home` (remembered beside this install, so two
// apps on one computer need not share a key), then ~/.aaf-agent.
export function defaultHome() {
  if (process.env.AAF_AGENT_HOME) return process.env.AAF_AGENT_HOME;
  try { const p = fs.readFileSync(path.join(installRoot(), 'profile-home.txt'), 'utf8').trim(); if (p) return p; } catch { /* not set */ }
  return path.join(os.homedir(), '.aaf-agent');
}

export function createAgent({ home = defaultHome(), openBrowser = true } = {}) {
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
    try {
      const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
      const child = spawn(cmd, args, { stdio: 'ignore', detached: true }); child.on('error', () => {}); child.unref(); return true;
    } catch { return false; }
  }
  // Put an identity that can no longer be used out of the way. Nothing is
  // deleted: the old key and records move to a dated subfolder.
  function retire(why) {
    const names = fs.existsSync(home) ? fs.readdirSync(home).filter((f) => /^(key|pairing|last-credentials)\.json$|^(op|pending)-.*\.json$/.test(f)) : [];
    if (names.length) { const to = file(`retired-${new Date().toISOString().replace(/[:.]/g, '-')}`); fs.mkdirSync(to, { recursive: true, mode: 0o700 }); for (const f of names) fs.renameSync(file(f), path.join(to, f)); fs.writeFileSync(path.join(to, 'why.txt'), why + '\n', { mode: 0o600 }); }
    const { agent_id: _gone, ...rest } = read('config.json', {});
    write('config.json', rest);
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
      let cfg = read('config.json', {});
      const origin = new URL(directory).origin;
      // A different directory is a different registration: the saved agent ID
      // and any half-finished request belong to the old one and are set aside.
      if (cfg.directory && cfg.directory !== origin) { retire(`moved from ${cfg.directory} to ${origin}`); cfg = { counterparties: [] }; }
      write('config.json', { ...cfg, directory: origin, counterparties: [...new Set([...(cfg.counterparties ?? []), ...shops.map((s) => new URL(s).origin)])] });
      return config();
    },

    // Ask the directory to register this agent. The principal approves in the
    // browser with a passkey; nothing this process can do completes it.
    async register({ name, harness, wait = 0, fresh = false } = {}) {
      let cfg = config();
      if (cfg.agent_id) {
        // Ask the directory how this registration stands before saying "done":
        // an agent that was revoked, or that a reset directory no longer knows,
        // must not be told it is registered.
        const me = await dir('GET', '/api/agent/me').catch((e) => { if (e.code === 'unknown_agent') return { status: 'unknown' }; throw e; });
        if (me.status === 'active') { if (fresh) throw new AgentError('still_registered', { agent_id: cfg.agent_id, hint: 'This agent is registered and active. --new is only for an agent that was revoked.' }); return { status: 'already_registered', agent_id: cfg.agent_id }; }
        if (!fresh) return { status: me.status === 'revoked' ? 'registration_revoked' : 'registration_unknown', agent_id: cfg.agent_id, next: (me.status === 'revoked' ? 'This agent ID was revoked by the user or the directory. ' : 'The directory has no record of this agent ID. ') + 'Tell the user. If they want this agent connected again, run: aaf-agent register --new (it makes a new key and asks for a new registration, which the user approves with their passkey).' };
        retire(`registration ${me.status}; started over with --new`); cfg = config();
      }
      let pending = read('pairing.json');
      const check = async () => {
        const s = await dir('GET', `/api/pairings/${pending.pairing_id}`, undefined, { iss: 'unregistered' });
        if (s.status === 'approved') { write('config.json', { ...config(), agent_id: s.agent_id }); remove('pairing.json'); return { status: 'registered', agent_id: s.agent_id }; }
        if (s.status === 'denied' || s.status === 'expired') { remove('pairing.json'); return { status: 'registration_' + s.status }; }
        return null;
      };
      // A saved request past its time is asked about before it is replaced: the
      // principal may have approved it in time and the agent only came back
      // late. The directory will not register the same key a second time, so
      // starting again here would leave the agent unable to learn its own ID.
      if (pending && pending.expires_at <= nowSec()) {
        const r = await check().catch((e) => { if (e.code !== 'pairing_not_found') throw e; remove('pairing.json'); return { status: 'registration_expired' }; });
        if (r?.status === 'registered' || r?.status === 'registration_denied') return r;
        if (r) pending = null; // the directory agrees it is over: start again
      }
      if (!pending) {
        const key = read('key.json') ?? (await newKeyPair());
        write('key.json', key);
        const out = await dir('POST', '/api/pairings', { name: name ?? `Agent on ${os.hostname()}`, harness, public_jwk: key.publicJwk }, { key, iss: 'unregistered' });
        pending = { ...out, expires_at: nowSec() + out.expires_in };
        write('pairing.json', pending);
        open(pending.verify_url);
      }
      const deadline = Date.now() + wait * 1000;
      for (;;) { const r = await check(); if (r) return r; if (Date.now() >= deadline) break; await sleep(1500); }
      return { status: 'waiting_for_principal', user_code: pending.user_code, key_fingerprint: pending.fingerprint, approve_at: pending.verify_url, expires_in_seconds: Math.max(0, pending.expires_at - nowSec()), next: 'STOP HERE and hand over. Write the code, the fingerprint and the link to the user in a chat message, ask them to open the link in their browser, check that both match, and approve with their passkey, and end your turn. The approval is complete when the directory page says so. Only when the user says they approved, run: aaf-agent register --wait 90 (it only checks; it approves nothing).' };
    },

    async status() {
      const cfg = config();
      if (!cfg.agent_id) return { registered: false, directory: cfg.directory, counterparties: cfg.counterparties, ...(read('pairing.json') ? { pairing: 'waiting for the user to approve in the browser; run: aaf-agent register --wait 90' } : { next: 'run: aaf-agent register --name "<a label the user will recognise>"' }) };
      const me = await dir('GET', '/api/agent/me').catch((e) => { if (e.code === 'unknown_agent') return null; throw e; });
      if (!me) return { registered: false, directory: cfg.directory, counterparties: cfg.counterparties, note: 'The directory has no record of the agent ID saved here.', next: 'Tell the user. To connect again run: aaf-agent register --new' };
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
    // opSecret: the operation's secret. Only its hash is signed into the proof.
    // The secret itself is sent (in a header) only when the counterparty says
    // the operation already completed and asks for it.
    async present({ method, url, body, creds, extraClaims = [], opSecret, revealSecret = false }) {
      const o = allowed(url); const u = new URL(url);
      const ch = await (await fetch(o + '/api/challenge', { redirect: 'error', signal: AbortSignal.timeout(10000) })).json();
      const raw = body === undefined ? '' : JSON.stringify(body);
      const claims = [...creds.claims, ...extraClaims];
      const proof = await sign(TYP.proof, { aud: o, htm: method, htu: u.pathname + u.search, body_hash: sha256b64u(raw), creds_hash: sha256b64u([creds.id, ...claims].join('.')), nonce: ch.nonce, op: opSecret ? sha256b64u(opSecret) : undefined, iat: nowSec(), jti: randomId() }, creds.key);
      const res = await fetch(url, { method, redirect: 'error', headers: { 'aaf-presentation': b64u(JSON.stringify({ id: creds.id, claims, proof })), ...(revealSecret && opSecret ? { 'aaf-op-secret': opSecret } : {}), ...(raw ? { 'content-type': 'application/json' } : {}) }, body: raw || undefined, signal: AbortSignal.timeout(15000) });
      return { http_status: res.status, ...(await res.json().catch(() => ({}))) };
    },

    // Is this receipt the counterparty's signed "done" for exactly this
    // operation? Checked before the agent forgets the operation, so a forged or
    // unrelated answer cannot make it drop its retry state.
    async checkReceipt({ receipt, aud, opSecret, action, body, ticketDigest = null }) {
      try {
        const res = await fetch(aud + '/.well-known/aaf-counterparty', { redirect: 'error', signal: AbortSignal.timeout(10000) });
        const keys = (await res.json()).jwks?.keys ?? [];
        const jwk = keys.find((k) => k.kid === peek(receipt).header.kid);
        if (!jwk) return 'receipt_key_unknown';
        const r = (await verify(receipt, jwk, TYP.receipt)).payload;
        if (r.iss !== aud) return 'receipt_from_another_service';
        if (r.decision !== 'granted') return 'receipt_is_not_a_grant';
        if (action && r.action !== action) return 'receipt_for_another_action';
        // Normally the receipt names this operation. One exception: an order
        // already written under the same single-use approval, reached again
        // under a new operation ID. The receipt names the approval ticket it
        // consumed, and that must be the ticket in the approval this agent
        // just presented. The parameters are still checked below.
        if (r.op !== sha256b64u(opSecret) && !(ticketDigest && r.ticket === ticketDigest)) return 'receipt_for_another_operation';
        if (body?.sku !== undefined && (r.params?.sku !== body.sku || r.params?.qty !== (body.qty ?? 1))) return 'receipt_for_other_parameters';
        return null;
      } catch { return 'receipt_signature_invalid'; }
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
      // is made again, the same ID is sent and the counterparty writes once.
      // The ID is signed into every proof.
      const opFile = `op-${sha256b64u(JSON.stringify([method, url, body])).slice(0, 24)}.json`;
      if (!requestKey) {
        // An unresolved operation is kept until it is answered or the user
        // explicitly starts a new one (--new). It does not time out.
        if (fresh) remove(opFile);
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
        let res = await this.present({ method, url, body, creds, opSecret: requestKey });
        // The operation already completed there: prove it is ours and get the stored answer.
        if (res.error === 'operation_secret_required') res = await this.present({ method, url, body, creds, opSecret: requestKey, revealSecret: true });
        const base = { disclosed: disclosed(creds), receipt: res.receipt };
        // The reservation is released only when a complete, signed answer has arrived.
        if (res.http_status === 200 && !res.receipt) throw new AgentError('incomplete_answer', { hint: 'Repeat the same request; it will not be written twice.' });
        if (res.http_status === 200) {
          const action = { '/api/orders': 'shop.order', '/api/quotes': 'shop.quote' }[new URL(url).pathname];
          const presentedApproval = creds.claims.map((c) => { try { return peek(c).payload.claim; } catch { return null; } }).find((c) => c?.type === 'approval');
          const bad = await this.checkReceipt({ receipt: res.receipt, aud, opSecret: requestKey, action, body, ticketDigest: presentedApproval?.value?.ticket_digest ?? null });
          if (bad) throw new AgentError('receipt_not_accepted', { reason: bad, hint: 'The answer did not carry a valid signed receipt for this operation. Nothing was forgotten; repeat the same request.' });
        }
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
          if (st === 'pending') return { status: 'approval_pending', reason: 'The service needs the user to approve this exact action with their passkey.', review_at: ap.review_url, next: 'STOP HERE and hand over. Tell the user what is waiting and give them the link, and end your turn. The approval is complete when the directory page says so. Only when the user says they approved, run: aaf-agent continue (it only checks and carries on; it approves nothing).', ...base };
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
