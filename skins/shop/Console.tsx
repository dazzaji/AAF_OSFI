// Console: the shop's working view. What each agent presented, what the shop
// checked, what it decided and why.
import React from 'react';
import type { SkinProps, ShopData, Decision } from '../SkinContract';

const time = (t: number) => new Date(t * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); // the same format the page shell uses
const TONE: Record<string, string> = { granted: 'bg-green-100 text-green-800 border-green-300', denied: 'bg-red-100 text-red-800 border-red-300', step_up: 'bg-amber-100 text-amber-800 border-amber-300', deferred: 'bg-slate-200 text-slate-700 border-slate-300' };
const LABEL: Record<string, string> = { granted: 'Granted', denied: 'Denied', step_up: 'Asked for more', deferred: 'Deferred' };
const REASON: Record<string, string> = {
  valid_id: 'A valid accountable ID is enough for this.', authorized: 'Authorization covers the amount.', authorized_and_approved: 'Authorization covers it and the principal approved this exact order.',
  presentation_required: 'No ID was presented.', claim_required: 'More claims are needed for this level of access.', approval_required: "This needs the principal's approval of the exact order.",
  authorization_insufficient: 'The authorization does not cover this amount.', id_revoked: 'The ID has been revoked.', id_expired: 'The ID has expired.', untrusted_issuer: 'The ID comes from a directory this shop does not trust.',
  id_signature_invalid: 'The ID is not signed by the directory it names.', holder_binding_failed: 'The presenter does not hold the key this ID is bound to.', nonce_invalid_or_replayed: 'This request was already used (replay).',
  proof_body_mismatch: 'The request was changed after it was signed.', wrong_audience: 'This ID was issued for a different service.', status_too_old: 'Revocation status is too old to rely on. Nothing was done.', status_unavailable: 'Revocation status is not available. Nothing was done.',
  approval_for_a_different_action: 'The approval presented is for a different order.',
};

function Row({ d, actions }: { d: Decision; actions: SkinProps['actions'] }) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`text-xs font-bold px-2 py-0.5 rounded-full border ${TONE[d.decision]}`}>{LABEL[d.decision]}</span>
        <strong>{d.action}</strong>
        {d.params && <span className="text-sm text-slate-600">{d.params.sku} × {d.params.qty}{d.params.total ? ` · ${d.params.currency} ${d.params.total}` : ''}{d.action.endsWith('order') ? ' · fictional order, no charge' : d.action.endsWith('quote') ? ' · fictional quote' : ''}</span>}
        <span className="flex-1" />
        <span className="text-xs text-slate-400">#{d.seq} · {time(d.ts)}</span>
      </div>
      <p className="text-sm mt-1">{REASON[d.reason] ?? d.reason}</p>
      <div className="grid md:grid-cols-2 gap-3 mt-3 text-sm">
        <div><div className="text-xs font-semibold uppercase text-slate-500 mb-1">What the shop learned</div><ul className="list-disc ml-5 space-y-0.5">{d.learned.map((l, i) => <li key={i}>{l}</li>)}{d.learned.length === 0 && <li className="text-slate-400 list-none -ml-5">Nothing.</li>}</ul></div>
        <div><div className="text-xs font-semibold uppercase text-slate-500 mb-1">What it did not learn</div><ul className="list-disc ml-5 space-y-0.5 text-slate-600">{d.not_learned.map((l, i) => <li key={i}>{l}</li>)}</ul></div>
      </div>
      <div className="flex items-center gap-3 mt-3 text-xs text-slate-500 flex-wrap">
        {d.id && <span>ID <code>{d.id.slice(0, 14)}…</code></span>}
        {d.status_rev !== null && <span>status list rev {d.status_rev}, {d.status_age}s old when checked</span>}
        {d.receipt_ref && <span>signed receipt {d.receipt_ref}</span>}
        {d.result?.order_id && <span>order {d.result.order_id}</span>}
        <span className="flex-1" />
        {d.case_ref && <span className="font-semibold text-slate-700">Reported: {d.case_ref}</span>}
        {d.can_report && <button onClick={() => actions.reportIncident(d.seq)} className="px-2 py-1 border border-slate-300 rounded-lg hover:bg-slate-50 text-slate-700">Report incident</button>}
      </div>
    </div>
  );
}

export default function Console({ data, source, actions }: SkinProps<ShopData>) {
  return (
    <div className="max-w-5xl mx-auto p-5 space-y-4">
      <header>
        <h1 className="text-2xl font-bold">{data.meta.name}</h1>
        <p className="text-sm text-slate-500">A sandbox counterparty. Every quote and order is fictional and nothing is charged. It decides from what an agent presents and from what each trusted directory publishes; it never asks a directory about a particular ID.</p>
      </header>
      <div className="grid md:grid-cols-2 gap-4">
        <section className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500 mb-2">Levels of access</h2>
          <table className="w-full text-sm"><tbody>{data.levels.map((l) => <tr key={l.level} className="border-t border-slate-100 align-top"><td className="py-1.5 pr-2 font-semibold">{l.level}</td><td className="pr-2">{l.example}</td><td className="text-slate-600">{l.requires}</td></tr>)}</tbody></table>
        </section>
        <section className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500 mb-2">Directories this shop trusts</h2>
          {data.trust.map((t) => (
            <div key={t.issuer} className="text-sm">
              <div className="font-semibold">{t.name ?? t.issuer}</div>
              <div className="text-slate-500 break-all">{t.issuer}</div>
              <div className={t.fresh ? 'text-green-700' : 'text-red-700'}>{t.status_rev === null ? 'No status list yet' : `Status list revision ${t.status_rev}, ${t.status_age}s old (limit ${t.max_age}s)`}{t.fresh ? '' : ' · too old: writes are deferred'}</div>
              {t.error && <div className="text-xs text-red-700">Last fetch: {t.error}</div>}
            </div>
          ))}
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500 mt-4 mb-1">Catalog</h2>
          <ul className="text-sm">{data.catalog.map((c) => <li key={c.sku}><code>{c.sku}</code> · {c.name} · {data.currency} {c.price}</li>)}</ul>
        </section>
      </div>
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500 pt-2">Decisions, newest first</h2>
      {data.feed_hidden && <p className="text-sm text-slate-500">The decision feed is visible to the shop administrator. <button className="underline" onClick={() => actions.adminSignIn()}>Sign in</button></p>}
      {data.decisions.length === 0 && !data.feed_hidden && <p className="text-sm text-slate-500">No agent has asked for anything yet.</p>}
      <div className="space-y-3">{data.decisions.map((d) => <Row key={d.seq} d={d} actions={actions} />)}</div>
      {source.kind === 'sample' && <p className="text-center text-xs text-red-700 font-semibold">Showing sample data “{source.name}”. Buttons are inactive.</p>}
    </div>
  );
}
