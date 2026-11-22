// The Sandbox Shop: a counterparty. It decides what an agent may do from the
// presentation alone, using only what each trusted directory publishes
// (keys and a whole status list fetched on a timer). It never asks a directory
// about a particular ID (PR-9) and never contacts a principal (PR-10).
import fs from 'node:fs';
import path from 'node:path';
import { createApp, setCookie, requireSameOrigin } from '../core/http.js';
import { openDb } from '../core/db.js';
import { TYP, loadOrCreateKey, sign, verify, peek } from '../core/tokens.js';
import { sha256b64u, randomId, nowSec, digestOf, unb64u, fail, HttpError } from '../core/util.js';
import { decodeList, getBit } from '../core/statuslist.js';
import { mountUi } from '../ui/mount.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS challenges (nonce TEXT PRIMARY KEY, exp INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS tickets (digest TEXT PRIMARY KEY, jwt TEXT NOT NULL, action_digest TEXT NOT NULL, exp INTEGER NOT NULL, order_id TEXT);
CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, sku TEXT NOT NULL, qty INTEGER NOT NULL, total REAL NOT NULL, currency TEXT NOT NULL, id_sub TEXT NOT NULL, approved INTEGER NOT NULL, idem TEXT UNIQUE, receipt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS quotes (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, sku TEXT NOT NULL, qty INTEGER NOT NULL, total REAL NOT NULL, id_sub TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS decisions (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, action TEXT NOT NULL, decision TEXT NOT NULL, reason TEXT NOT NULL, detail TEXT NOT NULL, receipt TEXT, case_ref TEXT);
`;

export function shopConfig(env = process.env) {
  const url = (env.AAF_SHOP_URL ?? 'http://localhost:4200').replace(/\/$/, '');
  return {
    url,
    port: Number(env.AAF_SHOP_PORT ?? new URL(url).port ?? 4200),
    host: env.AAF_BIND ?? '127.0.0.1',
    dataDir: env.AAF_SHOP_DATA ?? path.resolve('data/shop'),
    mode: env.AAF_ENV ?? 'local',
    // Which directories this shop chooses to trust. Counterparties decide this.
    trusted: (env.AAF_TRUSTED_DIRECTORIES ?? 'http://localhost:4100').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean),
    policyFile: env.AAF_SHOP_POLICY ?? path.resolve('config/shop-policy.json'),
    adminToken: env.AAF_SHOP_ADMIN_TOKEN ?? null,
    publicFeed: (env.AAF_SHOP_PUBLIC_FEED ?? ((env.AAF_ENV ?? 'local') === 'local' ? '1' : '0')) === '1',
    statusRefreshEvery: Number(env.AAF_STATUS_REFRESH_EVERY ?? 5),
    statusAcceptAge: 18, // must match the directory's published budget
    clockSkew: 2,
    projectRoot: env.AAF_PROJECT_ROOT ?? path.resolve('.'),
  };
}

// A decision that is not "granted". Carries what the agent needs to know next.
class Decision extends Error {
  constructor(decision, reason, extra = {}) { super(reason); this.decision = decision; this.reason = reason; this.extra = extra; }
}
const deny = (reason, extra) => { throw new Decision('denied', reason, extra); };

export async function createShop(cfg) {
  const db = openDb(path.join(cfg.dataDir, 'shop.sqlite'), SCHEMA);
  const key = await loadOrCreateKey(path.join(cfg.dataDir, 'signing-key.json'));
  const app = createApp({ name: 'shop' });
  const origin = new URL(cfg.url).origin;
  const ADMIN_COOKIE = 'aafshop_admin';
  // The policy file is re-read on every request, so thresholds can change mid-demo.
  const policy = () => JSON.parse(fs.readFileSync(cfg.policyFile, 'utf8'));

  // ---------- trusted directories: keys and status, fetched on a timer ----------
  const trust = new Map(cfg.trusted.map((issuer) => [issuer, { issuer, name: null, keys: [], practices: null, status: null, lastError: 'not fetched yet', metaAt: 0 }]));
  async function refreshDirectory(t) {
    try {
      if (nowSec() - t.metaAt > 60) {
        const res = await fetch(`${t.issuer}/.well-known/aaf-directory`, { signal: AbortSignal.timeout(3000) });
        const meta = await res.json();
        if (meta.issuer !== t.issuer) throw new Error('issuer mismatch');
        t.keys = meta.jwks.keys; t.name = meta.name; t.practices = meta.practices; t.statusUri = meta.status_list_uri; t.metaAt = nowSec();
      }
      const res = await fetch(t.statusUri, { signal: AbortSignal.timeout(3000) });
      const jwt = await res.text();
      const kid = peek(jwt).header.kid;
      const { payload } = await verify(jwt, t.keys.find((k) => k.kid === kid) ?? t.keys[0], TYP.status);
      if (payload.iss !== t.issuer) throw new Error('status issuer mismatch');
      // Never step back to an older revision or an older snapshot.
      if (t.status && (payload.rev < t.status.rev || payload.iat < t.status.iat)) throw new Error('stale status list offered');
      t.status = { rev: payload.rev, iat: payload.iat, bits: decodeList(payload.status_list.lst) };
      t.lastError = null;
    } catch (e) { t.lastError = e.message; }
  }
  const refreshAll = () => Promise.all([...trust.values()].map(refreshDirectory));
  await refreshAll();
  const timer = setInterval(refreshAll, cfg.statusRefreshEvery * 1000);
  timer.unref();

  // ---------- verifying a presentation ----------
  async function verifyPresentation(ctx) {
    const header = ctx.headers['aaf-presentation'];
    if (!header) throw new Decision('step_up', 'presentation_required', { required: [{ type: 'id' }] });
    let pres;
    try { pres = JSON.parse(unb64u(header).toString('utf8')); } catch { deny('presentation_malformed'); }
    if (typeof pres.id !== 'string' || typeof pres.proof !== 'string' || !Array.isArray(pres.claims) || pres.claims.length > 12) deny('presentation_malformed');
    const now = nowSec();

    // 1. The ID names its directory. The shop only accepts directories it trusts.
    let idPeek; try { idPeek = peek(pres.id); } catch { deny('presentation_malformed'); }
    const t = trust.get(idPeek.payload.iss);
    const ev = { issuer: idPeek.payload.iss ?? null, id: null, id_mode: null, claims: [], status: null };
    if (!t) throw new Decision('denied', 'untrusted_issuer', { ev });
    const dirKey = t.keys.find((k) => k.kid === idPeek.header.kid);
    if (!dirKey) throw new Decision('denied', 'issuer_key_unknown', { ev });
    let id; try { id = (await verify(pres.id, dirKey, TYP.id)).payload; } catch { throw new Decision('denied', 'id_signature_invalid', { ev }); }
    ev.id = id.sub; ev.id_mode = id.id_mode;
    if (id.aud !== cfg.url) throw new Decision('denied', 'wrong_audience', { ev });
    if (id.exp <= now - cfg.clockSkew) throw new Decision('denied', 'id_expired', { ev });
    if (id.iat > now + cfg.clockSkew) throw new Decision('denied', 'id_not_yet_valid', { ev });

    // 2. Holder binding (PR-2): the request is signed by the key the ID is bound
    // to, over this method, path, body, these exact credentials, and a nonce we
    // issued that can be used once.
    let proof; try { proof = (await verify(pres.proof, id.cnf.jwk, TYP.proof)).payload; } catch { throw new Decision('denied', 'holder_binding_failed', { ev }); }
    const credsHash = sha256b64u([pres.id, ...pres.claims].join('.'));
    if (proof.aud !== cfg.url || proof.htm !== ctx.req.method || proof.htu !== ctx.path) throw new Decision('denied', 'proof_wrong_target', { ev });
    if (proof.body_hash !== sha256b64u(ctx.rawBody ?? '')) throw new Decision('denied', 'proof_body_mismatch', { ev });
    if (proof.creds_hash !== credsHash) throw new Decision('denied', 'proof_credentials_mismatch', { ev });
    if (Math.abs(now - proof.iat) > 60) throw new Decision('denied', 'proof_stale', { ev });
    if (db.run('UPDATE challenges SET used = 1 WHERE nonce = ? AND used = 0 AND exp > ?', String(proof.nonce ?? ''), now).changes !== 1) throw new Decision('denied', 'nonce_invalid_or_replayed', { ev });
    ev.holder_verified = true; // from here on, the presenter is known to hold the ID's key

    // 3. Status, from the cached whole list. If the list is older than the
    // agreed budget the honest answer is "I cannot tell", and nothing is written.
    if (!t.status) throw new Decision('deferred', 'status_unavailable', { ev });
    const age = now - t.status.iat;
    ev.status = { rev: t.status.rev, age };
    if (age > cfg.statusAcceptAge + cfg.clockSkew) throw new Decision('deferred', 'status_too_old', { ev });
    if (getBit(t.status.bits, id.status.idx)) throw new Decision('denied', 'id_revoked', { ev });

    // 4. Claims: who attests each one, and is it still good (PR-3, PR-4).
    const claims = [];
    for (const jwt of pres.claims) {
      const entry = { type: 'unknown', attested_by: 'unknown', accepted: false, reason: null, value: null };
      try {
        const pk = peek(jwt);
        entry.type = pk.payload.claim?.type ?? 'unknown';
        if (pk.payload.attested_by === 'self') {
          // Signed only by the agent's own key. Recorded, never treated as attested.
          const c = (await verify(jwt, id.cnf.jwk, TYP.claim)).payload;
          entry.attested_by = 'self'; entry.value = c.claim.value; entry.reason = 'self_asserted';
        } else if (pk.payload.iss !== id.iss) {
          entry.attested_by = 'other'; entry.reason = trust.has(pk.payload.iss) ? 'issuer_differs_from_id' : 'untrusted_issuer';
        } else {
          const c = (await verify(jwt, dirKey, TYP.claim)).payload;
          entry.attested_by = 'directory'; entry.value = c.claim.value;
          if (c.sub !== id.sub) entry.reason = 'claim_for_another_id';
          else if (c.aud !== cfg.url) entry.reason = 'wrong_audience';
          else if (c.exp <= now - cfg.clockSkew) entry.reason = 'claim_expired';
          else if (getBit(t.status.bits, c.status.idx)) entry.reason = 'claim_revoked';
          else { entry.accepted = true; entry.idx = c.status.idx; }
        }
      } catch { entry.reason = 'claim_signature_invalid'; }
      claims.push(entry);
    }
    ev.claims = claims.map(({ value, idx, ...rest }) => ({ ...rest, value: rest.type === 'principal_identity' || rest.type === 'principal_verification' || rest.type === 'authorization' ? value : undefined }));
    return { id, claims, ev, issuerName: t.name };
  }

  // Run inside the write transaction: look again at the newest status list the
  // shop holds, so a revocation that arrived while the receipt was being signed
  // still stops the write.
  function recheckAtCommit(v, usedClaims) {
    const t = trust.get(v.id.iss); const now = nowSec();
    if (!t?.status || now - t.status.iat > cfg.statusAcceptAge + cfg.clockSkew) throw new Decision('deferred', 'status_too_old');
    if (v.id.exp <= now - cfg.clockSkew) throw new Decision('denied', 'id_expired');
    if (getBit(t.status.bits, v.id.status.idx)) throw new Decision('denied', 'id_revoked');
    for (const c of usedClaims) if (c && getBit(t.status.bits, c.idx)) throw new Decision('step_up', 'claim_required', { required: [{ type: c.type, not_accepted_because: ['claim_revoked'] }] });
  }

  // ---------- recording and answering ----------
  // Every protected decision gets a signed receipt that names the exact action
  // and parameters, whether the answer was yes, no, or "I need more".
  async function record(action, decision, reason, ev, extra = {}) {
    const actionDigest = extra.action_digest ?? null;
    const receipt = await sign(TYP.receipt, { iss: cfg.url, iat: nowSec(), jti: randomId(), action, params: extra.params ?? null, action_digest: actionDigest, decision, reason, holder_verified: ev?.holder_verified === true, id: ev?.id ?? null, id_issuer: ev?.issuer ?? null, id_mode: ev?.id_mode ?? null, claims: (ev?.claims ?? []).map((c) => ({ type: c.type, attested_by: c.attested_by, accepted: c.accepted, reason: c.reason })), status: ev?.status ?? null, result: extra.result ?? null }, key.privateJwk);
    return { receipt, detail: { ev: ev ?? null, params: extra.params ?? null, result: extra.result ?? null, required: extra.required ?? null } };
  }
  const saveDecision = (action, decision, reason, rec) => db.run('INSERT INTO decisions (ts, action, decision, reason, detail, receipt) VALUES (?,?,?,?,?,?)', nowSec(), action, decision, reason, JSON.stringify(rec.detail), rec.receipt);
  const STATUS_FOR = { denied: 403, step_up: 403, deferred: 503 };

  // Wrap a protected action: verify, decide, record, answer.
  function protectedRoute(action, describe, handler) {
    return async (ctx) => {
      const params = describe(ctx); // a malformed request is refused before anything else
      const base = { params, action_digest: digestOf({ action, params }) };
      let verified = null;
      try {
        verified = await verifyPresentation(ctx);
        return await handler(ctx, verified, base);
      } catch (e) {
        if (!(e instanceof Decision)) throw e;
        const ev = e.extra.ev ?? verified?.ev ?? null;
        e.extra = { ...base, ...e.extra };
        const rec = await record(action, e.decision, e.reason, ev, e.extra);
        saveDecision(action, e.decision, e.reason, rec);
        const { ev: _omit, ...publicExtra } = e.extra;
        throw new HttpError(e.reason === 'presentation_required' ? 401 : STATUS_FOR[e.decision], e.reason, { decision: e.decision, ...publicExtra, receipt: rec.receipt });
      }
    };
  }
  const item = (sku) => policy().catalog.find((c) => c.sku === sku) ?? fail(404, 'unknown_item');
  const qtyOf = (b) => { const q = Number(b.qty ?? 1); if (!Number.isInteger(q) || q < 1 || q > 100) fail(400, 'invalid_quantity'); return q; };

  // ---------- the service ----------
  // Level 0: open to anyone, with or without an ID. AAF is backward compatible.
  app.get('/api/catalog', () => { const p = policy(); return { shop: p.name, currency: p.currency, items: p.catalog, levels: describeLevels(p) }; });
  app.get('/api/challenge', () => { const nonce = randomId(18); db.run('INSERT INTO challenges (nonce, exp) VALUES (?,?)', nonce, nowSec() + 120); db.run('DELETE FROM challenges WHERE exp < ?', nowSec() - 600); return { nonce, expires_in: 120, audience: cfg.url }; });

  // Level 1: a valid accountable ID, nothing else.
  const orderParams = (ctx) => { const p = policy(); const it = item(ctx.body.sku); const qty = qtyOf(ctx.body); return { sku: it.sku, item: it.name, qty, total: it.price * qty, currency: p.currency }; };

  // A read-only check: "is this ID good right now?" Writes nothing but the
  // decision record. Used to show revocation without risking an order.
  app.post('/api/check', protectedRoute('shop.check', () => ({}), async (ctx, v, base) => {
    const rec = await record('shop.check', 'granted', 'valid_id', v.ev, base);
    saveDecision('shop.check', 'granted', 'valid_id', rec);
    return { decision: 'granted', receipt: rec.receipt };
  }));

  app.post('/api/quotes', protectedRoute('shop.quote', orderParams, async (ctx, v, base) => {
    const quote = { quote_id: 'q_' + randomId(6), ...base.params };
    const rec = await record('shop.quote', 'granted', 'valid_id', v.ev, { ...base, result: { quote_id: quote.quote_id } });
    db.tx(() => { recheckAtCommit(v, []); db.run('INSERT INTO quotes (id, ts, sku, qty, total, id_sub) VALUES (?,?,?,?,?,?)', quote.quote_id, nowSec(), quote.sku, quote.qty, quote.total, v.id.sub); saveDecision('shop.quote', 'granted', 'valid_id', rec); });
    return { decision: 'granted', quote, receipt: rec.receipt };
  }));

  // Levels 2 and 3: an order needs an authorization that covers the amount and
  // how the principal was verified; above the threshold it also needs a fresh
  // human approval of exactly this order.
  app.post('/api/orders', protectedRoute('shop.order', orderParams, async (ctx, v, base) => {
    const p = policy(); const params = base.params; const { total, qty } = params;
    const it = { sku: params.sku, name: params.item };
    const actionDigest = base.action_digest;
    const accepted = (type) => v.claims.find((c) => c.type === type && c.accepted);
    const offered = (type) => v.claims.filter((c) => c.type === type && !c.accepted).map((c) => c.reason);

    const required = [];
    const auth = v.claims.find((c) => c.type === 'authorization' && c.accepted && c.value.action === 'shop.order');
    if (!auth) required.push({ type: 'authorization', action: 'shop.order', min_amount: total, currency: p.currency, attested_by: 'directory', not_accepted_because: offered('authorization') });
    else if (auth.value.currency !== p.currency || auth.value.max_amount < total) throw new Decision('step_up', 'authorization_insufficient', { ...base, required: [{ type: 'authorization', action: 'shop.order', min_amount: total, currency: p.currency, presented_max: auth.value.max_amount }], needs: 'principal_to_widen_authorization' });
    if (!accepted('principal_verification')) required.push({ type: 'principal_verification', attested_by: 'directory', not_accepted_because: offered('principal_verification') });
    if (required.length) throw new Decision('step_up', 'claim_required', { ...base, required });

    let ticketDigest = null;
    if (total > p.approval_above) {
      const approval = accepted('approval');
      const ticket = approval && db.get('SELECT * FROM tickets WHERE digest = ?', approval.value.ticket_digest);
      const good = ticket && ticket.exp > nowSec() && ticket.action_digest === actionDigest && approval.value.action_digest === actionDigest && approval.value.grant_ref === auth.value.grant_ref && approval.value.user_verified === true;
      if (!good) {
        if (approval && ticket && ticket.action_digest !== actionDigest) throw new Decision('denied', 'approval_for_a_different_action', base);
        if (approval && ticket && approval.value.grant_ref !== auth.value.grant_ref) throw new Decision('denied', 'approval_under_a_different_authorization', base);
        // Ask for approval of exactly this order. The request is signed by the
        // shop and carried by the agent; the shop contacts no one.
        // The ticket names the ID that asked, so only the agent that ID was
        // issued to can take it to its directory.
        const jwt = await sign(TYP.ticket, { iss: cfg.url, aud: v.id.iss, iat: nowSec(), exp: nowSec() + 600, jti: randomId(), for_id: v.id.sub, action: 'shop.order', params, action_digest: actionDigest }, key.privateJwk);
        db.run('INSERT INTO tickets (digest, jwt, action_digest, exp) VALUES (?,?,?,?)', sha256b64u(jwt), jwt, actionDigest, nowSec() + 600);
        throw new Decision('step_up', 'approval_required', { ...base, ticket: jwt, required: [{ type: 'approval', why: `orders above ${p.currency} ${p.approval_above} need the principal's approval of the exact order` }] });
      }
      ticketDigest = ticket.digest;
    }

    // Write once. Consuming the approval, creating the order and storing the
    // receipt commit together; an identical retry gets the original receipt.
    const idem = ticketDigest ? 'ticket:' + ticketDigest : (ctx.headers['idempotency-key'] ? 'key:' + String(ctx.headers['idempotency-key']).slice(0, 80) + ':' + actionDigest : null);
    const orderId = 'ord_' + randomId(6);
    const rec = await record('shop.order', 'granted', ticketDigest ? 'authorized_and_approved' : 'authorized', v.ev, { ...base, result: { order_id: orderId } });
    const out = db.tx(() => {
      const prior = idem && db.get('SELECT * FROM orders WHERE idem = ?', idem);
      if (prior) return { order_id: prior.id, receipt: prior.receipt, repeated: true };
      recheckAtCommit(v, [auth, accepted('principal_verification'), ticketDigest ? accepted('approval') : null]);
      db.run('INSERT INTO orders (id, ts, sku, qty, total, currency, id_sub, approved, idem, receipt) VALUES (?,?,?,?,?,?,?,?,?,?)', orderId, nowSec(), it.sku, qty, total, p.currency, v.id.sub, ticketDigest ? 1 : 0, idem, rec.receipt);
      if (ticketDigest) db.run('UPDATE tickets SET order_id = ? WHERE digest = ?', orderId, ticketDigest);
      saveDecision('shop.order', 'granted', ticketDigest ? 'authorized_and_approved' : 'authorized', rec);
      return { order_id: orderId, receipt: rec.receipt, repeated: false };
    });
    return { decision: 'granted', order: { order_id: out.order_id, ...params }, repeated: out.repeated, receipt: out.receipt };
  }));

  // ---------- admin: reporting an incident ----------
  const isAdmin = (ctx) => cfg.mode === 'local' || (cfg.adminToken && ctx.cookies[ADMIN_COOKIE] === cfg.adminToken);
  app.post('/api/admin/signin', (ctx) => { requireSameOrigin(ctx, origin); if (!cfg.adminToken || ctx.body.token !== cfg.adminToken) fail(401, 'wrong_token'); setCookie(ctx.res, ADMIN_COOKIE, cfg.adminToken, { secure: origin.startsWith('https') }); return { ok: true }; });
  app.post('/api/admin/incidents', async (ctx) => {
    requireSameOrigin(ctx, origin);
    if (!isAdmin(ctx)) fail(401, 'admin_only');
    const d = db.get('SELECT * FROM decisions WHERE seq = ?', Number(ctx.body.seq)) ?? fail(404, 'decision_not_found');
    if (d.case_ref) return { case_ref: d.case_ref };
    const { payload } = peek(d.receipt);
    if (!payload.id || !payload.holder_verified || !trust.has(payload.id_issuer)) fail(409, 'no_holder_verified_id_in_this_decision');
    // The affected party reports to the directory with its own signed receipt.
    const res = await fetch(`${payload.id_issuer}/api/incidents`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ receipt: d.receipt, note: String(ctx.body.note ?? '').slice(0, 500) }) }).catch(() => null);
    if (!res?.ok) fail(502, 'directory_did_not_accept_report', { detail: res ? await res.json().catch(() => ({})) : 'unreachable' });
    const { case_ref } = await res.json();
    db.run('UPDATE decisions SET case_ref = ? WHERE seq = ?', case_ref, d.seq);
    return { case_ref };
  });

  // ---------- public material ----------
  app.get('/.well-known/aaf-counterparty', (ctx) => { ctx.res.setHeader('access-control-allow-origin', '*'); return { issuer: cfg.url, name: policy().name, jwks: { keys: [key.publicJwk] }, trusted_directories: cfg.trusted }; });
  app.get('/healthz', () => ({ ok: true, service: 'shop', directories: [...trust.values()].map((t) => ({ issuer: t.issuer, status_rev: t.status?.rev ?? null, error: t.lastError })) }));

  function describeLevels(p) {
    return [
      { level: 0, example: 'Browse the catalog', requires: 'Nothing. Agents without an ID are still served.' },
      { level: 1, example: 'Get a quote', requires: 'A valid accountable ID from a directory this shop trusts.' },
      { level: 2, example: `Order up to ${p.currency} ${p.approval_above}`, requires: 'Plus a directory-attested authorization covering the amount, and how the principal was verified.' },
      { level: 3, example: `Order above ${p.currency} ${p.approval_above}`, requires: "Plus the principal's fresh passkey approval of that exact order." },
    ];
  }

  // What the page shows. Display data only.
  function view(ctx) {
    const p = policy(); const admin = isAdmin(ctx); const now = nowSec();
    const base = { surface: 'shop', meta: { name: p.name, url: cfg.url, mode: cfg.mode, now }, viewer: { role: admin ? 'admin' : 'public' }, levels: describeLevels(p), catalog: p.catalog, currency: p.currency, trust: [...trust.values()].map((t) => ({ issuer: t.issuer, name: t.name, status_rev: t.status?.rev ?? null, status_age: t.status ? now - t.status.iat : null, fresh: !!t.status && now - t.status.iat <= cfg.statusAcceptAge + cfg.clockSkew, max_age: cfg.statusAcceptAge, error: t.lastError })) };
    if (!admin && !cfg.publicFeed) return { ...base, decisions: [], orders: [], feed_hidden: true };
    base.decisions = db.all('SELECT * FROM decisions ORDER BY seq DESC LIMIT 60').map((d) => {
      const det = JSON.parse(d.detail); const ev = det.ev ?? {};
      const learned = []; const notLearned = [];
      if (ev.id) learned.push(`An accountable ID (${ev.id_mode === 'pairwise' ? 'stable for this shop' : 'single-use'}) issued by ${ev.issuer}`); else if (ev.issuer) learned.push(`A credential naming ${ev.issuer}`);
      for (const c of ev.claims ?? []) {
        const who = c.attested_by === 'directory' ? 'attested by the directory' : c.attested_by === 'self' ? 'asserted only by the agent itself' : 'from an issuer this shop does not trust';
        if (c.type === 'authorization' && c.value) learned.push(`Authorization: ${c.value.action} up to ${c.value.currency} ${c.value.max_amount}, ${who}${c.accepted ? '' : ' (not accepted: ' + c.reason + ')'}`);
        else if (c.type === 'principal_verification' && c.value) learned.push(`Principal verified by ${c.value.identity_type} control, ${c.value.assurance} assurance, ${who}`);
        else if (c.type === 'principal_identity' && c.value) learned.push(`Principal identity disclosed: ${c.value.identity}, ${who}`);
        else if (c.type === 'approval') learned.push(`A passkey approval of this exact action, ${who}${c.accepted ? '' : ' (not accepted: ' + c.reason + ')'}`);
        else learned.push(`Claim "${c.type}", ${who}${c.accepted ? '' : ' (not accepted: ' + c.reason + ')'}`);
      }
      if (ev.id && !(ev.claims ?? []).some((c) => c.type === 'principal_identity' && c.accepted)) notLearned.push("The principal's name, email or any other identity");
      if (ev.id) notLearned.push('Which agent software this is, or what else it has done elsewhere');
      if (ev.id && ev.id_mode !== 'pairwise') notLearned.push('Whether this is the same agent as any earlier visit');
      return { seq: d.seq, ts: d.ts, action: d.action, decision: d.decision, reason: d.reason, id: ev.id ?? null, id_mode: ev.id_mode ?? null, issuer: ev.issuer ?? null, claims: (ev.claims ?? []).map((c) => ({ type: c.type, attested_by: c.attested_by, accepted: c.accepted, reason: c.reason })), status_rev: ev.status?.rev ?? null, status_age: ev.status?.age ?? null, params: det.params, result: det.result, required: det.required, learned, not_learned: notLearned, receipt_ref: d.receipt ? sha256b64u(d.receipt).slice(0, 12) : null, case_ref: d.case_ref, can_report: admin && !!ev.id && ev.holder_verified === true && !d.case_ref };
    });
    base.orders = db.all('SELECT id, ts, sku, qty, total, currency, approved FROM orders ORDER BY ts DESC LIMIT 30');
    return base;
  }
  app.get('/api/view', (ctx) => view(ctx));

  mountUi(app, { surface: 'shop', projectRoot: cfg.projectRoot, title: policy().name, mode: cfg.mode, origin });

  let server = null;
  return {
    app, db, cfg, key, trust, refreshAll,
    async listen() { server = await app.listen(cfg.port, cfg.host); return server; },
    async close() { clearInterval(timer); if (server) await new Promise((r) => { server.closeAllConnections?.(); server.close(r); }); db.close(); },
  };
}
