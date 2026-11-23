// Story: a front-desk view. Four steps of access as a staircase, the latest
// request told as a three-part story, then earlier requests as a short timeline.
import React from 'react';
import type { SkinProps, ShopData, Decision } from '../SkinContract';

const LABEL: Record<string, string> = { granted: 'Granted', denied: 'Denied', step_up: 'Asked for more', deferred: 'Held back' };
const PILL: Record<string, string> = { granted: 'bg-green-100 text-green-800 border-green-300', denied: 'bg-red-100 text-red-800 border-red-300', step_up: 'bg-amber-100 text-amber-800 border-amber-300', deferred: 'bg-slate-200 text-slate-700 border-slate-300' };
const DOT: Record<string, string> = { granted: 'bg-green-500', denied: 'bg-red-500', step_up: 'bg-amber-500', deferred: 'bg-slate-400' };
const WHY: Record<string, string> = {
  valid_id: 'A valid accountable ID is enough for this.', authorized: 'Authorization covers the amount.', authorized_and_approved: 'Authorization covers it and the principal approved this exact order.',
  presentation_required: 'No ID was presented.', claim_required: 'More claims are needed for this level of access.', approval_required: "This needs the principal's approval of the exact order.",
  authorization_insufficient: 'The authorization does not cover this amount.', id_revoked: 'The ID has been revoked.', id_expired: 'The ID has expired.', untrusted_issuer: 'The ID comes from a directory this shop does not trust.',
  id_signature_invalid: 'The ID is not signed by the directory it names.', holder_binding_failed: 'The presenter does not hold the key this ID is bound to.', nonce_invalid_or_replayed: 'This request was already used (replay).',
  proof_body_mismatch: 'The request was changed after it was signed.', wrong_audience: 'This ID was issued for a different service.', status_too_old: 'Revocation status is too old to rely on. Nothing was done.', status_unavailable: 'Revocation status is not available. Nothing was done.',
  approval_for_a_different_action: 'The approval presented is for a different order.',
};
const VERB: Record<string, string> = { granted: 'said yes', denied: 'said no', step_up: 'asked for more before going ahead', deferred: 'held off and did nothing' };
const BY: Record<string, string> = { directory: 'the directory', self: 'the agent itself', other: 'another party', unknown: 'an unknown party' };
const CLAIM: Record<string, string> = { authorization: 'Authorization to spend', principal_verification: 'The person behind the agent was verified', approval: "The person's approval of this exact order" };

const levelOf = (d: Decision) => (d.action.endsWith('order') ? (Number(d.params?.total) > 50 ? 3 : 2) : d.action.endsWith('quote') || d.action.endsWith('check') ? 1 : 0);
const clock = (t: number) => new Date(t * 1000).toLocaleTimeString();
const what = (d: Decision) => (d.params?.sku ? `${d.action.replace('shop.', '')} ${d.params.sku}` : d.action.replace('shop.', ''));
const short = (d: Decision) => (d.decision === 'denied' ? `Denied (${(WHY[d.reason] ?? d.reason).replace(/\.$/, '').toLowerCase()})` : LABEL[d.decision]);

function Step({ lv, ds }: { lv: ShopData['levels'][number]; ds: Decision[] }) {
  const n = (k: string) => ds.filter((d) => d.decision === k).length;
  const pad = ['sm:ml-0', 'sm:ml-5', 'sm:ml-10', 'sm:ml-14'][lv.level] ?? 'sm:ml-0';
  return (
    <div className={`${pad} bg-white border border-slate-200 rounded-xl p-3 shadow-sm flex gap-3 items-start`}>
      <div className="w-9 h-9 rounded-full bg-indigo-600 text-white font-bold flex items-center justify-center shrink-0">{lv.level}</div>
      <div className="flex-1 min-w-0">
        <div className="font-semibold">{lv.example}</div>
        <div className="text-xs text-slate-500">Needs: {lv.requires}</div>
        <div className="flex gap-1.5 flex-wrap mt-1.5 text-xs">
          <span className="text-slate-500">{ds.length} request{ds.length === 1 ? '' : 's'} reached here</span>
          {n('granted') > 0 && <span className="px-1.5 rounded bg-green-100 text-green-800">{n('granted')} granted</span>}
          {n('step_up') > 0 && <span className="px-1.5 rounded bg-amber-100 text-amber-800">{n('step_up')} asked for more</span>}
          {n('denied') > 0 && <span className="px-1.5 rounded bg-red-100 text-red-800">{n('denied')} denied</span>}
          {n('deferred') > 0 && <span className="px-1.5 rounded bg-slate-200 text-slate-700">{n('deferred')} held</span>}
        </div>
      </div>
    </div>
  );
}

