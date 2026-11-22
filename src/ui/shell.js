// The trusted page shell, shared by the directory and the shop.
// It owns: the Design and Data menus, sign-in, passkey prompts, and every
// privileged action. Skins run in a sandboxed frame and can only ask.
import { startRegistration, startAuthentication } from '/ui/webauthn.js';

const SURFACE = document.body.dataset.surface;
const MODE = document.body.dataset.mode;
const TITLE = document.body.dataset.title;
const params = new URLSearchParams(location.search);
const store = { get: (k, d) => { try { return localStorage.getItem(`aaf-${SURFACE}-${k}`) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(`aaf-${SURFACE}-${k}`, v); } catch { /* private window */ } } };

const state = { catalog: { skins: [], datasets: [] }, skin: params.get('skin') || store.get('skin', 'Console'), source: params.get('data') || 'live', view: null, sample: null, loadedSkinKey: '', frameReady: false, busy: false, status: '' };

// ---------- tiny DOM helper ----------
function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (k === 'class') n.className = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v); }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return n;
}
async function api(method, path, body) {
  const res = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error ?? 'request_failed'), { code: json.error, detail: json, status: res.status });
  return json;
}
const explain = (e) => ({ sign_in_required: 'Please sign in with your passkey first.', passkey_verification_failed: 'The passkey check did not succeed.', ceremony_expired: 'That took too long. Please try again.', grant_changed: 'The authorization changed since this was requested.', approval_not_found_or_expired: 'This request has expired or was already decided.', pairing_not_found_or_expired: 'This registration request has expired or was already decided.', invite_invalid_or_used: 'This invitation link has expired or was already used.', operator_only: 'Only the directory operator can do that.', basis_required: 'Please record the basis for the release (at least 10 characters).', mail_not_configured: 'Email delivery is not configured on this server.', admin_only: 'Shop administrator sign-in is required.', NotAllowedError: 'The passkey prompt was cancelled.' }[e.code ?? e.name] ?? `Something went wrong (${e.code ?? e.name ?? e.message}).`);

// ---------- layout ----------
const skinSelect = el('select', { id: 'skin', onchange: (e) => { state.skin = e.target.value; store.set('skin', state.skin); loadSkin(false); } });
const dataSelect = el('select', { id: 'data', onchange: (e) => { state.source = e.target.value; refreshData(true); } });
const who = el('span', { class: 'who' });
const authBtn = el('button', { class: 'btn', onclick: () => (state.view?.viewer?.role === 'public' ? signIn() : signOut()) });
const badge = el('span', { class: 'badge' });
const toast = el('div', { class: 'toast', hidden: '' });
const frame = el('iframe', { id: 'skin-frame', sandbox: 'allow-scripts', src: '/ui/frame.html', title: 'Design' });
const modalHost = el('div', { class: 'modal-host', hidden: '' });
document.getElementById('app').append(
  el('header', { class: 'bar' },
    el('strong', { class: 'title' }, TITLE), badge, el('span', { class: 'grow' }),
    el('label', {}, 'Design ', skinSelect), el('label', {}, 'Data ', dataSelect),
    SURFACE === 'directory' ? who : null, SURFACE === 'directory' ? authBtn : null),
  frame, toast, modalHost);

let toastTimer;
function say(text, kind = 'info') { toast.textContent = text; toast.className = 'toast ' + kind; toast.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { toast.hidden = true; }, 6000); }

