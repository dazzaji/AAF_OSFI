// Story: a guided, narrated walk through the agent lifecycle as a vertical timeline.
import React from 'react';
import type { SkinProps, DirectoryData } from '../SkinContract';

type State = 'done' | 'current' | 'todo';
const time = (t?: number | null) => (t ? new Date(t * 1000).toLocaleString() : 'n/a');
const Btn = ({ onClick, children, danger = false, primary = false }: { onClick: () => void; children: React.ReactNode; danger?: boolean; primary?: boolean }) => (
  <button onClick={onClick} className={`text-sm px-3 py-1.5 rounded-lg border ${primary ? 'bg-indigo-700 border-indigo-700 text-white font-semibold hover:bg-indigo-800' : danger ? 'border-red-300 text-red-700 hover:bg-red-50' : 'border-stone-300 hover:bg-stone-50'}`}>{children}</button>
);
const Pill = ({ ok, children }: { ok: boolean; children: React.ReactNode }) => <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${ok ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>{children}</span>;

function Stage({ n, state, title, story, last = false, children }: { n: number; state: State; title: string; story: string; last?: boolean; children?: React.ReactNode }) {
  const dot = state === 'done' ? 'bg-green-600 text-white' : state === 'current' ? 'bg-indigo-700 text-white ring-4 ring-indigo-200' : 'bg-stone-200 text-stone-500';
  const label = state === 'done' ? 'Done' : state === 'current' ? 'You are here' : 'Not reached yet';
  const labelCls = state === 'done' ? 'text-green-700' : state === 'current' ? 'text-indigo-700' : 'text-stone-400';
  return (
    <div className="flex gap-4">
      <div className="flex flex-col items-center">
        <div className={`w-9 h-9 rounded-full flex items-center justify-center font-bold shrink-0 ${dot}`}>{state === 'done' ? '✓' : n}</div>
        {!last && <div className="w-0.5 flex-1 bg-stone-300 my-1" />}
      </div>
      <div className={`flex-1 pb-8 ${state === 'todo' ? 'opacity-70' : ''}`}>
        <div className="flex items-baseline gap-3 flex-wrap"><h2 className="text-lg font-semibold">{title}</h2><span className={`text-xs font-semibold uppercase tracking-wide ${labelCls}`}>{label}</span></div>
        <p className="text-sm text-stone-600 mt-1 mb-3 max-w-2xl">{story}</p>
        {children}
      </div>
    </div>
  );
}

export default function Story({ data, viewer, source, actions }: SkinProps<DirectoryData>) {
  const p = data.principal; const op = data.operator; const pr = data.practices ?? {};
  const agents = p?.agents ?? []; const pairings = p?.pending_pairings ?? []; const approvals = p?.pending_approvals ?? [];
  const notes = p?.notifications ?? []; const cases = op?.cases ?? [];
  const active = agents.filter((a) => a.status === 'active');
  const hasGrant = active.some((a) => a.grants.some((g) => g.status === 'active'));
  const revoked = agents.some((a) => a.status === 'revoked');
  const waiting = pairings.length + approvals.length;
  const proof = pr.identity_proofing?.[0];
  const standIn = !!p && /stand-in|simulated|none/i.test(`${p.identity.method} ${p.identity.assurance}`);
  const s2: State = agents.length > 0 ? 'done' : 'current';
  const s3: State = hasGrant ? 'done' : active.length > 0 ? 'current' : 'todo';
  const s4: State = waiting > 0 ? 'current' : agents.length > 0 ? 'done' : 'todo';
  const s5: State = revoked ? 'done' : active.length > 0 ? 'current' : 'todo';
  const s6: State = cases.some((c) => c.status === 'open') ? 'current' : notes.length > 0 || cases.length > 0 ? 'done' : 'todo';

  return (
    <div className="min-h-screen bg-stone-50 text-stone-900">
      <div className="max-w-3xl mx-auto p-6">
        <header className="mb-6">
          <h1 className="text-3xl font-bold">{data.meta.name}</h1>
          <p className="text-stone-600 mt-1">Follow one AI agent from first introduction to accountability. {pr.kind}</p>
          {source.kind === 'sample' && <p className="mt-2 text-xs font-semibold text-red-700">Showing sample data “{source.name}”. Buttons are inactive.</p>}
        </header>

        {viewer.role === 'public' || !p ? (
          <section className="bg-white border border-stone-200 rounded-xl p-5 mb-8 shadow-sm">
            <h2 className="text-lg font-semibold mb-1">Welcome</h2>
            <p className="text-sm text-stone-600 mb-3 max-w-2xl">This directory checks who you are, registers the AI agents that act for you, and records exactly what each one is allowed to do. Sign in with your passkey to see your own story. New here? You need an invitation link from the operator first.</p>
            <Btn primary onClick={() => actions.signIn()}>Sign in with passkey</Btn>
          </section>
        ) : (
          <div>
            <Stage n={1} state="done" title="You are verified" story="The directory knows which person stands behind your agents. Counterparties never see this unless you choose to share it.">
              <p className="text-sm bg-white border border-stone-200 rounded-lg p-3"><strong>{p.identity.value}</strong> ({p.identity.type}). Method: {p.identity.method}. Assurance: <strong>{p.identity.assurance}</strong>.{standIn && <span className="block mt-1 text-amber-800 font-semibold">Local stand-in: this is a demonstration, not real identity proofing.</span>}</p>
            </Stage>

            <Stage n={2} state={s2} title="Your agent is registered" story="Registering ties an agent's secret key to you. The directory stores only the key's fingerprint, and you approved it with your passkey.">
              {agents.length === 0 && <p className="text-sm text-stone-500">No agent yet. In Claude Code or Codex, ask your agent to register with this directory. It will send you back here.</p>}
              {agents.map((a) => (
                <div key={a.id} className="bg-white border border-stone-200 rounded-lg p-3 mb-2 text-sm flex items-center gap-2 flex-wrap">
                  <strong>{a.name}</strong><Pill ok={a.status === 'active'}>{a.status === 'active' ? 'registered' : `revoked by ${a.revoked_by ?? 'principal'}`}</Pill>
                  <span className="text-stone-500">key {a.fingerprint} · registered {time(a.created)} · {a.ids_issued} IDs issued</span>
                  <span className="flex-1" />{a.status === 'active' && <Btn onClick={() => actions.setPolicy(a.id)}>What it may disclose</Btn>}
                </div>
              ))}
            </Stage>

            <Stage n={3} state={s3} title="What it may do" story="An authorization is a spending limit for one kind of action. Without one, the agent can identify itself and nothing more.">
              {agents.length === 0 && <p className="text-sm text-stone-500">Nothing to authorize until an agent is registered.</p>}
              {agents.map((a) => (
                <div key={a.id} className="bg-white border border-stone-200 rounded-lg p-3 mb-2 text-sm">
                  <div className="flex items-center gap-2 mb-1"><strong>{a.name}</strong><span className="flex-1" />{a.status === 'active' && <Btn primary onClick={() => actions.grant(a.id)}>Set authorization</Btn>}</div>
                  {a.grants.length === 0 && <p className="text-stone-500">No authorizations.</p>}
                  {a.grants.map((g) => (
                    <div key={g.id} className="flex items-center gap-3 border-t border-stone-100 py-1.5 flex-wrap">
                      <span>{g.action}: up to {g.currency} {g.max_amount}</span><span className="text-stone-400">v{g.version} · expires {time(g.exp)}</span>
                      <Pill ok={g.status === 'active'}>{g.status === 'active' ? 'active' : 'withdrawn'}</Pill><span className="flex-1" />
                      {g.status === 'active' && a.status === 'active' && <Btn danger onClick={() => actions.revokeGrant(g.id)}>Withdraw</Btn>}
                    </div>
                  ))}
                </div>
              ))}
            </Stage>

            <Stage n={4} state={s4} title="Waiting for you" story="Agents never act alone on important things. They ask, and you decide with your passkey. The directory then learns what you approved.">
              {waiting === 0 && <p className="text-sm text-stone-500 bg-white border border-dashed border-stone-300 rounded-lg p-3">Nothing is waiting for you. You are all caught up.</p>}
              {pairings.map((x) => (
                <div key={x.id} className="border-2 border-indigo-300 bg-indigo-50 rounded-lg p-3 mb-2 flex items-center gap-3 flex-wrap">
                  <div className="flex-1 text-sm"><div className="font-semibold">{x.name} asks to be registered</div><div className="text-stone-600">code <code>{x.user_code}</code> · key {x.fingerprint}</div></div>
                  <Btn primary onClick={() => actions.reviewPairing(x.id)}>Review</Btn>
                </div>
              ))}
              {approvals.map((a) => (
                <div key={a.id} className="border-2 border-indigo-300 bg-indigo-50 rounded-lg p-3 mb-2 flex items-center gap-3 flex-wrap">
                  <div className="flex-1 text-sm"><div className="font-semibold">{a.agent_name} wants to: {a.action}</div><div className="text-stone-600">{Object.entries(a.summary ?? {}).map(([k, v]) => `${k}: ${v}`).join(' · ')}</div><div className="text-xs text-stone-500">asked by {a.counterparty} · expires {time(a.exp)}</div></div>
                  <Btn onClick={() => actions.declineApproval(a.id)}>Decline</Btn><Btn primary onClick={() => actions.reviewApproval(a.id)}>Review and approve</Btn>
                </div>
              ))}
            </Stage>

            <Stage n={5} state={s5} title="Revoke" story={`Revoking ends an agent's registration for good. Within about ${pr.revocation?.latency_seconds ?? 30} seconds every counterparty that checks the published status list will stop trusting it. Records are kept.`}>
              {active.length === 0 ? <p className="text-sm text-stone-500">{revoked ? 'Every agent you registered has been revoked.' : 'No active agent to revoke.'}</p> : active.map((a) => (
                <div key={a.id} className="flex items-center gap-3 mb-2 text-sm"><span>{a.name}</span><Btn danger onClick={() => actions.revokeAgent(a.id)}>Revoke agent</Btn></div>
              ))}
            </Stage>

            <Stage n={6} state={s6} last title="Accountability" story="If something goes wrong, a counterparty can report it. Only an operator can release who was behind an ID, for that ID only, and you are told when it happens.">
              <h3 className="text-xs font-bold uppercase tracking-wide text-stone-500 mb-1">Notices to you</h3>
              {notes.length === 0 ? <p className="text-sm text-stone-500 mb-3">No notices.</p> : <ul className="text-sm space-y-1 mb-3">{notes.map((n, i) => <li key={i} className="bg-white border border-stone-200 rounded-lg p-2"><span className="text-stone-400">{time(n.ts)}</span> · {n.text}</li>)}</ul>}
              {op && (
                <div className="border-t border-stone-200 pt-3 space-y-3">
                  <h3 className="text-xs font-bold uppercase tracking-wide text-stone-500">Operator: cases</h3>
                  {cases.length === 0 && <p className="text-sm text-stone-500">No cases. A counterparty opens one by sending its signed receipt.</p>}
                  {cases.map((c) => (
                    <div key={c.id} className="bg-white border border-stone-200 rounded-lg p-3 text-sm">
                      <div className="flex items-center gap-2 flex-wrap"><strong>{c.id}</strong><Pill ok={c.status === 'released'}>{c.status}</Pill><span className="text-stone-500">from {c.counterparty} · {time(c.created)}</span><span className="flex-1" />{c.status === 'open' && <Btn onClick={() => actions.releaseCase(c.id)}>Release identity (simulated authority request)</Btn>}</div>
                      {c.note && <div className="text-stone-600 mt-1">“{c.note}”</div>}
                      {c.disclosure && <div className="mt-2 bg-stone-50 rounded p-2">Released: agent <strong>{c.disclosure.agent?.label}</strong> ({c.disclosure.agent?.status_now}), principal <strong>{c.disclosure.principal?.identity}</strong> ({c.disclosure.principal?.assurance} assurance). Basis: {c.basis}</div>}
                    </div>
                  ))}
                  {(op.all_agents ?? []).filter((a) => a.status === 'active').map((a) => (
                    <div key={a.id} className="flex items-center gap-3 text-sm"><span>{a.name} <span className="text-stone-400">({a.principal})</span></span><Btn danger onClick={() => actions.operatorRevokeAgent(a.id)}>Revoke (operator)</Btn></div>
                  ))}
                  <h3 className="text-xs font-bold uppercase tracking-wide text-stone-500">Operator: invitations</h3>
                  <Btn primary onClick={() => actions.invite()}>Invite a principal</Btn>
                  <div className="text-sm text-stone-600">{(op.invites ?? []).length} invitations so far, {(op.invites ?? []).filter((i) => i.used_at).length} used.</div>
                  {(op.outbox ?? []).length > 0 && (
                    <div className="border border-amber-300 bg-amber-50 rounded-lg p-3">
                      <div className="text-xs font-bold text-amber-800 mb-1">LOCAL STAND-IN: outbox (these would be emails on the hosted build)</div>
                      {op.outbox.map((m, i) => <div key={i} className="text-sm"><span className="text-stone-500">to {m.to_addr}:</span> {m.subject} (the link was shown once, when you created it)</div>)}
                    </div>
                  )}
                </div>
              )}
            </Stage>
          </div>
        )}

        <section className="bg-white border border-stone-200 rounded-xl p-5 shadow-sm">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500 mb-2">What this directory publishes about itself</h2>
          <ul className="text-sm space-y-1.5 text-stone-700 list-disc pl-5">
            {proof && <li><strong>Identity checks:</strong> assurance {proof.assurance}. {proof.note}</li>}
            {pr.principal_authentication && <li><strong>You sign in with:</strong> {pr.principal_authentication}</li>}
            {pr.what_the_directory_learns && <li><strong>What it learns:</strong> {pr.what_the_directory_learns}</li>}
            {pr.retention && <li><strong>Retention:</strong> {pr.retention}</li>}
            {pr.release_process && <li><strong>Releasing an identity:</strong> {pr.release_process}</li>}
            {(pr.stand_ins ?? []).map((s: string, i: number) => <li key={i} className="text-amber-800"><strong>Stand-in:</strong> {s}</li>)}
          </ul>
        </section>
      </div>
    </div>
  );
}