function Part({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="bg-slate-50 border border-slate-200 rounded-xl p-4">
      <div className="text-xs font-bold uppercase tracking-wide text-indigo-700 mb-2">{n}. {title}</div>
      <div className="text-sm space-y-1.5">{children}</div>
    </div>
  );
}

function Latest({ d, actions, sample }: { d: Decision; actions: SkinProps['actions']; sample: boolean }) {
  return (
    <section className="bg-white border-2 border-indigo-200 rounded-2xl p-5 shadow-md">
      <div className="flex items-center gap-3 flex-wrap mb-3">
        <h2 className="text-lg font-bold">Most recent request</h2>
        <span className={`text-sm font-bold px-3 py-0.5 rounded-full border ${PILL[d.decision]}`}>{LABEL[d.decision]}</span>
        <span className="text-sm text-slate-600">{what(d)}{d.params?.total ? ` · ${d.params.currency} ${d.params.total}` : ''}</span>
        <span className="flex-1" />
        <span className="text-xs text-slate-400">#{d.seq} · {clock(d.ts)}</span>
      </div>
      <div className="grid md:grid-cols-3 gap-3">
        <Part n={1} title="The agent showed">
          {d.learned.length === 0 ? <p className="text-slate-500">Nothing. No ID was presented.</p> : d.learned.map((l, i) => <p key={i}>{l}</p>)}
        </Part>
        <Part n={2} title="The shop checked">
          {d.issuer ? <p>{d.issuer ? 'Issuer is on the shop’s trusted list.' : ''} <span className="text-slate-500">{d.issuer}</span></p> : <p className="text-slate-500">No issuer to check.</p>}
          {d.id && <p>Signature and holder binding checked for ID <code>{d.id.slice(0, 12)}…</code></p>}
          {d.status_rev !== null && <p>Revocation list revision {d.status_rev}, {d.status_age}s old when checked.</p>}
          {d.claims.length === 0 ? <p className="text-slate-500">No claims were attached.</p> : d.claims.map((c, i) => (
            <p key={i} className="flex gap-1.5"><span className={c.accepted ? 'text-green-700 font-bold' : 'text-red-700 font-bold'}>{c.accepted ? '✓' : '✗'}</span><span>{CLAIM[c.type] ?? c.type}, attested by {BY[c.attested_by] ?? c.attested_by}{c.accepted ? '' : ` (not accepted: ${(c.reason ?? 'unknown').replace(/_/g, ' ')})`}</span></p>
          ))}
        </Part>
        <Part n={3} title="So the shop">
          <p className="font-semibold">{VERB[d.decision] ?? d.decision}.</p>
          <p>{WHY[d.reason] ?? d.reason}</p>
          <div className="pt-1 text-xs font-semibold uppercase text-slate-500">It did not learn</div>
          <ul className="list-disc ml-5 text-slate-600">{d.not_learned.map((l, i) => <li key={i}>{l}</li>)}</ul>
        </Part>
      </div>
      <div className="flex items-center gap-3 mt-3 flex-wrap text-xs text-slate-500">
        {d.receipt_ref && <span>Signed receipt {d.receipt_ref}</span>}
        <span className="flex-1" />
        {d.case_ref && <span className="font-semibold text-slate-700">Reported: {d.case_ref}</span>}
        {d.can_report && <button onClick={() => actions.reportIncident(d.seq)} disabled={sample} className="px-3 py-1.5 border border-slate-300 rounded-lg bg-white hover:bg-slate-50 text-slate-700 disabled:opacity-50">Report incident</button>}
      </div>
    </section>
  );
}

