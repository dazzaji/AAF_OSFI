// The Directory: verifies principals, registers agents, issues IDs and claims,
// records passkey approvals, revokes, publishes keys, status and practices, and
// can resolve an ID back to its principal under a stated process.
//
// Paper references (Appendix A) are noted beside the code that addresses them.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { createApp, setCookie, requireSameOrigin } from '../core/http.js';
import { openDb } from '../core/db.js';
import { TYP, loadOrCreateKey, sign, verify, peek, thumbprint } from '../core/tokens.js';
import { b64u, unb64u, sha256, sha256b64u, randomId, nowSec, canonical, digestOf, userCode, fail } from '../core/util.js';
import { emptyList, setBit, encodeList, randomFreeIndex } from '../core/statuslist.js';
import { mountUi } from '../ui/mount.js';
import { sendMail } from './mailer.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS principals (id TEXT PRIMARY KEY, identity_type TEXT NOT NULL, identity_value TEXT NOT NULL, method TEXT NOT NULL, assurance TEXT NOT NULL, is_operator INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, UNIQUE(identity_type, identity_value));
CREATE TABLE IF NOT EXISTS passkeys (cred_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, public_key TEXT NOT NULL, counter INTEGER NOT NULL, transports TEXT, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, principal_id TEXT NOT NULL, exp INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS invites (token TEXT PRIMARY KEY, email TEXT NOT NULL, is_operator INTEGER NOT NULL DEFAULT 0, exp INTEGER NOT NULL, used_at INTEGER, created INTEGER NOT NULL, delivery TEXT);
CREATE TABLE IF NOT EXISTS ceremonies (id TEXT PRIMARY KEY, kind TEXT NOT NULL, principal_id TEXT, challenge TEXT NOT NULL, op TEXT, args TEXT, display TEXT, exp INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS pairings (id TEXT PRIMARY KEY, user_code TEXT NOT NULL, name TEXT NOT NULL, harness TEXT, public_jwk TEXT NOT NULL, fingerprint TEXT NOT NULL, status TEXT NOT NULL, exp INTEGER NOT NULL, agent_id TEXT, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, name TEXT NOT NULL, harness TEXT, public_jwk TEXT NOT NULL, fingerprint TEXT NOT NULL UNIQUE, status TEXT NOT NULL, policy TEXT NOT NULL, created INTEGER NOT NULL, revoked_at INTEGER, revoked_by TEXT);
CREATE TABLE IF NOT EXISTS grants (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, action TEXT NOT NULL, max_amount REAL NOT NULL, currency TEXT NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL, exp INTEGER NOT NULL, revoked_at INTEGER);
CREATE TABLE IF NOT EXISTS issued (jti TEXT PRIMARY KEY, kind TEXT NOT NULL, claim_type TEXT, sub TEXT NOT NULL, agent_id TEXT NOT NULL, principal_id TEXT NOT NULL, aud TEXT NOT NULL, key_thumb TEXT NOT NULL, grant_id TEXT, approval_id TEXT, status_idx INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, iat INTEGER NOT NULL, exp INTEGER NOT NULL, id_mode TEXT);
CREATE INDEX IF NOT EXISTS issued_sub ON issued(sub);
CREATE INDEX IF NOT EXISTS issued_agent ON issued(agent_id);
CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, principal_id TEXT NOT NULL, counterparty TEXT NOT NULL, ticket TEXT NOT NULL, ticket_digest TEXT NOT NULL, details TEXT NOT NULL, grant_id TEXT NOT NULL, grant_version INTEGER NOT NULL, status TEXT NOT NULL, exp INTEGER NOT NULL, created INTEGER NOT NULL, decided_at INTEGER, evidence TEXT, UNIQUE(agent_id, ticket_digest));
CREATE TABLE IF NOT EXISTS cases (id TEXT PRIMARY KEY, counterparty TEXT NOT NULL, receipt TEXT NOT NULL, receipt_digest TEXT NOT NULL UNIQUE, sub TEXT NOT NULL, id_jti TEXT NOT NULL, note TEXT, status TEXT NOT NULL, created INTEGER NOT NULL, released_at INTEGER, basis TEXT, disclosure TEXT, operator_id TEXT);
CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, principal_id TEXT NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, to_addr TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, link TEXT);
CREATE TABLE IF NOT EXISTS used_jti (jti TEXT PRIMARY KEY, exp INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

export function directoryConfig(env = process.env) {
  const url = (env.AAF_DIRECTORY_URL ?? 'http://localhost:4100').replace(/\/$/, '');
  return {
    url,
    port: Number(env.AAF_DIRECTORY_PORT ?? new URL(url).port ?? 4100),
    host: env.AAF_BIND ?? '127.0.0.1',
    dataDir: env.AAF_DIRECTORY_DATA ?? path.resolve('data/directory'),
    mode: env.AAF_ENV ?? 'local',            // 'local' enables the labelled stand-ins; 'hosted' disables them
    operatorEmail: env.AAF_OPERATOR_EMAIL ?? 'operator@example.test',
    name: env.AAF_DIRECTORY_NAME ?? 'AAF Pilot Directory',
    idTtl: Number(env.AAF_ID_TTL ?? 300),                    // seconds an ID or claim stays valid
    statusPublishEvery: Number(env.AAF_STATUS_PUBLISH_EVERY ?? 5), // re-sign interval
    statusPublishMax: 10,   // RV-2 budget: longest delay from a revocation to a published list
    statusAcceptAge: 18,    // RV-2 budget: oldest list a verifier may rely on
    statusClockSkew: 2,     // RV-2 budget: allowed clock difference
    retentionDays: 30,
    smtp: env.AAF_SMTP_URL ?? null,
    mailFrom: env.AAF_MAIL_FROM ?? null,
    projectRoot: env.AAF_PROJECT_ROOT ?? path.resolve('.'),
  };
}

export async function createDirectory(cfg) {
  const db = openDb(path.join(cfg.dataDir, 'directory.sqlite'), SCHEMA);
  const key = await loadOrCreateKey(path.join(cfg.dataDir, 'signing-key.json'));
  const secretFile = path.join(cfg.dataDir, 'secrets.json');
  if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, JSON.stringify({ pairwise: randomId(32), grantRef: randomId(32) }), { mode: 0o600 });
  const secrets = JSON.parse(fs.readFileSync(secretFile, 'utf8'));
  const rpID = new URL(cfg.url).hostname;
  const origin = new URL(cfg.url).origin;
  const SESSION_COOKIE = 'aafdir_session';
  const app = createApp({ name: 'directory' });
  const hmac = (secret, text) => b64u(crypto.createHmac('sha256', secret).update(text).digest()).slice(0, 22);

  // ---------- evidence log (DR-2) ----------
  // Each entry carries the hash of the one before it, so a partial edit or a
  // missing entry is detectable. It does not stop an operator rewriting the
  // whole log; that needs an external witness, which is out of scope here.
  function logEvent(type, data) {
    const prev = db.get('SELECT hash FROM events ORDER BY seq DESC LIMIT 1')?.hash ?? 'genesis';
    const ts = nowSec();
    const body = canonical({ ts, type, data, prev });
    db.run('INSERT INTO events (ts, type, data, prev_hash, hash) VALUES (?,?,?,?,?)', ts, type, JSON.stringify(data), prev, sha256b64u(body));
  }
  const notify = (principalId, kind, text) => db.run('INSERT INTO notifications (principal_id, ts, kind, text) VALUES (?,?,?,?)', principalId, nowSec(), kind, text);

  // ---------- status list (PR-3, PR-9, RV-1, RV-2) ----------
  let statusJwt = null;
  let statusMeta = { rev: Number(db.get("SELECT v FROM meta WHERE k='status_rev'")?.v ?? 1), iat: 0 };
  const bumpStatusRev = () => { statusMeta.rev += 1; db.run("INSERT INTO meta (k, v) VALUES ('status_rev', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", String(statusMeta.rev)); };
  let publishSeq = 0;
  async function publishStatus() {
    const seq = ++publishSeq;
    const list = emptyList();
    // Entries stay set until the credential has expired anyway.
    for (const row of db.all('SELECT status_idx FROM issued WHERE revoked = 1 AND exp > ?', nowSec() - 60)) setBit(list, row.status_idx);
    const iat = nowSec();
    const jwt = await sign(TYP.status, { iss: cfg.url, iat, exp: iat + cfg.statusAcceptAge + cfg.statusClockSkew, rev: statusMeta.rev, status_list: { bits: 1, lst: encodeList(list) } }, key.privateJwk);
    if (seq !== publishSeq) return; // a newer snapshot was started; never put an older one back
    statusMeta.iat = iat; statusJwt = jwt;
  }
  const allocIndex = () => randomFreeIndex((idx) => !!db.get('SELECT 1 FROM issued WHERE status_idx = ? AND exp > ?', idx, nowSec() - 60));

  // ---------- published practices (DR-1) ----------
  const practices = () => ({
    kind: 'AAF lifecycle pilot. Not production. Not a conformity claim.',
    identity_proofing: [{ type: 'email', method: 'A single-use, expiring invitation link emailed only to the asserted mailbox. Redeeming it establishes control of that mailbox at that moment.', assurance: 'low', note: 'Not legal-person or human identity proofing (PV-2 is not offered). Anyone who can read that mailbox, or who is handed the link, can redeem it. Each principal record states how it was actually verified; records made on a local build or from the operator bootstrap link say so and carry no assurance.' }],
    sybil_resistance: 'One principal record per verified email address in this directory.',
    principal_authentication: 'Passkey (WebAuthn) with user verification required. Registering an agent, granting authority, approving an action and revoking each need a fresh assertion.',
    agent_authentication: 'Ed25519 key generated by the agent. Proof of possession at registration, at every issuance, and on every request to a counterparty.',
    id_issuance: 'On demand. Each ID is short-lived and bound to a fresh key.',
    id_lifetime_seconds: cfg.idTtl,
    revocation: { kinds: ['agent registration (by principal or by directory operator)', 'single authorization (by principal)', 'single approval (by principal)', 'outstanding verification or identity claims, by withdrawing that disclosure (by principal)'], latency_seconds: cfg.statusPublishMax + cfg.statusAcceptAge + cfg.statusClockSkew, budget: { publish_max: cfg.statusPublishMax, verifier_accept_age: cfg.statusAcceptAge, clock_skew: cfg.statusClockSkew }, method: 'Signed whole-list snapshot, republished at least every ' + cfg.statusPublishEvery + ' seconds. Verifiers fetch the whole list; there is no per-ID lookup.' },
    signing_key: 'One online Ed25519 key held on the service host. No hardware protection, no offline root, manual rotation.',
    what_the_directory_learns: 'The counterparty each ID is issued for and when, the claims requested, and each action a principal approves. By default each ID is fresh and single-use, so a counterparty cannot link two of them from the IDs alone; this directory can. If the agent asks for a stable ID instead (pairwise mode, marked on the ID), every ID for that agent at that counterparty carries the same identifier and the counterparty can link those visits by design. Entries revoked together in the status list can reveal that they belong together. Within one transaction, the presentations that follow a request for more (and any retry) carry the same operation ID, so a counterparty can tell they are one transaction.',
    records_kept: 'Principal record, agent records, every issued ID with its agent and principal, grants, approvals, revocations, cases and disclosures.',
    retention: 'Records are kept for the life of the pilot and survive revocation. There is no automatic deletion: the operator deletes the pilot data by hand when the pilot closes.',
    release_process: 'An affected counterparty submits a signed decision receipt. An authenticated operator releases the agent label and verified identity for the IDs named in that receipt only, with a recorded basis, and the principal is notified. In this pilot the lawful request is a labelled simulation, not a real legal process.',
    transport: 'Requests are protected in transit by TLS on the hosted build. A presentation is bound to one request and one counterparty-issued nonce, not to the connection it travels on (Appendix C section 2, option 1).',
    stand_ins: cfg.mode === 'local' ? ['Invitation links are shown to the operator in a local outbox instead of being emailed, so no mailbox control is established and records say so.', 'The directory, the shop and the agent run under one user account on one computer. An agent with file access could read service keys. Separation between agent and services exists only on the hosted build.'] : [],
  });

  // ---------- sessions and passkeys (PV-5) ----------
  function session(ctx) {
    const token = ctx.cookies[SESSION_COOKIE];
    if (!token) return null;
    const s = db.get('SELECT * FROM sessions WHERE token = ? AND exp > ?', token, nowSec());
    if (!s) return null;
    return db.get('SELECT * FROM principals WHERE id = ?', s.principal_id);
  }
  const requirePrincipal = (ctx) => session(ctx) ?? fail(401, 'sign_in_required');
  const requireOperator = (ctx) => { const p = requirePrincipal(ctx); if (!p.is_operator) fail(403, 'operator_only'); return p; };
  function startSession(ctx, principalId) {
    const token = randomId(32);
    db.run('INSERT INTO sessions (token, principal_id, exp) VALUES (?,?,?)', token, principalId, nowSec() + 12 * 3600);
    setCookie(ctx.res, SESSION_COOKIE, token, { maxAge: 12 * 3600, secure: origin.startsWith('https') });
  }
  const passkeysOf = (principalId) => db.all('SELECT * FROM passkeys WHERE principal_id = ?', principalId);
  async function verifyAssertion(response, expectedChallenge) {
    const pk = db.get('SELECT * FROM passkeys WHERE cred_id = ?', response?.id) ?? fail(401, 'unknown_passkey');
    let result;
    try {
      result = await verifyAuthenticationResponse({ response, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true, credential: { id: pk.cred_id, publicKey: new Uint8Array(unb64u(pk.public_key)), counter: pk.counter, transports: pk.transports ? JSON.parse(pk.transports) : undefined } });
    } catch (e) { fail(401, 'passkey_verification_failed', { detail: e.message }); }
    if (!result.verified) fail(401, 'passkey_verification_failed');
    db.run('UPDATE passkeys SET counter = ? WHERE cred_id = ?', result.authenticationInfo.newCounter, pk.cred_id);
    return { passkey: pk, userVerified: result.authenticationInfo.userVerified };
  }

  // ---------- invitations and enrollment (PV-1, PV-3) ----------
  // One bare mailbox, lower-cased. The same string is the delivery address and
  // the identity that is recorded, so they cannot differ.
  const mailbox = (raw) => { const e = String(raw ?? '').trim().toLowerCase(); if (e.length > 254 || !/^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(e)) fail(400, 'invalid_email'); return e; };
  async function createInvite(rawEmail, { isOperator = false } = {}) {
    const email = mailbox(rawEmail);
    const token = randomId(24);
    const link = `${cfg.url}/?invite=${token}`;
    // Recorded before anything is sent, so a delivered link is never unknown
    // to the directory. A failed send withdraws it.
    db.tx(() => { db.run('INSERT INTO invites (token, email, is_operator, exp, created, delivery) VALUES (?,?,?,?,?,?)', token, email, isOperator ? 1 : 0, nowSec() + 48 * 3600, nowSec(), 'pending'); logEvent('invite.created', { email }); });
    let delivery;
    try { delivery = await sendMail(cfg, db, { to: email, subject: `Your invitation to ${cfg.name}`, body: `You have been invited to enroll as a principal in ${cfg.name}.\n\nOpen this single-use link within 48 hours:\n${link}\n\nRedeeming it shows that you control this mailbox.`, link }); } catch (e) {
      // A failed send may still have been delivered (the relay accepted the
      // message and the acknowledgment was lost). The link is kept valid: it
      // can only be redeemed by someone who received it. The operator is told.
      if ('status' in e) { db.run('DELETE FROM invites WHERE token = ?', token); throw e; } // nothing was attempted (mail not configured)
      db.tx(() => { db.run('UPDATE invites SET delivery = ? WHERE token = ?', 'email to the asserted mailbox (delivery not confirmed)', token); logEvent('invite.delivery_uncertain', { email }); });
      if (e instanceof Error && !('status' in e)) fail(502, 'mail_delivery_uncertain', { detail: 'The mail server did not confirm delivery. Invite again if the message does not arrive.' });
      throw e;
    }
    db.run('UPDATE invites SET delivery = ? WHERE token = ?', delivery, token);
    return { email, link: cfg.mode === 'local' ? link : undefined, delivery };
  }
  // How a principal was actually verified is recorded and later attested as is.
  const proofingFor = (inv) => (inv.delivery?.startsWith('email')
    ? { method: 'single-use link emailed to the mailbox and redeemed', assurance: 'low' }
    : inv.delivery?.startsWith('bootstrap')
      ? { method: 'operator bootstrap link from the service host; the mailbox was not verified', assurance: 'none' }
      : { method: 'LOCAL STAND-IN: link shown to the operator, not emailed; the mailbox was not verified', assurance: 'none (simulated)' });
  const liveInvite = (token) => db.get("SELECT * FROM invites WHERE token = ? AND used_at IS NULL AND delivery != 'pending' AND exp > ?", token, nowSec()) ?? fail(404, 'invite_invalid_or_used');

  app.get('/api/invites/:token', (ctx) => { const inv = liveInvite(ctx.params.token); const how = proofingFor(inv); return { email: inv.email, is_operator: !!inv.is_operator, proof_note: how.assurance === 'low' ? 'That whoever opened this single-use link could read that mailbox. It does not prove a legal identity.' : `Nothing about the mailbox: ${how.method}. The record will say so.` }; });
  app.post('/api/invites/:token/options', async (ctx) => {
    requireSameOrigin(ctx, origin);
    const inv = liveInvite(ctx.params.token);
    const existing = db.get("SELECT * FROM principals WHERE identity_type='email' AND identity_value = ?", inv.email);
    const options = await generateRegistrationOptions({ rpName: cfg.name, rpID, userName: inv.email, userID: new Uint8Array(sha256('aaf-user:' + inv.email).subarray(0, 16)), attestationType: 'none', authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, excludeCredentials: existing ? passkeysOf(existing.id).map((p) => ({ id: p.cred_id })) : [] });
    const id = randomId();
    db.run('INSERT INTO ceremonies (id, kind, challenge, args, exp) VALUES (?,?,?,?,?)', id, 'enroll', options.challenge, JSON.stringify({ invite: inv.token }), nowSec() + 300);
    return { ceremony_id: id, options };
  });
  app.post('/api/invites/:token/verify', async (ctx) => {
    requireSameOrigin(ctx, origin);
    const inv = liveInvite(ctx.params.token);
    const cer = db.get("SELECT * FROM ceremonies WHERE id = ? AND kind='enroll' AND used = 0 AND exp > ?", ctx.body.ceremony_id, nowSec()) ?? fail(400, 'ceremony_expired');
    if (JSON.parse(cer.args).invite !== inv.token) fail(400, 'ceremony_mismatch');
    let result;
    try { result = await verifyRegistrationResponse({ response: ctx.body.response, expectedChallenge: cer.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true }); } catch (e) { fail(400, 'passkey_registration_failed', { detail: e.message }); }
    if (!result.verified) fail(400, 'passkey_registration_failed');
    const cred = result.registrationInfo.credential;
    const principalId = db.tx(() => {
      // The invite and the ceremony are each usable once.
      if (db.run('UPDATE invites SET used_at = ? WHERE token = ? AND used_at IS NULL', nowSec(), inv.token).changes !== 1) fail(409, 'invite_invalid_or_used');
      db.run('UPDATE ceremonies SET used = 1 WHERE id = ?', cer.id);
      // PV-3: one principal record per verified mailbox. A second invitation to
      // the same address adds a passkey to the existing record.
      let p = db.get("SELECT * FROM principals WHERE identity_type='email' AND identity_value = ?", inv.email);
      if (!p) {
        p = { id: 'pr_' + randomId(9) };
        const how = proofingFor(inv);
        db.run('INSERT INTO principals (id, identity_type, identity_value, method, assurance, is_operator, created) VALUES (?,?,?,?,?,?,?)', p.id, 'email', inv.email, how.method, how.assurance, inv.is_operator, nowSec());
      } else {
        // One principal record per mailbox (PV-3), and in this pilot one passkey
        // per record: neither a link nor a signed-in session can add another.
        // Passkey recovery is out of scope.
        fail(409, 'principal_already_enrolled');
      }
      db.run('INSERT INTO passkeys (cred_id, principal_id, public_key, counter, transports, created) VALUES (?,?,?,?,?,?)', cred.id, p.id, b64u(cred.publicKey), cred.counter, JSON.stringify(cred.transports ?? []), nowSec());
      logEvent('principal.enrolled', { principal: p.id, identity_type: 'email', delivery: inv.delivery });
      return p.id;
    });
    startSession(ctx, principalId);
    return { ok: true };
  });

  // ---------- sign in ----------
  app.post('/api/auth/options', async (ctx) => {
    requireSameOrigin(ctx, origin);
    const options = await generateAuthenticationOptions({ rpID, userVerification: 'required' });
    const id = randomId();
    db.run('INSERT INTO ceremonies (id, kind, challenge, exp) VALUES (?,?,?,?)', id, 'signin', options.challenge, nowSec() + 300);
    return { ceremony_id: id, options };
  });
  app.post('/api/auth/verify', async (ctx) => {
    requireSameOrigin(ctx, origin);
    const cer = db.get("SELECT * FROM ceremonies WHERE id = ? AND kind='signin' AND used = 0 AND exp > ?", ctx.body.ceremony_id, nowSec()) ?? fail(400, 'ceremony_expired');
    db.run('UPDATE ceremonies SET used = 1 WHERE id = ?', cer.id);
    const { passkey } = await verifyAssertion(ctx.body.response, cer.challenge);
    startSession(ctx, passkey.principal_id);
    return { ok: true };
  });
  app.post('/api/auth/signout', (ctx) => { requireSameOrigin(ctx, origin); db.run('DELETE FROM sessions WHERE token = ?', ctx.cookies[SESSION_COOKIE] ?? ''); setCookie(ctx.res, SESSION_COOKIE, '', { maxAge: 0 }); return { ok: true }; });

  // ---------- confirmed operations ----------
  // Every privileged act is one passkey assertion over one stored, immutable
  // description of that act. The server builds the description from its own
  // records, shows it, binds the challenge to it, and on success executes that
  // stored operation and nothing else. A signed-in session alone cannot do any
  // of these.
  const agentOf = (principal, agentId) => db.get('SELECT * FROM agents WHERE id = ? AND principal_id = ?', agentId, principal.id) ?? fail(404, 'agent_not_found');
  const fmtMoney = (amount, currency) => `${currency} ${Number(amount).toFixed(2)}`;
  const normGrant = (g) => {
    const max = Number(g?.max_amount);
    if (!g || typeof g.action !== 'string' || !/^[a-z0-9_.:-]{1,64}$/.test(g.action) || !(max > 0) || max > 1e6) fail(400, 'invalid_grant');
    return { action: g.action, max_amount: max, currency: (g.currency ?? 'USD').toUpperCase().slice(0, 3), days: Math.min(Math.max(Number(g.days ?? 30), 1), 365) };
  };
  const normPolicy = (p) => ({ share_verification: p?.share_verification !== false, share_identity_with: Array.isArray(p?.share_identity_with) ? p.share_identity_with.filter((o) => typeof o === 'string').slice(0, 20) : [] });

  const OPS = {
    pair_approve: {
      prepare(principal, args) {
        const pairing = db.get("SELECT * FROM pairings WHERE id = ? AND status = 'pending' AND exp > ?", args.pairing_id, nowSec()) ?? fail(404, 'pairing_not_found_or_expired');
        const grant = args.grant ? normGrant(args.grant) : null;
        const policy = normPolicy(args.policy);
        return { args: { pairing_id: pairing.id, grant, policy }, display: { title: 'Register this agent as yours', lines: [['Agent name', pairing.name], ['Software', pairing.harness ?? 'not stated'], ['Pairing code', pairing.user_code], ['Key fingerprint', pairing.fingerprint], ['Initial authorization', grant ? `${grant.action} up to ${fmtMoney(grant.max_amount, grant.currency)} per action, for ${grant.days} days` : 'none'], ['Share how you were verified', policy.share_verification ? 'yes, when a service asks' : 'no'], ['Share your verified email', policy.share_identity_with.length ? 'only with ' + policy.share_identity_with.join(', ') : 'never']], warning: 'Only approve if the code and fingerprint match what your agent shows on this computer.' } };
      },
      execute(principal, args) {
        const pairing = db.get("SELECT * FROM pairings WHERE id = ? AND status = 'pending' AND exp > ?", args.pairing_id, nowSec()) ?? fail(409, 'pairing_not_found_or_expired');
        const agentId = 'ag_' + randomId(9);
        // AG-2: the agent record is created only on the instruction of the
        // authenticated principal, and is bound to the key that proved possession.
        db.run('INSERT INTO agents (id, principal_id, name, harness, public_jwk, fingerprint, status, policy, created) VALUES (?,?,?,?,?,?,?,?,?)', agentId, principal.id, pairing.name, pairing.harness, pairing.public_jwk, pairing.fingerprint, 'active', JSON.stringify(args.policy), nowSec());
        db.run("UPDATE pairings SET status = 'approved', agent_id = ? WHERE id = ?", agentId, pairing.id);
        if (args.grant) insertGrant(agentId, args.grant);
        logEvent('agent.registered', { agent: agentId, principal: principal.id, fingerprint: pairing.fingerprint });
        notify(principal.id, 'agent', `Agent "${pairing.name}" was registered.`);
        return { agent_id: agentId };
      },
    },
    grant_create: {
      prepare(principal, args) {
        const agent = agentOf(principal, args.agent_id);
        if (agent.status !== 'active') fail(409, 'agent_revoked');
        const g = normGrant(args);
        const old = db.get("SELECT * FROM grants WHERE agent_id = ? AND action = ? AND status = 'active'", agent.id, g.action);
        return { args: { agent_id: agent.id, ...g, replaces: old ? `${old.id}:${old.version}` : null }, display: { title: old ? 'Change this authorization' : 'Grant this authorization', lines: [['Agent', agent.name], ['May do', g.action], ['Limit', `${fmtMoney(g.max_amount, g.currency)} per action`], ['Lasts', `${g.days} days`], ['Replaces', old ? `${fmtMoney(old.max_amount, old.currency)} per action (version ${old.version})` : 'nothing']] } };
      },
      execute(principal, args) {
        const agent = agentOf(principal, args.agent_id);
        if (agent.status !== 'active') fail(409, 'agent_revoked');
        const old = db.get("SELECT * FROM grants WHERE agent_id = ? AND action = ? AND status = 'active'", agent.id, args.action);
        // The screen said what this replaces. If that changed meanwhile (for
        // example the authorization was withdrawn in another tab), stop.
        if ((old ? `${old.id}:${old.version}` : null) !== (args.replaces ?? null)) fail(409, 'grant_changed');
        if (old) revokeGrantRow(old, 'replaced');
        const id = insertGrant(agent.id, args, (old?.version ?? 0) + 1);
        logEvent('grant.created', { grant: id, agent: agent.id, action: args.action, max_amount: args.max_amount });
        return { grant_id: id };
      },
    },
    grant_revoke: {
      prepare(principal, args) {
        const grant = db.get('SELECT g.*, a.name AS agent_name FROM grants g JOIN agents a ON a.id = g.agent_id WHERE g.id = ? AND a.principal_id = ?', args.grant_id, principal.id) ?? fail(404, 'grant_not_found');
        return { args: { grant_id: grant.id }, display: { title: 'Withdraw this authorization', lines: [['Agent', grant.agent_name], ['Authorization', `${grant.action} up to ${fmtMoney(grant.max_amount, grant.currency)}`], ['Effect', 'The agent keeps its registration and can still identify itself. This authorization stops verifying within the published time.']] } };
      },
      execute(principal, args) {
        const grant = db.get('SELECT g.* FROM grants g JOIN agents a ON a.id = g.agent_id WHERE g.id = ? AND a.principal_id = ?', args.grant_id, principal.id) ?? fail(404, 'grant_not_found');
        if (grant.status === 'active') revokeGrantRow(grant, 'principal');
        return { ok: true };
      },
    },
    agent_revoke: {
      prepare(principal, args) {
        // The operator may also revoke, under the published practice (RV-1).
        const agent = principal.is_operator && args.as_operator ? (db.get('SELECT * FROM agents WHERE id = ?', args.agent_id) ?? fail(404, 'agent_not_found')) : agentOf(principal, args.agent_id);
        return { args: { agent_id: agent.id, as_operator: !!(principal.is_operator && args.as_operator) }, display: { title: 'Revoke this agent', lines: [['Agent', agent.name], ['Key fingerprint', agent.fingerprint], ['Effect', 'Every ID and claim issued to this agent stops verifying within the published time, and no new ones are issued. The record is kept so earlier actions can still be attributed.']] } };
      },
      execute(principal, args) {
        const agent = args.as_operator && principal.is_operator ? db.get('SELECT * FROM agents WHERE id = ?', args.agent_id) : agentOf(principal, args.agent_id);
        if (agent.status === 'active') {
          db.run("UPDATE agents SET status = 'revoked', revoked_at = ?, revoked_by = ? WHERE id = ?", nowSec(), args.as_operator ? 'directory' : 'principal', agent.id);
          db.run('UPDATE issued SET revoked = 1 WHERE agent_id = ? AND exp > ?', agent.id, nowSec());
          db.run("UPDATE grants SET status = 'revoked', revoked_at = ? WHERE agent_id = ? AND status = 'active'", nowSec(), agent.id);
          db.run("UPDATE approvals SET status = 'void' WHERE agent_id = ? AND status IN ('pending','approved')", agent.id);
          bumpStatusRev();
          logEvent('agent.revoked', { agent: agent.id, by: args.as_operator ? 'directory' : 'principal' });
          notify(agent.principal_id, 'agent', `Agent "${agent.name}" was revoked${args.as_operator ? ' by the directory operator' : ''}.`);
        }
        return { ok: true };
      },
    },
    policy_set: {
      prepare(principal, args) {
        const agent = agentOf(principal, args.agent_id);
        const policy = normPolicy(args.policy);
        return { args: { agent_id: agent.id, policy }, display: { title: 'Change what this agent may disclose', lines: [['Agent', agent.name], ['Share how you were verified', policy.share_verification ? 'yes, when a service asks' : 'no'], ['Share your verified email', policy.share_identity_with.length ? 'only with ' + policy.share_identity_with.join(', ') : 'never']] } };
      },
      execute(principal, args) {
        const agent = agentOf(principal, args.agent_id);
        db.run('UPDATE agents SET policy = ? WHERE id = ?', JSON.stringify(args.policy), agent.id);
        // RV-1: withdrawing a disclosure also revokes the claims of that kind
        // that are still outstanding, each through its own status entry.
        let n = 0;
        if (!args.policy.share_verification) n += db.run("UPDATE issued SET revoked = 1 WHERE agent_id = ? AND claim_type = 'principal_verification' AND exp > ? AND revoked = 0", agent.id, nowSec()).changes;
        for (const row of db.all("SELECT jti, aud FROM issued WHERE agent_id = ? AND claim_type = 'principal_identity' AND exp > ? AND revoked = 0", agent.id, nowSec())) if (!args.policy.share_identity_with.includes(row.aud)) { db.run('UPDATE issued SET revoked = 1 WHERE jti = ?', row.jti); n++; }
        if (n) bumpStatusRev();
        logEvent('agent.policy', { agent: agent.id, claims_revoked: n });
        return { ok: true };
      },
    },
    approval_approve: {
      prepare(principal, args) {
        const ap = db.get("SELECT ap.*, a.name AS agent_name FROM approvals ap JOIN agents a ON a.id = ap.agent_id WHERE ap.id = ? AND ap.principal_id = ? AND ap.status = 'pending' AND ap.exp > ?", args.approval_id, principal.id, nowSec()) ?? fail(404, 'approval_not_found_or_expired');
        const d = JSON.parse(ap.details);
        const grant = db.get('SELECT * FROM grants WHERE id = ?', ap.grant_id);
        // The challenge commits to the ticket and the grant version, so the
        // assertion cannot be moved to another action, counterparty or grant.
        return { args: { approval_id: ap.id }, bind: { ticket_digest: ap.ticket_digest, grant_id: ap.grant_id, grant_version: ap.grant_version }, display: { title: 'Approve this one action', lines: [['Requested by', `${ap.counterparty} (request signature verified)`], ['Action', d.action], ...Object.entries(d.params ?? {}).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)]), ['Agent', ap.agent_name], ['Under authorization', `${grant.action} up to ${fmtMoney(grant.max_amount, grant.currency)} (version ${grant.version})`], ['Approval expires', new Date(ap.exp * 1000).toLocaleTimeString()]], warning: 'This approves exactly this action, once. It does not widen what the agent may do.' } };
      },
      execute(principal, args, evidence) {
        const ap = db.get("SELECT * FROM approvals WHERE id = ? AND principal_id = ? AND status = 'pending' AND exp > ?", args.approval_id, principal.id, nowSec()) ?? fail(409, 'approval_not_found_or_expired');
        const grant = db.get('SELECT * FROM grants WHERE id = ?', ap.grant_id);
        if (grant.status !== 'active' || grant.version !== ap.grant_version) fail(409, 'grant_changed');
        db.run("UPDATE approvals SET status = 'approved', decided_at = ?, evidence = ? WHERE id = ?", nowSec(), JSON.stringify(evidence), ap.id);
        logEvent('approval.approved', { approval: ap.id, agent: ap.agent_id, ticket_digest: ap.ticket_digest, ...evidence });
        return { ok: true };
      },
    },
    approval_revoke: {
      // RV-1: one approval can be taken back by itself. The standing
      // authorization, the registration and every other claim are untouched.
      prepare(principal, args) {
        const ap = db.get("SELECT ap.*, a.name AS agent_name FROM approvals ap JOIN agents a ON a.id = ap.agent_id WHERE ap.id = ? AND ap.principal_id = ? AND ap.status = 'approved'", args.approval_id, principal.id) ?? fail(404, 'approval_not_found');
        const d = JSON.parse(ap.details);
        return { args: { approval_id: ap.id }, display: { title: 'Take back this approval', lines: [['Agent', ap.agent_name], ['For', ap.counterparty], ['Action', d.action], ...Object.entries(d.params ?? {}).map(([k, v]) => [k, String(v)]), ['Effect', 'If the action has not been carried out yet, it no longer can be under this approval. If it already has, this does not undo it. Nothing else the agent may do changes.']] } };
      },
      execute(principal, args) {
        const ap = db.get("SELECT * FROM approvals WHERE id = ? AND principal_id = ? AND status = 'approved'", args.approval_id, principal.id) ?? fail(409, 'approval_not_found');
        db.run("UPDATE approvals SET status = 'revoked' WHERE id = ?", ap.id);
        db.run('UPDATE issued SET revoked = 1 WHERE approval_id = ? AND exp > ?', ap.id, nowSec());
        bumpStatusRev();
        logEvent('approval.revoked', { approval: ap.id, agent: ap.agent_id });
        return { ok: true };
      },
    },
    invite_create: {
      operator: true,
      prepare(principal, args) { const email = mailbox(args.email); return { args: { email }, display: { title: 'Invite a principal', lines: [['Mailbox', email], ['Effect', 'A single-use link is sent to this mailbox only. Whoever redeems it becomes the verified principal for that address.']] } }; },
      async after(principal, args) { return createInvite(args.email); },
      execute() { return {}; },
    },
    case_release: {
      operator: true,
      prepare(principal, args) {
        const c = db.get("SELECT * FROM cases WHERE id = ? AND status = 'open'", args.case_id) ?? fail(404, 'case_not_found');
        const basis = String(args.basis ?? '').trim().slice(0, 300);
        if (basis.length < 10) fail(400, 'basis_required');
        return { args: { case_id: c.id, basis }, display: { title: 'Release identity for this case', lines: [['Case', c.id], ['Reported by', c.counterparty], ['ID in the receipt', c.sub], ['Basis recorded', basis], ['Effect', 'Releases the agent label and verified identity behind this one ID. The principal is notified and the release is logged.']], warning: 'SIMULATED authority request. In this pilot no real legal process stands behind this step.' } };
      },
      execute(principal, args) {
        const c = db.get("SELECT * FROM cases WHERE id = ? AND status = 'open'", args.case_id) ?? fail(409, 'case_not_found');
        // ES-1: the issuance record is the escrow. It is never deleted on revocation.
        const row = db.get("SELECT * FROM issued WHERE jti = ? AND kind = 'id'", c.id_jti) ?? fail(409, 'id_not_found');
        const agent = db.get('SELECT * FROM agents WHERE id = ?', row.agent_id);
        const pr = db.get('SELECT * FROM principals WHERE id = ?', row.principal_id);
        const disclosure = { id: c.sub, issued_at: row.iat, issued_for: row.aud, agent: { label: agent.name, fingerprint: agent.fingerprint, status_now: agent.status, revoked_at: agent.revoked_at }, principal: { identity_type: pr.identity_type, identity: pr.identity_value, proofing_method: pr.method, assurance: pr.assurance } };
        db.run("UPDATE cases SET status = 'released', released_at = ?, basis = ?, disclosure = ?, operator_id = ? WHERE id = ?", nowSec(), args.basis, JSON.stringify(disclosure), principal.id, c.id);
        logEvent('case.released', { case: c.id, operator: principal.id, basis: args.basis, sub: c.sub, simulated_authority: true });
        notify(pr.id, 'disclosure', `Your verified identity was released for case ${c.id} (reported by ${c.counterparty}). Basis recorded: ${args.basis}. This pilot's authority request is simulated.`);
        return { disclosure };
      },
    },
  };

  function insertGrant(agentId, g, version = 1) {
    const id = 'gr_' + randomId(9);
    db.run('INSERT INTO grants (id, agent_id, action, max_amount, currency, version, status, created, exp) VALUES (?,?,?,?,?,?,?,?,?)', id, agentId, g.action, g.max_amount, g.currency, version, 'active', nowSec(), nowSec() + g.days * 86400);
    return id;
  }
  function revokeGrantRow(grant, by) {
    // RV-1: a single claim can be revoked while the registration stays.
    db.run("UPDATE grants SET status = 'revoked', revoked_at = ? WHERE id = ?", nowSec(), grant.id);
    db.run('UPDATE issued SET revoked = 1 WHERE grant_id = ? AND exp > ?', grant.id, nowSec());
    db.run("UPDATE approvals SET status = 'void' WHERE grant_id = ? AND status IN ('pending','approved')", grant.id);
    bumpStatusRev();
    logEvent('grant.revoked', { grant: grant.id, agent: grant.agent_id, by });
  }

  app.post('/api/confirm/start', async (ctx) => {
    requireSameOrigin(ctx, origin);
    const principal = requirePrincipal(ctx);
    const op = OPS[ctx.body.op] ?? fail(400, 'unknown_operation');
    if (op.operator && !principal.is_operator) fail(403, 'operator_only');
    const prepared = op.prepare(principal, ctx.body.args ?? {});
    const id = randomId();
    const exp = nowSec() + 180;
    const binding = { ceremony: id, op: ctx.body.op, principal: principal.id, args: prepared.args, bind: prepared.bind ?? null, display: prepared.display, exp };
    const options = await generateAuthenticationOptions({ rpID, userVerification: 'required', allowCredentials: passkeysOf(principal.id).map((p) => ({ id: p.cred_id, transports: p.transports ? JSON.parse(p.transports) : undefined })), challenge: new Uint8Array(sha256(canonical(binding))) });
    db.run('INSERT INTO ceremonies (id, kind, principal_id, challenge, op, args, display, exp) VALUES (?,?,?,?,?,?,?,?)', id, 'confirm', principal.id, options.challenge, ctx.body.op, JSON.stringify(prepared.args), JSON.stringify(prepared.display), exp);
    return { ceremony_id: id, display: prepared.display, options };
  });
  app.post('/api/confirm/finish', async (ctx) => {
    requireSameOrigin(ctx, origin);
    const principal = requirePrincipal(ctx);
    const cer = db.get("SELECT * FROM ceremonies WHERE id = ? AND kind='confirm' AND principal_id = ? AND used = 0 AND exp > ?", ctx.body.ceremony_id, principal.id, nowSec()) ?? fail(400, 'ceremony_expired');
    const { passkey, userVerified } = await verifyAssertion(ctx.body.response, cer.challenge);
    if (passkey.principal_id !== principal.id) fail(403, 'passkey_not_yours');
    const op = OPS[cer.op];
    const args = JSON.parse(cer.args);
    const evidence = { ceremony: cer.id, challenge: cer.challenge, user_verified: userVerified, verified_at: nowSec(), origin, rp_id: rpID };
    // Consuming the ceremony and performing the operation commit together.
    const result = db.tx(() => {
      if (db.run('UPDATE ceremonies SET used = 1 WHERE id = ? AND used = 0', cer.id).changes !== 1) fail(409, 'ceremony_already_used');
      return op.execute(principal, args, evidence);
    });
    const extra = op.after ? await op.after(principal, args) : {};
    await publishStatus();
    return { ok: true, ...result, ...extra };
  });
  // Declining never needs a passkey: refusing is always safe.
  app.post('/api/approvals/:id/decline', (ctx) => { requireSameOrigin(ctx, origin); const p = requirePrincipal(ctx); db.run("UPDATE approvals SET status = 'declined', decided_at = ? WHERE id = ? AND principal_id = ? AND status = 'pending'", nowSec(), ctx.params.id, p.id); logEvent('approval.declined', { approval: ctx.params.id }); return { ok: true }; });
  app.post('/api/pairings/:id/deny', (ctx) => { requireSameOrigin(ctx, origin); const p = requirePrincipal(ctx); if (db.run("UPDATE pairings SET status = 'denied' WHERE id = ? AND status = 'pending'", ctx.params.id).changes) logEvent('pairing.denied', { pairing: ctx.params.id, by: p.id }); return { ok: true }; });

  // ---------- agent authentication (AG-1) ----------
  // Every agent request carries a token signed by the agent's registered key,
  // covering the method, path and body, valid for one use within a minute.
  async function agentAuth(ctx, publicJwk) {
    const token = ctx.headers['aaf-agent-auth'] ?? fail(401, 'agent_auth_required');
    let payload;
    try { ({ payload } = await verify(token, publicJwk, TYP.agentReq)); } catch { fail(401, 'agent_auth_invalid'); }
    if (payload.aud !== cfg.url || payload.htm !== ctx.req.method || payload.htu !== ctx.path) fail(401, 'agent_auth_wrong_target');
    if (payload.body_hash !== sha256b64u(ctx.rawBody ?? '')) fail(401, 'agent_auth_body_mismatch');
    if (Math.abs(nowSec() - payload.iat) > 60) fail(401, 'agent_auth_stale');
    try { db.run('INSERT INTO used_jti (jti, exp) VALUES (?,?)', 'a:' + payload.jti, nowSec() + 180); } catch { fail(401, 'agent_auth_replayed'); }
    return payload;
  }
  async function requireAgent(ctx, { allowRevoked = false } = {}) {
    const token = ctx.headers['aaf-agent-auth'] ?? fail(401, 'agent_auth_required');
    let iss; try { iss = peek(token).payload.iss; } catch { fail(401, 'agent_auth_invalid'); }
    const agent = db.get('SELECT * FROM agents WHERE id = ?', iss) ?? fail(401, 'unknown_agent');
    await agentAuth(ctx, JSON.parse(agent.public_jwk));
    if (agent.status !== 'active' && !allowRevoked) fail(403, 'registration_revoked');
    return agent;
  }

  // ---------- pairing: an agent asks to be registered ----------
  app.post('/api/pairings', async (ctx) => {
    const jwk = ctx.body.public_jwk;
    if (!jwk || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || !jwk.x) fail(400, 'invalid_key');
    await agentAuth(ctx, jwk); // proof of possession of the key being registered
    const fingerprint = (await thumbprint(jwk)).slice(0, 16);
    if (db.get('SELECT 1 FROM agents WHERE fingerprint = ?', fingerprint)) fail(409, 'key_already_registered');
    const id = 'pa_' + randomId(12);
    const code = userCode();
    db.run('INSERT INTO pairings (id, user_code, name, harness, public_jwk, fingerprint, status, exp, created) VALUES (?,?,?,?,?,?,?,?,?)', id, code, String(ctx.body.name ?? 'Unnamed agent').slice(0, 80), String(ctx.body.harness ?? '').slice(0, 40) || null, JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x }), fingerprint, 'pending', nowSec() + 600, nowSec());
    return { pairing_id: id, user_code: code, fingerprint, verify_url: `${cfg.url}/?pair=${id}`, expires_in: 600 };
  });
  app.get('/api/pairings/:id', async (ctx) => {
    const p = db.get('SELECT * FROM pairings WHERE id = ?', ctx.params.id) ?? fail(404, 'pairing_not_found');
    await agentAuth(ctx, JSON.parse(p.public_jwk));
    return { status: p.status === 'pending' && p.exp <= nowSec() ? 'expired' : p.status, agent_id: p.agent_id ?? undefined };
  });

  // ---------- issuance (PR-1, PR-2, PR-5, PR-7, PR-8, ES-1) ----------
  app.post('/api/issue', async (ctx) => {
    const agent = await requireAgent(ctx);
    const b = ctx.body;
    let aud; try { aud = new URL(b.aud).origin; } catch { fail(400, 'invalid_audience'); }
    const pjwk = b.presentation_jwk;
    if (!pjwk || pjwk.kty !== 'OKP' || pjwk.crv !== 'Ed25519' || !pjwk.x) fail(400, 'invalid_presentation_key');
    // The agent proves it holds the fresh presentation key.
    let pop; try { ({ payload: pop } = await verify(b.key_pop ?? '', pjwk, TYP.keyPop)); } catch { fail(400, 'presentation_key_pop_invalid'); }
    if (pop.aud !== cfg.url || pop.agent !== agent.id || Math.abs(nowSec() - pop.iat) > 60) fail(400, 'presentation_key_pop_invalid');
    const keyThumb = await thumbprint(pjwk);
    if (db.get('SELECT 1 FROM issued WHERE key_thumb = ?', keyThumb)) fail(409, 'presentation_key_reused');

    const principal = db.get('SELECT * FROM principals WHERE id = ?', agent.principal_id);
    const policy = JSON.parse(agent.policy);
    const mode = b.mode === 'pairwise' ? 'pairwise' : 'ephemeral';
    // Ephemeral: a new random ID every time, unlinkable to counterparties.
    // Pairwise: one stable ID per agent and counterparty, by request (PR-8).
    const sub = mode === 'pairwise' ? 'pp_' + hmac(secrets.pairwise, agent.id + '|' + aud) : 'id_' + randomId(16);
    const iat = nowSec();
    const exp = iat + cfg.idTtl;
    const grantRef = (g) => hmac(secrets.grantRef, `${g.id}|${g.version}|${sub}`); // per-ID, so it cannot link presentations
    const claims = [];
    const withheld = [];
    for (const want of Array.isArray(b.want) ? b.want.slice(0, 8) : []) {
      if (want.type === 'authorization') {
        const g = db.get("SELECT * FROM grants WHERE agent_id = ? AND action = ? AND status = 'active' AND exp > ?", agent.id, want.action, iat);
        if (!g) { withheld.push({ type: 'authorization', action: want.action, reason: 'no_active_grant' }); continue; }
        claims.push({ type: 'authorization', grant_id: g.id, grant_version: g.version, exp: Math.min(exp, g.exp), value: { action: g.action, max_amount: g.max_amount, currency: g.currency, grant_ref: grantRef(g) } });
      } else if (want.type === 'principal_verification') {
        if (!policy.share_verification) { withheld.push({ type: want.type, reason: 'principal_policy' }); continue; }
        claims.push({ type: 'principal_verification', value: { identity_type: principal.identity_type, method: principal.method, assurance: principal.assurance } });
      } else if (want.type === 'principal_identity') {
        if (!policy.share_identity_with.includes(aud)) { withheld.push({ type: want.type, reason: 'principal_policy' }); continue; }
        claims.push({ type: 'principal_identity', value: { identity_type: principal.identity_type, identity: principal.identity_value } });
      } else withheld.push({ type: String(want.type), reason: 'unsupported_claim_type' });
    }
    if (b.approval_id) {
      const ap = db.get('SELECT * FROM approvals WHERE id = ? AND agent_id = ?', b.approval_id, agent.id) ?? fail(404, 'approval_not_found');
      if (ap.status !== 'approved') fail(409, 'approval_' + ap.status);
      if (ap.exp <= iat) fail(409, 'approval_expired');
      if (ap.counterparty !== aud) fail(409, 'approval_wrong_audience');
      const g = db.get('SELECT * FROM grants WHERE id = ?', ap.grant_id);
      if (g.status !== 'active' || g.version !== ap.grant_version) fail(409, 'grant_changed');
      const d = JSON.parse(ap.details);
      claims.push({ type: 'approval', grant_id: g.id, grant_version: g.version, approval_id: ap.id, exp: Math.min(exp, ap.exp, g.exp), value: { ticket_digest: ap.ticket_digest, action_digest: d.action_digest, grant_ref: grantRef(g), approved_at: ap.decided_at, method: 'passkey', user_verified: true } });
    }
    // ES-1 / DR-2: the link from this ID to the agent and principal is on disk
    // before anything signed leaves the directory.
    const idJti = randomId();
    const rows = db.tx(() => {
      // Verification above awaited; a revocation may have landed meanwhile.
      // Re-read everything this issuance depends on before anything is stored.
      const nowAgent = db.get('SELECT status, policy FROM agents WHERE id = ?', agent.id);
      if (nowAgent.status !== 'active') fail(403, 'registration_revoked');
      const nowPolicy = JSON.parse(nowAgent.policy);
      for (const c of claims) {
        if (c.type === 'principal_verification' && !nowPolicy.share_verification) fail(409, 'policy_changed');
        if (c.type === 'principal_identity' && !nowPolicy.share_identity_with.includes(aud)) fail(409, 'policy_changed');
        if (c.grant_id) { const g = db.get('SELECT status, version, exp FROM grants WHERE id = ?', c.grant_id); if (g.status !== 'active' || g.version !== c.grant_version || g.exp <= nowSec()) fail(409, 'grant_changed'); }
        if (c.approval_id && db.get('SELECT status FROM approvals WHERE id = ?', c.approval_id).status !== 'approved') fail(409, 'approval_changed');
      }
      const idIdx = allocIndex();
      db.run('INSERT INTO issued (jti, kind, sub, agent_id, principal_id, aud, key_thumb, status_idx, iat, exp, id_mode) VALUES (?,?,?,?,?,?,?,?,?,?,?)', idJti, 'id', sub, agent.id, agent.principal_id, aud, keyThumb, idIdx, iat, exp, mode);
      const out = claims.map((c) => {
        const jti = randomId();
        const idx = allocIndex(); // each revocable claim has its own entry
        db.run('INSERT INTO issued (jti, kind, claim_type, sub, agent_id, principal_id, aud, key_thumb, grant_id, approval_id, status_idx, iat, exp) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', jti, 'claim', c.type, sub, agent.id, agent.principal_id, aud, keyThumb + ':' + jti, c.grant_id ?? null, c.approval_id ?? null, idx, iat, c.exp ?? exp);
        return { ...c, jti, idx };
      });
      return { idIdx, out };
    });
    const statusUri = `${cfg.url}/.well-known/aaf-status`;
    const cnf = { jwk: { kty: pjwk.kty, crv: pjwk.crv, x: pjwk.x } };
    const idJwt = await sign(TYP.id, { iss: cfg.url, sub, aud, iat, exp, jti: idJti, cnf, id_mode: mode, status: { idx: rows.idIdx, uri: statusUri } }, key.privateJwk);
    const claimJwts = [];
    // Each claim names the one issuance it belongs to, so a claim cannot be
    // carried over to a later ID that happens to share a stable identifier.
    for (const c of rows.out) claimJwts.push(await sign(TYP.claim, { iss: cfg.url, sub, id_jti: idJti, aud, iat, exp: c.exp ?? exp, jti: c.jti, attested_by: 'directory', claim: { type: c.type, value: c.value }, status: { idx: c.idx, uri: statusUri } }, key.privateJwk));
    return { id: idJwt, claims: claimJwts, withheld, sub, expires_at: exp };
  });

  // ---------- approvals: the agent relays a counterparty's signed request ----------
  async function counterpartyKeys(cpOrigin) {
    const res = await fetch(`${cpOrigin}/.well-known/aaf-counterparty`, { signal: AbortSignal.timeout(4000) }).catch(() => null);
    if (!res?.ok) fail(502, 'counterparty_keys_unavailable');
    return (await res.json()).jwks?.keys ?? [];
  }
  async function verifyFromCounterparty(token, typ) {
    let iss, kid;
    try { const p = peek(token); iss = new URL(p.payload.iss).origin; kid = p.header.kid; } catch { fail(400, 'invalid_token'); }
    if (cfg.mode !== 'local' && !iss.startsWith('https://')) fail(400, 'counterparty_must_use_https');
    const keys = await counterpartyKeys(iss);
    const jwk = keys.find((k) => k.kid === kid) ?? fail(400, 'counterparty_key_unknown');
    try { return { payload: (await verify(token, jwk, typ)).payload, iss }; } catch { fail(400, 'counterparty_signature_invalid'); }
  }
  app.post('/api/approvals', async (ctx) => {
    const agent = await requireAgent(ctx);
    const { payload: t, iss } = await verifyFromCounterparty(String(ctx.body.ticket ?? ''), TYP.ticket);
    if (t.exp <= nowSec()) fail(409, 'ticket_expired');
    if (t.aud !== cfg.url) fail(400, 'ticket_for_another_directory');
    if (!t.params || typeof t.params !== 'object' || digestOf({ action: t.action, params: t.params }) !== t.action_digest) fail(400, 'ticket_digest_mismatch');
    // The ticket names the ID that asked for it. Only the agent that ID was
    // issued to can relay it, so a copied ticket is useless to another agent.
    if (!db.get("SELECT 1 FROM issued WHERE sub = ? AND agent_id = ? AND kind = 'id' AND aud = ?", String(t.for_id ?? ''), agent.id, iss)) fail(403, 'ticket_not_yours');
    const g = db.get("SELECT * FROM grants WHERE agent_id = ? AND action = ? AND status = 'active' AND exp > ?", agent.id, t.action, nowSec()) ?? fail(409, 'no_active_grant', { action: t.action });
    // An approval cannot enlarge the standing authorization. The amount is
    // read from the signed parameters, the same ones the principal is shown.
    if (typeof t.params.total !== 'number' || t.params.currency !== g.currency) fail(400, 'ticket_amount_missing');
    if (t.params.total > g.max_amount) fail(409, 'exceeds_grant', { max_amount: g.max_amount });
    const ticketDigest = sha256b64u(ctx.body.ticket);
    const existing = db.get('SELECT * FROM approvals WHERE agent_id = ? AND ticket_digest = ?', agent.id, ticketDigest);
    if (existing) return { approval_id: existing.id, status: existing.status, review_url: `${cfg.url}/?approval=${existing.id}` };
    const id = 'ap_' + randomId(12);
    return db.tx(() => {
      const again = db.get('SELECT * FROM approvals WHERE agent_id = ? AND ticket_digest = ?', agent.id, ticketDigest);
      if (again) return { approval_id: again.id, status: again.status, review_url: `${cfg.url}/?approval=${again.id}` };
      db.run('INSERT INTO approvals (id, agent_id, principal_id, counterparty, ticket, ticket_digest, details, grant_id, grant_version, status, exp, created) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', id, agent.id, agent.principal_id, iss, ctx.body.ticket, ticketDigest, JSON.stringify({ action: t.action, params: t.params, summary: t.params, action_digest: t.action_digest }), g.id, g.version, 'pending', Math.min(t.exp, nowSec() + 600), nowSec());
      logEvent('approval.requested', { approval: id, agent: agent.id, counterparty: iss, ticket_digest: ticketDigest });
      return { approval_id: id, status: 'pending', review_url: `${cfg.url}/?approval=${id}` };
    });
  });
  app.get('/api/approvals/:id', async (ctx) => {
    const agent = await requireAgent(ctx, { allowRevoked: true });
    const ap = db.get('SELECT * FROM approvals WHERE id = ? AND agent_id = ?', ctx.params.id, agent.id) ?? fail(404, 'approval_not_found');
    return { status: ap.status === 'pending' && ap.exp <= nowSec() ? 'expired' : ap.status };
  });
  app.get('/api/agent/me', async (ctx) => {
    const agent = await requireAgent(ctx, { allowRevoked: true });
    return { agent_id: agent.id, name: agent.name, status: agent.status, grants: db.all("SELECT action, max_amount, currency, version FROM grants WHERE agent_id = ? AND status = 'active' AND exp > ?", agent.id, nowSec()), grants_url: `${cfg.url}/?agent=${agent.id}` };
  });

  // ---------- incident reports and attribution (ES-1) ----------
  app.post('/api/incidents', async (ctx) => {
    // The report itself is signed by the counterparty and covers the receipt
    // and the note, so nobody who merely holds a receipt can file one.
    const { payload: sub_, iss: reporter } = await verifyFromCounterparty(String(ctx.body.report ?? ''), TYP.incident);
    if (sub_.aud !== cfg.url || Math.abs(nowSec() - sub_.iat) > 300 || typeof sub_.receipt !== 'string') fail(400, 'invalid_report');
    ctx.body = { receipt: sub_.receipt, note: sub_.note };
    const { payload: r, iss } = await verifyFromCounterparty(sub_.receipt, TYP.receipt);
    if (iss !== reporter) fail(400, 'report_and_receipt_issuers_differ');
    if (r.id_issuer !== cfg.url) fail(400, 'receipt_names_another_directory');
    // Only a decision where the presenter proved it held the ID's key can open
    // a case; a copied ID that failed that check must not expose its owner.
    if (r.holder_verified !== true) fail(400, 'receipt_without_holder_verification');
    // And only the counterparty the ID was issued for can report it.
    // Bound to the one issuance the receipt names (a stable per-shop ID is
    // issued many times; each issuance has its own serial).
    const row = db.get("SELECT * FROM issued WHERE jti = ? AND sub = ? AND kind = 'id' AND aud = ?", String(r.id_jti ?? ''), String(r.id ?? ''), iss) ?? fail(404, 'id_not_issued_to_this_counterparty');
    const receiptDigest = sha256b64u(`${iss}|${r.jti}`); // by verified issuer and receipt serial, not raw token bytes
    return db.tx(() => {
      const existing = db.get('SELECT id FROM cases WHERE receipt_digest = ?', receiptDigest);
      if (existing) return { case_ref: existing.id };
      const id = 'case_' + randomId(6);
      db.run('INSERT INTO cases (id, counterparty, receipt, receipt_digest, sub, id_jti, note, status, created) VALUES (?,?,?,?,?,?,?,?,?)', id, iss, ctx.body.receipt, receiptDigest, r.id, row.jti, String(ctx.body.note ?? '').slice(0, 500), 'open', nowSec());
      logEvent('case.opened', { case: id, counterparty: iss, sub: r.id, receipt_digest: receiptDigest });
      notify(row.principal_id, 'incident', `A counterparty (${iss}) reported an incident involving one of your agents. Case ${id}. Your identity has not been released.`);
      return { case_ref: id };
    });
  });

  // ---------- public material (PR-9, DR-1) ----------
  const cors = { 'access-control-allow-origin': '*' };
  app.get('/.well-known/aaf-directory', (ctx) => { ctx.res.setHeader('access-control-allow-origin', '*'); return { issuer: cfg.url, name: cfg.name, jwks: { keys: [key.publicJwk] }, status_list_uri: `${cfg.url}/.well-known/aaf-status`, practices: practices() }; });
  app.get('/.well-known/aaf-status', (ctx) => { ctx.res.writeHead(200, { 'content-type': 'application/jwt', 'cache-control': 'no-store', ...cors }); ctx.res.end(statusJwt); });
  app.get('/healthz', () => ({ ok: true, service: 'directory', status_rev: statusMeta.rev }));

  // ---------- what the page shows ----------
  // Display data only. No session tokens, credential identifiers or key material.
  function view(ctx) {
    const p = session(ctx);
    const base = { surface: 'directory', meta: { name: cfg.name, url: cfg.url, mode: cfg.mode, now: nowSec() }, viewer: { role: p ? (p.is_operator ? 'operator' : 'principal') : 'public', identity: p?.identity_value ?? null }, practices: practices(), status: { rev: statusMeta.rev, published_at: statusMeta.iat, uri: `${cfg.url}/.well-known/aaf-status` }, public: { principals: db.get('SELECT COUNT(*) c FROM principals').c, agents: db.get('SELECT COUNT(*) c FROM agents').c, ids_issued: db.get("SELECT COUNT(*) c FROM issued WHERE kind='id'").c } };
    if (!p) return base;
    const agents = db.all('SELECT * FROM agents WHERE principal_id = ? ORDER BY created DESC', p.id).map((a) => ({ id: a.id, name: a.name, harness: a.harness, fingerprint: a.fingerprint, status: a.status, created: a.created, revoked_at: a.revoked_at, revoked_by: a.revoked_by, policy: JSON.parse(a.policy), ids_issued: db.get("SELECT COUNT(*) c FROM issued WHERE agent_id = ? AND kind='id'", a.id).c, last_issued: db.get("SELECT MAX(iat) t FROM issued WHERE agent_id = ? AND kind='id'", a.id).t, grants: db.all('SELECT id, action, max_amount, currency, version, status, exp, revoked_at FROM grants WHERE agent_id = ? ORDER BY created DESC', a.id) }));
    base.principal = {
      identity: { type: p.identity_type, value: p.identity_value, method: p.method, assurance: p.assurance },
      agents,
      pending_pairings: db.all("SELECT id, user_code, name, harness, fingerprint, exp FROM pairings WHERE status='pending' AND exp > ? ORDER BY created DESC", nowSec()).filter((x) => ctx.query.get('pair') === x.id),
      pending_approvals: db.all("SELECT ap.id, ap.counterparty, ap.details, ap.exp, a.name AS agent_name FROM approvals ap JOIN agents a ON a.id = ap.agent_id WHERE ap.principal_id = ? AND ap.status='pending' AND ap.exp > ? ORDER BY ap.created DESC", p.id, nowSec()).map((x) => ({ id: x.id, counterparty: x.counterparty, agent_name: x.agent_name, exp: x.exp, ...JSON.parse(x.details) })),
      recent_approvals: db.all("SELECT ap.id, ap.counterparty, ap.status, ap.exp, ap.details, ap.decided_at, a.name AS agent_name FROM approvals ap JOIN agents a ON a.id = ap.agent_id WHERE ap.principal_id = ? AND ap.status != 'pending' ORDER BY ap.created DESC LIMIT 10", p.id).map((x) => ({ id: x.id, counterparty: x.counterparty, status: x.status, agent_name: x.agent_name, decided_at: x.decided_at, can_revoke: x.status === 'approved' && x.exp > nowSec(), ...JSON.parse(x.details) })),
      notifications: db.all('SELECT ts, kind, text FROM notifications WHERE principal_id = ? ORDER BY id DESC LIMIT 20', p.id),
    };
    if (p.is_operator) {
      base.operator = {
        principals: db.all('SELECT id, identity_type, identity_value, assurance, is_operator, created FROM principals ORDER BY created DESC').map((x) => ({ ...x, agents: db.get('SELECT COUNT(*) c FROM agents WHERE principal_id = ?', x.id).c })),
        all_agents: db.all('SELECT a.id, a.name, a.status, a.fingerprint, p.identity_value AS principal FROM agents a JOIN principals p ON p.id = a.principal_id ORDER BY a.created DESC'),
        invites: db.all('SELECT email, exp, used_at, created, delivery FROM invites ORDER BY created DESC LIMIT 30'),
        // Links are bearer secrets: they are shown once, by the trusted shell,
        // and never included in the data handed to a design.
        outbox: cfg.mode === 'local' ? db.all('SELECT ts, to_addr, subject FROM outbox ORDER BY id DESC LIMIT 20') : [],
        cases: db.all('SELECT id, counterparty, sub, note, status, created, released_at, basis, disclosure FROM cases ORDER BY created DESC LIMIT 30').map((c) => ({ ...c, disclosure: c.disclosure ? JSON.parse(c.disclosure) : null })),
        events: db.all('SELECT seq, ts, type, data, hash FROM events ORDER BY seq DESC LIMIT 60').map((e) => ({ ...e, data: JSON.parse(e.data) })),
      };
    }
    return base;
  }
  app.get('/api/view', (ctx) => view(ctx));

  mountUi(app, { surface: 'directory', projectRoot: cfg.projectRoot, title: cfg.name, mode: cfg.mode, origin });

  // ---------- start-up ----------
  if (!db.get('SELECT 1 FROM principals WHERE is_operator = 1') && !db.get('SELECT 1 FROM invites WHERE is_operator = 1 AND used_at IS NULL AND exp > ?', nowSec())) {
    const token = randomId(24);
    db.run('INSERT INTO invites (token, email, is_operator, exp, created, delivery) VALUES (?,?,1,?,?,?)', token, cfg.operatorEmail.toLowerCase(), nowSec() + 7 * 86400, nowSec(), 'bootstrap file on the service host');
    fs.writeFileSync(path.join(cfg.dataDir, 'OPERATOR-INVITE.txt'), `${cfg.url}/?invite=${token}\n`, { mode: 0o600 });
  }
  // An invitation left "pending" by a crash during delivery is released. If the
  // message was never sent nobody holds the link; if it was, the recipient does.
  db.run("UPDATE invites SET delivery = ? WHERE delivery = 'pending'", cfg.mode === 'local' ? 'local outbox (stand-in, not real delivery)' : 'email to the asserted mailbox (delivery interrupted by a restart)');
  await publishStatus();
  const timer = setInterval(() => { publishStatus().catch((e) => console.error('[directory] status publish failed', e)); db.run('DELETE FROM used_jti WHERE exp < ?', nowSec()); }, cfg.statusPublishEvery * 1000);
  timer.unref();

  let server = null;
  return {
    app, db, cfg, key, publishStatus, createInvite,
    operatorInviteLink: () => { const f = path.join(cfg.dataDir, 'OPERATOR-INVITE.txt'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : null; },
    async listen() { server = await app.listen(cfg.port, cfg.host); return server; },
    async close() { clearInterval(timer); if (server) await new Promise((r) => { server.closeAllConnections?.(); server.close(r); }); db.close(); },
  };
}