// ---------- trusted dialogs ----------
// Everything a person approves is shown here, by the shell, from the server's
// own description of the operation. Skin code never draws this.
// Each flow (one request from a design, or one deep link) has a number. Work
// that finishes after another flow has started is discarded and draws nothing.
let flow = 0;
function modal(title, body, buttons) {
  modalHost.replaceChildren(el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' }, el('div', { class: 'modal-tag' }, 'Trusted screen · ' + location.host), el('h2', {}, title), body, el('div', { class: 'modal-buttons' }, buttons)));
  modalHost.hidden = false;
}
const closeModal = () => { modalHost.hidden = true; modalHost.replaceChildren(); state.dialogReserved = false; };
const details = (display) => el('div', {}, el('table', { class: 'kv' }, display.lines.map(([k, v]) => el('tr', {}, el('th', {}, k), el('td', {}, v)))), display.warning ? el('p', { class: 'warn' }, display.warning) : null);

// One privileged operation: the server describes it, the person reads that
// description here, and a passkey assertion bound to it is the only way through.
async function confirmOp(op, args, { onDone, declineLabel, onDecline } = {}) {
  const mine = flow;
  state.dialogReserved = true; // held while the server prepares the description
  let started;
  try { started = await api('POST', '/api/confirm/start', { op, args }); } catch (e) { if (mine === flow) { state.dialogReserved = false; say(explain(e), 'error'); } return; }
  if (mine !== flow) return; // another flow started meanwhile; never replace its screen
  const go = el('button', { class: 'btn primary', onclick: async () => {
    go.disabled = true; go.textContent = 'Waiting for your passkey…';
    const shown = modalHost.firstChild; // the screen the person is confirming
    try {
      const response = await startAuthentication({ optionsJSON: started.options });
      if (modalHost.firstChild !== shown) throw Object.assign(new Error('screen_changed'), { code: 'screen_changed' }); // never finish for a screen that is no longer the one shown
      const out = await api('POST', '/api/confirm/finish', { ceremony_id: started.ceremony_id, response });
      closeModal(); say('Done.', 'ok'); await refreshData(true); onDone?.(out);
    } catch (e) { go.disabled = false; go.textContent = 'Confirm with passkey'; say(explain(e), 'error'); }
  } }, 'Confirm with passkey');
  modal(started.display.title, details(started.display), [
    el('button', { class: 'btn', onclick: () => { closeModal(); onDecline?.(); } }, declineLabel ?? 'Cancel'), go]);
}

function formModal(title, intro, fields, submitLabel, onSubmit) {
  const inputs = {};
  const body = el('div', {}, intro ? el('p', {}, intro) : null, fields.map((f) => {
    const input = f.type === 'checkbox' ? el('input', { type: 'checkbox', checked: f.value ? '' : null }) : f.type === 'textarea' ? el('textarea', { rows: 3, placeholder: f.placeholder ?? '' }, f.value ?? '') : el('input', { type: f.type ?? 'text', value: f.value ?? '', placeholder: f.placeholder ?? '' });
    inputs[f.name] = input;
    return el('label', { class: f.type === 'checkbox' ? 'field check' : 'field' }, f.type === 'checkbox' ? [input, ' ' + f.label] : [f.label, input]);
  }));
  modal(title, body, [el('button', { class: 'btn', onclick: closeModal }, 'Cancel'), el('button', { class: 'btn primary', onclick: () => {
    const v = {}; for (const f of fields) v[f.name] = f.type === 'checkbox' ? inputs[f.name].checked : inputs[f.name].value.trim();
    // Moving from the form to its confirmation keeps the dialog reserved, so
    // nothing else can slip in between the two screens.
    closeModal(); state.dialogReserved = true;
    Promise.resolve(onSubmit(v)).finally(() => { if (modalHost.hidden) state.dialogReserved = false; });
  } }, submitLabel)]);
}

// ---------- sign in, enroll ----------
async function signIn() {
  try {
    const o = await api('POST', '/api/auth/options', {});
    const response = await startAuthentication({ optionsJSON: o.options });
    await api('POST', '/api/auth/verify', { ceremony_id: o.ceremony_id, response });
    say('Signed in.', 'ok'); await refreshData(true); return true;
  } catch (e) { say(explain(e), 'error'); return false; }
}
async function signOut() { await api('POST', '/api/auth/signout', {}); await refreshData(true); }
async function enroll(token) {
  let inv;
  try { inv = await api('GET', `/api/invites/${token}`); } catch (e) { say(explain(e), 'error'); return; }
  const go = el('button', { class: 'btn primary', onclick: async () => {
    go.disabled = true;
    try {
      const o = await api('POST', `/api/invites/${token}/options`, {});
      const response = await startRegistration({ optionsJSON: o.options });
      await api('POST', `/api/invites/${token}/verify`, { ceremony_id: o.ceremony_id, response });
      closeModal(); history.replaceState(null, '', location.pathname); say('You are enrolled and signed in.', 'ok'); await refreshData(true);
    } catch (e) { go.disabled = false; say(explain(e), 'error'); }
  } }, 'Create my passkey');
  modal(inv.is_operator ? 'Enroll as directory operator' : 'Enroll as a principal', el('div', {}, el('table', { class: 'kv' }, el('tr', {}, el('th', {}, 'Mailbox'), el('td', {}, inv.email)), el('tr', {}, el('th', {}, 'What this establishes'), el('td', {}, inv.proof_note))), el('p', {}, 'You will create a passkey on this device. It is how you sign in and how you approve anything your agents ask for.')), [go]);
}

// ---------- actions a skin may request ----------
// Browsers want a click before a passkey prompt, so arriving by link while
// signed out shows a button first.
function withSignIn(next) {
  if (state.view?.viewer?.role !== 'public') return next(); // returns the pending work, so the dialog stays reserved until it is shown
  const go = el('button', { class: 'btn primary', onclick: async () => { go.disabled = true; if (await signIn()) { closeModal(); next(); } else go.disabled = false; } }, 'Sign in with passkey');
  modal('Sign in to continue', el('p', {}, 'Sign in with your passkey to continue.'), [el('button', { class: 'btn', onclick: closeModal }, 'Not now'), go]);
}
async function doDecline(id) { try { await api('POST', `/api/approvals/${encodeURIComponent(id)}/decline`, {}); say('Declined.', 'ok'); refreshData(true); } catch (e) { say(explain(e), 'error'); } }
// A skin can only ask. Anything with a consequence waits for a click on a
// button the shell drew.
function askShell(title, text, label, onYes) { modal(title, el('p', {}, text), [el('button', { class: 'btn', onclick: closeModal }, 'Cancel'), el('button', { class: 'btn primary', onclick: () => { closeModal(); onYes(); } }, label)]); }
const DIRECTORY_ACTIONS = {
  signIn: () => withSignIn(() => {}),
  signOut: () => askShell('Sign out?', 'You will need your passkey to sign in again.', 'Sign out', signOut),
  reviewPairing: (id) => reviewPairing(String(id)),
  reviewApproval: (id) => reviewApproval(String(id)),
  declineApproval: (id) => askShell('Decline this request?', 'The agent will be told you said no. Nothing will be done.', 'Decline', () => doDecline(id)),
  grant: (agentId) => formModal('Set an authorization', 'You will confirm the exact terms on the next screen.', [{ name: 'action', label: 'Action', value: 'shop.order' }, { name: 'max_amount', label: 'Limit per action (USD)', type: 'number', value: '100' }, { name: 'days', label: 'Lasts (days)', type: 'number', value: '30' }], 'Continue', (v) => confirmOp('grant_create', { agent_id: String(agentId), action: v.action, max_amount: Number(v.max_amount), days: Number(v.days) })),
  revokeGrant: (id) => confirmOp('grant_revoke', { grant_id: String(id) }),
  revokeApproval: (id) => confirmOp('approval_revoke', { approval_id: String(id) }),
  revokeAgent: (id) => confirmOp('agent_revoke', { agent_id: String(id) }),
  operatorRevokeAgent: (id) => confirmOp('agent_revoke', { agent_id: String(id), as_operator: true }),
  setPolicy: (agentId) => { const a = state.view?.principal?.agents?.find((x) => x.id === agentId); formModal('What may this agent disclose?', null, [{ name: 'share_verification', label: 'Share how I was verified when a service asks', type: 'checkbox', value: a?.policy?.share_verification !== false }, { name: 'share_identity_with', label: 'Share my verified email only with these services (one address per line, leave empty for never)', type: 'textarea', value: (a?.policy?.share_identity_with ?? []).join('\n') }], 'Continue', (v) => confirmOp('policy_set', { agent_id: String(agentId), policy: { share_verification: v.share_verification, share_identity_with: v.share_identity_with.split(/\s+/).filter(Boolean) } })); },
  invite: () => formModal('Invite a principal', 'A single-use link goes to this mailbox only.', [{ name: 'email', label: 'Email address', type: 'email', placeholder: 'name@example.org' }], 'Continue', (v) => confirmOp('invite_create', { email: v.email }, { onDone: (out) => { if (out.link) modal('Invitation created', el('div', {}, el('p', { class: 'warn' }, 'LOCAL STAND-IN: on this local build the link is shown here instead of being emailed. On the hosted build it is only ever sent to the mailbox.'), el('input', { class: 'copy', readonly: '', value: out.link, onclick: (e) => e.target.select() })), [el('button', { class: 'btn primary', onclick: closeModal }, 'Close')]); } })),
  releaseCase: (id) => formModal('Release identity for a case', 'SIMULATED authority request. Record the basis for this release. You will confirm on the next screen.', [{ name: 'basis', label: 'Basis', type: 'textarea', placeholder: 'e.g. Simulated lawful request 2026-PILOT-1 covering this receipt' }], 'Continue', (v) => confirmOp('case_release', { case_id: String(id), basis: v.basis })),
};
const SHOP_ACTIONS = {
  reportIncident: async (seq) => {
    // The decision is looked up by the shell itself and shown here, so a
    // design cannot show one decision and report another.
    const d = (await api('GET', '/api/view')).decisions?.find((x) => x.seq === Number(seq));
    if (!d || !d.can_report) { say('That decision cannot be reported.', 'error'); return; }
    formModal('Report an incident to the directory', `You are reporting decision #${d.seq}: ${d.action}${d.params?.sku ? ` · ${d.params.sku} × ${d.params.qty} · ${d.params.currency ?? ''} ${d.params.total ?? ''}` : ''} · ${d.decision} at ${new Date(d.ts * 1000).toLocaleString()} · ID ${String(d.id).slice(0, 14)}… · receipt ${d.receipt_ref}. The shop sends its signed receipt for this decision to the directory that issued the ID, and gets a case reference back, not an identity. The principal is notified.`, [{ name: 'note', label: 'What happened', type: 'textarea', placeholder: 'e.g. Order placed and then disputed' }], 'Send report', async (v) => { try { const out = await api('POST', '/api/admin/incidents', { seq: Number(seq), note: v.note }); say(`Reported. Case reference ${out.case_ref}.`, 'ok'); refreshData(true); } catch (e) { say(explain(e), 'error'); } });
  },
  adminSignIn: () => formModal('Shop administrator', null, [{ name: 'token', label: 'Admin token', type: 'password' }], 'Sign in', async (v) => { try { await api('POST', '/api/admin/signin', { token: v.token }); refreshData(true); } catch (e) { say(explain(e), 'error'); } }),
};
const ACTIONS = SURFACE === 'directory' ? DIRECTORY_ACTIONS : SHOP_ACTIONS;

function reviewPairing(id) { return withSignIn(() => showPairing(id)); }
async function showPairing(id) {
  const p = (await api('GET', `/api/view?pair=${encodeURIComponent(id)}`)).principal?.pending_pairings?.[0];
  if (!p) { say('This registration request has expired or was already decided.', 'error'); return; }
  formModal('An agent asks to be registered as yours', `Agent "${p.name}" · code ${p.user_code} · key fingerprint ${p.fingerprint}. Check that the code and fingerprint match what the agent shows on your computer. Choose its starting terms; you will confirm the exact terms on the next screen.`, [
    { name: 'grant', label: 'Allow it to place shop orders', type: 'checkbox', value: true },
    { name: 'max_amount', label: 'Limit per order (USD)', type: 'number', value: '500' },
    { name: 'share_verification', label: 'Share how I was verified when a service asks', type: 'checkbox', value: true },
  ], 'Continue', (v) => confirmOp('pair_approve', { pairing_id: id, grant: v.grant ? { action: 'shop.order', max_amount: Number(v.max_amount), days: 30 } : null, policy: { share_verification: v.share_verification, share_identity_with: [] } }, { onDone: () => history.replaceState(null, '', location.pathname) }));
}
function reviewApproval(id) {
  return withSignIn(() => confirmOp('approval_approve', { approval_id: id }, { declineLabel: 'Decline', onDecline: () => doDecline(id), onDone: () => { history.replaceState(null, '', location.pathname); modal('Approved', el('p', {}, 'Go back to your agent and tell it to continue.'), [el('button', { class: 'btn primary', onclick: closeModal }, 'Close')]); } }));
}

// ---------- the sandboxed frame ----------
window.addEventListener('message', (e) => {
  // Only the one frame this page created. Its origin is opaque ("null") by design.
  if (e.source !== frame.contentWindow) return;
  const m = e.data;
  if (!m || typeof m !== 'object') return;
  if (m.aaf === 'ready') { state.frameReady = true; state.loadedSkinKey = ''; loadSkin(false); pushProps(); return; }
  if (m.aaf === 'skin-error') { say(`Design "${state.skin}" has a problem: ${String(m.message).slice(0, 200)}`, 'error'); return; }
  if (m.aaf !== 'action' || typeof m.name !== 'string') return;
  if (m.name === 'selectSkin' || m.name === 'selectData') return; // menus belong to the shell
  const fn = Object.hasOwn(ACTIONS, m.name) ? ACTIONS[m.name] : null;
  if (!fn) { say(`This design asked for something the page does not offer (${m.name.slice(0, 40)}).`, 'error'); return; }
  if (state.source !== 'live') { say('Sample data is showing. Switch Data to "Live" to act.', 'info'); return; }
  // A trusted screen that is open, or about to open, is never replaced or
  // dismissed by a skin. The slot is taken before any network call is made.
  if (!modalHost.hidden || state.dialogReserved) return;
  state.dialogReserved = true; flow++;
  const args = Array.isArray(m.args) ? m.args.slice(0, 1).map((a) => (typeof a === 'string' || typeof a === 'number' ? a : undefined)) : [];
  // Held from the request until the trusted screen it leads to is dismissed.
  // It is released early only if the request ended without showing one.
  Promise.resolve().then(() => fn(...args)).catch((err) => say(explain(err), 'error')).finally(() => { if (modalHost.hidden) state.dialogReserved = false; });
});
function pushProps() {
  if (!state.frameReady) return;
  const data = state.source === 'live' ? state.view : state.sample;
  if (!data) return;
  frame.contentWindow.postMessage({ aaf: 'props', props: { data, viewer: data.viewer ?? { role: 'public' }, source: { kind: state.source === 'live' ? 'live' : 'sample', name: state.source }, isBusy: state.busy, statusText: state.status } }, '*');
}
function loadSkin(force = false) {
  if (!state.frameReady) return;
  const entry = state.catalog.skins.find((s) => s.name === state.skin) ?? state.catalog.skins.find((s) => s.name === 'Console') ?? state.catalog.skins[0];
  if (!entry) return;
  if (entry.name !== state.skin) { state.skin = entry.name; skinSelect.value = entry.name; }
  const key = `${entry.name}@${entry.mtime}`;
  if (!force && key === state.loadedSkinKey) return;
  if (state.loadedSkinKey && state.loadedSkinKey !== key) {
    // Switching or reloading a design starts from a brand-new frame, so no
    // code from the previous design keeps running.
    state.frameReady = false; state.loadedSkinKey = '';
    frame.src = `/ui/frame.html?t=${Date.now()}`;
    return; // the new frame announces "ready", which loads the design
  }
  state.loadedSkinKey = key;
  frame.contentWindow.postMessage({ aaf: 'skin', url: `${location.origin}/ui/skins/${entry.name}.js?v=${entry.mtime}`, key }, '*');
}

// ---------- data and catalog polling ----------
function fillSelect(select, options, value) {
  const sig = options.map((o) => o.value).join('|');
  if (select.dataset.sig !== sig) { select.replaceChildren(...options.map((o) => el('option', { value: o.value }, o.label))); select.dataset.sig = sig; }
  select.value = value;
}
async function refreshCatalog() {
  try {
    const before = new Set(state.catalog.skins.map((s) => s.name));
    state.catalog = await api('GET', '/api/ui/catalog');
    const fresh = state.catalog.skins.filter((s) => before.size && !before.has(s.name));
    if (fresh.length) say(`New design available: ${fresh.map((s) => s.name).join(', ')}`, 'ok');
    fillSelect(skinSelect, state.catalog.skins.map((s) => ({ value: s.name, label: s.name })), state.skin);
    fillSelect(dataSelect, [{ value: 'live', label: 'Live' }, ...state.catalog.datasets.map((d) => ({ value: d.name, label: 'Sample: ' + d.name.replace(/[-_]/g, ' ') }))], state.source);
    loadSkin(false); // reloads the current design if its file changed
  } catch { /* server restarting; try again next tick */ }
}
async function refreshData(force = false) {
  try {
    const q = params.get('pair') ? `?pair=${encodeURIComponent(params.get('pair'))}` : '';
    state.view = await api('GET', '/api/view' + q);
    if (state.source !== 'live') { const d = state.catalog.datasets.find((x) => x.name === state.source); if (!d) state.source = 'live'; else if (force || state.sampleKey !== `${d.name}@${d.mtime}`) { state.sample = await api('GET', `/api/ui/datasets/${d.name}`); state.sampleKey = `${d.name}@${d.mtime}`; } }
    const v = state.view.viewer ?? {};
    who.textContent = v.role === 'public' ? '' : `${v.identity} (${v.role})`;
    authBtn.textContent = v.role === 'public' ? 'Sign in with passkey' : 'Sign out';
    badge.textContent = state.source !== 'live' ? 'SAMPLE DATA · not live' : MODE === 'local' ? 'LOCAL BUILD · stand-ins active' : 'PILOT';
    badge.className = 'badge ' + (state.source !== 'live' ? 'sample' : MODE === 'local' ? 'local' : 'pilot');
    dataSelect.value = state.source;
    pushProps();
  } catch { /* try again next tick */ }
}

// ---------- start ----------
await refreshCatalog();
await refreshData(true);
setInterval(refreshCatalog, 3000);
setInterval(() => refreshData(false), 2000);
if (SURFACE === 'directory') {
  flow++;
  if (params.get('invite')) enroll(params.get('invite'));
  else if (params.get('pair')) reviewPairing(params.get('pair'));
  else if (params.get('approval')) reviewApproval(params.get('approval'));
}