export default function Story({ data, source, actions }: SkinProps<ShopData>) {
  const ds = data.decisions ?? [];
  const latest = ds[0];
  const older = ds.slice(1).reverse();
  const sample = source.kind === 'sample';
  return (
    <div className="max-w-5xl mx-auto p-5 space-y-5 bg-white min-h-screen text-slate-900">
      <header className="flex items-end gap-3 flex-wrap">
        <div><h1 className="text-2xl font-bold">{data.meta.name}</h1><p className="text-sm text-slate-500">The front desk. Every request an AI agent makes, and exactly why the shop answered as it did.</p></div>
      </header>
      {data.trust.map((t) => (
        <div key={t.issuer} className={`rounded-xl border-2 p-3 flex items-center gap-3 flex-wrap ${t.fresh ? 'bg-green-50 border-green-300 text-green-900' : 'bg-red-50 border-red-400 text-red-900'}`}>
          <span className="text-xl">{t.fresh ? '✓' : '⚠'}</span>
          <div className="flex-1 min-w-0">
            <div className="font-semibold">{t.fresh ? 'Trusted directory is up to date' : 'Warning: trusted directory data is too old'} · {t.name ?? t.issuer}</div>
            <div className="text-sm">{t.status_rev === null ? 'No revocation list received yet.' : `Revocation list revision ${t.status_rev}, ${t.status_age}s old (limit ${t.max_age}s).`}{t.fresh ? '' : ' The shop will not complete orders until it is refreshed.'}</div>
            {t.error && <div className="text-xs">Last fetch: {t.error}</div>}
          </div>
        </div>
      ))}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500 mb-2">Four steps of access</h2>
        <div className="space-y-2">{data.levels.map((lv) => <Step key={lv.level} lv={lv} ds={ds.filter((d) => levelOf(d) === lv.level)} />)}</div>
      </section>
      {data.feed_hidden && <p className="text-sm text-slate-600 bg-slate-50 border border-slate-200 rounded-xl p-3">The request history is visible to the shop administrator. <button className="underline text-indigo-700" onClick={() => actions.adminSignIn()}>Sign in</button></p>}
      {!data.feed_hidden && !latest && <p className="text-sm text-slate-500">No agent has asked for anything yet.</p>}
      {latest && <Latest d={latest} actions={actions} sample={sample} />}
      {older.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500 mb-2">Earlier, oldest first</h2>
          <ol className="relative border-l-2 border-slate-200 ml-2 space-y-2">
            {older.map((d) => (
              <li key={d.seq} className="ml-4 relative">
                <span className={`absolute -left-[23px] top-1.5 w-3 h-3 rounded-full ${DOT[d.decision] ?? 'bg-slate-400'}`} />
                <div className="text-sm"><span className="font-semibold">{short(d)}</span> <span className="text-slate-500">· {what(d)}{d.params?.total ? ` · ${d.params.currency} ${d.params.total}` : ''} · #{d.seq} {clock(d.ts)}</span></div>
                <div className="text-xs text-slate-500">{WHY[d.reason] ?? d.reason}</div>
              </li>
            ))}
          </ol>
          <p className="text-xs text-slate-500 mt-2">Story so far: {older.map(short).join(' → ')}{latest ? ` → ${short(latest)}` : ''}</p>
        </section>
      )}
      {sample && <p className="text-center text-xs text-slate-500">Sample data “{source.name}”. Buttons are inactive.</p>}
    </div>
  );
}
