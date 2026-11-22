// Console: a plain working view of the directory. Everything on one page.
import React from 'react';
import type { SkinProps, DirectoryData, Agent } from '../SkinContract';

const time = (t?: number | null) => (t ? new Date(t * 1000).toLocaleString() : '—');
const Card = ({ title, children, tone = 'slate' }: { title: string; children: React.ReactNode; tone?: string }) => (
  <section className={`bg-white border border-${tone}-200 rounded-xl p-4 shadow-sm`}>
    <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500 mb-3">{title}</h2>
    {children}
  </section>
);
const Btn = ({ onClick, children, danger = false, primary = false }: { onClick: () => void; children: React.ReactNode; danger?: boolean; primary?: boolean }) => (
  <button onClick={onClick} className={`text-sm px-3 py-1.5 rounded-lg border ${primary ? 'bg-blue-700 border-blue-700 text-white font-semibold' : danger ? 'border-red-300 text-red-700 hover:bg-red-50' : 'border-slate-300 hover:bg-slate-50'}`}>{children}</button>
);
const Pill = ({ ok, children }: { ok: boolean; children: React.ReactNode }) => <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${ok ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>{children}</span>;

function AgentCard({ a, actions }: { a: Agent; actions: SkinProps['actions'] }) {
  const active = a.status === 'active';
  return (
    <div className="border border-slate-200 rounded-lg p-3 mb-3">
      <div className="flex items-center gap-2 flex-wrap">
        <strong>{a.name}</strong>
        <Pill ok={active}>{active ? 'registered' : `revoked by ${a.revoked_by ?? 'principal'}`}</Pill>
        <span className="text-xs text-slate-500">key {a.fingerprint} · {a.ids_issued} IDs issued · last {time(a.last_issued)}</span>
        <span className="flex-1" />
        {active && <Btn onClick={() => actions.setPolicy(a.id)}>Disclosure</Btn>}
        {active && <Btn danger onClick={() => actions.revokeAgent(a.id)}>Revoke agent</Btn>}
      </div>
      <table className="w-full text-sm mt-2">
        <tbody>
          {a.grants.map((g) => (
            <tr key={g.id} className="border-t border-slate-100">
              <td className="py-1.5">{g.action}</td>
              <td>up to {g.currency} {g.max_amount}</td>
              <td className="text-slate-500">v{g.version}</td>
              <td><Pill ok={g.status === 'active'}>{g.status === 'active' ? 'active' : 'withdrawn'}</Pill></td>
              <td className="text-right">{g.status === 'active' && active && <Btn danger onClick={() => actions.revokeGrant(g.id)}>Withdraw</Btn>}</td>
            </tr>
          ))}
          {a.grants.length === 0 && <tr><td className="py-1.5 text-slate-500">No authorizations. This agent can identify itself and nothing more.</td></tr>}
        </tbody>
      </table>
      <div className="mt-2 flex items-center gap-3 text-xs text-slate-500">
        {active && <Btn onClick={() => actions.grant(a.id)}>Set authorization</Btn>}
        <span>Shares how you were verified: {a.policy.share_verification ? 'yes' : 'no'} · Shares your email: {a.policy.share_identity_with.length ? a.policy.share_identity_with.join(', ') : 'never'}</span>
      </div>
    </div>
  );
}

export default function Console({ data, viewer, source, actions }: SkinProps<DirectoryData>) {
  const p = data.principal; const op = data.operator; const pr = data.practices;
  return (
    <div className="max-w-5xl mx-auto p-5 space-y-4">
      <header className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold">{data.meta.name}</h1>
          <p className="text-sm text-slate-500">{pr.kind}</p>
        </div>
        <div className="text-xs text-slate-500 text-right">Status list revision {data.status.rev} · published {Math.max(0, data.meta.now - data.status.published_at)}s ago<br />{data.public.principals} principals · {data.public.agents} agents · {data.public.ids_issued} IDs issued</div>
      </header>

      {viewer.role === 'public' && (
        <Card title="Welcome">
          <p className="mb-3">This directory verifies principals, registers their AI agents and issues accountable IDs. Sign in with your passkey to manage your agents. New here? You need an invitation link from the operator.</p>
          <Btn primary onClick={() => actions.signIn()}>Sign in with passkey</Btn>
        </Card>
      )}

      {p && p.pending_approvals.length > 0 && (
        <Card title="Waiting for your approval" tone="blue">
          {p.pending_approvals.map((a) => (
            <div key={a.id} className="flex items-center gap-3 border border-blue-200 bg-blue-50 rounded-lg p-3 mb-2 flex-wrap">
              <div className="flex-1">
                <div className="font-semibold">{a.agent_name} wants to: {a.action}</div>
                <div className="text-sm text-slate-600">{Object.entries(a.summary).map(([k, v]) => `${k}: ${v}`).join(' · ')}</div>
                <div className="text-xs text-slate-500">asked by {a.counterparty} · expires {time(a.exp)}</div>
              </div>
              <Btn onClick={() => actions.declineApproval(a.id)}>Decline</Btn>
              <Btn primary onClick={() => actions.reviewApproval(a.id)}>Review and approve</Btn>
            </div>
          ))}
        </Card>
      )}

      {p && p.pending_pairings.map((x) => (
        <Card key={x.id} title="An agent asks to be registered" tone="blue">
          <div className="flex items-center gap-3 flex-wrap"><div className="flex-1"><strong>{x.name}</strong> · code <code>{x.user_code}</code> · key {x.fingerprint}</div><Btn primary onClick={() => actions.reviewPairing(x.id)}>Review</Btn></div>
        </Card>
      ))}

      {p && (
        <Card title="You">
          <p className="text-sm">Verified identity: <strong>{p.identity.value}</strong> ({p.identity.type}; {p.identity.method}; assurance: {p.identity.assurance}). Counterparties do not see this unless you choose to share it.</p>
        </Card>
      )}

      {p && (
        <Card title="Your agents">
          {p.agents.map((a) => <AgentCard key={a.id} a={a} actions={actions} />)}
          {p.agents.length === 0 && <p className="text-sm text-slate-500">No agents yet. In Claude Code or Codex, ask your agent to register with this directory. It will send you back here to approve.</p>}
        </Card>
      )}

      {p && p.recent_approvals.length > 0 && (
        <Card title="Your recent decisions">
          <table className="w-full text-sm"><tbody>{p.recent_approvals.map((a) => (
            <tr key={a.id} className="border-t border-slate-100"><td className="py-1.5">{a.agent_name}: {a.action}</td><td className="text-slate-600">{Object.entries(a.summary).map(([k, v]) => `${k}: ${v}`).join(' · ')}</td><td><Pill ok={a.status === 'approved'}>{a.status}</Pill></td><td className="text-right">{(a as any).can_revoke && <Btn danger onClick={() => actions.revokeApproval(a.id)}>Take back</Btn>}</td></tr>
          ))}</tbody></table>
        </Card>
      )}

      {p && p.notifications.length > 0 && (
        <Card title="Notices">
          <ul className="text-sm space-y-1">{p.notifications.map((n, i) => <li key={i}><span className="text-slate-400">{time(n.ts)}</span> · {n.text}</li>)}</ul>
        </Card>
      )}

      {op && (
        <Card title="Operator: invitations">
          <Btn primary onClick={() => actions.invite()}>Invite a principal</Btn>
          {op.outbox.length > 0 && (
            <div className="mt-3 border border-amber-300 bg-amber-50 rounded-lg p-3">
              <div className="text-xs font-bold text-amber-800 mb-1">LOCAL STAND-IN: outbox (these would be emails on the hosted build)</div>
              {op.outbox.map((m, i) => <div key={i} className="text-sm"><span className="text-slate-500">to {m.to_addr}:</span> {m.subject} (the link was shown once, when you created it)</div>)}
            </div>
          )}
          <table className="w-full text-sm mt-3"><tbody>{op.principals.map((x) => <tr key={x.id} className="border-t border-slate-100"><td className="py-1">{x.identity_value}</td><td>{x.assurance} assurance</td><td>{x.agents} agents</td><td>{x.is_operator ? 'operator' : ''}</td></tr>)}</tbody></table>
        </Card>
      )}

      {op && (
        <Card title="Operator: incident cases and attribution">
          {op.cases.length === 0 && <p className="text-sm text-slate-500">No cases. A counterparty opens one by sending its signed receipt for a decision.</p>}
          {op.cases.map((c) => (
            <div key={c.id} className="border border-slate-200 rounded-lg p-3 mb-2 text-sm">
              <div className="flex items-center gap-2 flex-wrap"><strong>{c.id}</strong><Pill ok={c.status === 'released'}>{c.status}</Pill><span className="text-slate-500">from {c.counterparty} · ID {c.sub} · {time(c.created)}</span><span className="flex-1" />{c.status === 'open' && <Btn onClick={() => actions.releaseCase(c.id)}>Release identity (simulated authority request)</Btn>}</div>
              {c.note && <div className="text-slate-600 mt-1">“{c.note}”</div>}
              {c.disclosure && <div className="mt-2 bg-slate-50 rounded p-2">Released: agent <strong>{c.disclosure.agent.label}</strong> ({c.disclosure.agent.status_now}) · principal <strong>{c.disclosure.principal.identity}</strong> ({c.disclosure.principal.assurance} assurance) · ID issued {time(c.disclosure.issued_at)} · basis: {c.basis}</div>}
            </div>
          ))}
        </Card>
      )}

      {op && (
        <Card title="Operator: all agents">
          <table className="w-full text-sm"><tbody>{op.all_agents.map((a) => <tr key={a.id} className="border-t border-slate-100"><td className="py-1">{a.name}</td><td className="text-slate-500">{a.principal}</td><td><Pill ok={a.status === 'active'}>{a.status}</Pill></td><td className="text-right">{a.status === 'active' && <Btn danger onClick={() => actions.operatorRevokeAgent(a.id)}>Revoke (operator)</Btn>}</td></tr>)}</tbody></table>
        </Card>
      )}

      {op && (
        <Card title="Operator: event log (hash-chained)">
          <div className="max-h-64 overflow-auto text-xs font-mono">{op.events.map((e) => <div key={e.seq}>{e.seq} · {time(e.ts)} · {e.type} · {e.hash.slice(0, 10)}…</div>)}</div>
        </Card>
      )}

      <Card title="Published practices">
        <dl className="text-sm grid grid-cols-1 md:grid-cols-[14rem_1fr] gap-x-4 gap-y-2">
          <dt className="text-slate-500">Identity proofing</dt><dd>{pr.identity_proofing[0].method} Assurance: {pr.identity_proofing[0].assurance}. {pr.identity_proofing[0].note}</dd>
          <dt className="text-slate-500">Principal authentication</dt><dd>{pr.principal_authentication}</dd>
          <dt className="text-slate-500">Agent authentication</dt><dd>{pr.agent_authentication}</dd>
          <dt className="text-slate-500">IDs</dt><dd>{pr.id_issuance} Lifetime {pr.id_lifetime_seconds}s.</dd>
          <dt className="text-slate-500">Revocation</dt><dd>Takes effect within {pr.revocation.latency_seconds} seconds. {pr.revocation.method}</dd>
          <dt className="text-slate-500">What this directory learns</dt><dd>{pr.what_the_directory_learns}</dd>
          <dt className="text-slate-500">Retention</dt><dd>{pr.retention}</dd>
          <dt className="text-slate-500">Release process</dt><dd>{pr.release_process}</dd>
          <dt className="text-slate-500">Signing key</dt><dd>{pr.signing_key}</dd>
        </dl>
      </Card>
      {source.kind === 'sample' && <p className="text-center text-xs text-red-700 font-semibold">Showing sample data “{source.name}”. Buttons are inactive.</p>}
    </div>
  );
}
