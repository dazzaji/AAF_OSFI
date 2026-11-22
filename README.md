# Accountable Agents Framework: a minimal lifecycle pilot

A small, readable implementation of the lifecycle described in *The Accountable Agents Framework (AAF): A Blueprint for AI Agent IDs*. It shows an AI agent getting an accountable ID, using it at a counterparty, being asked for more, waiting for its principal's passkey approval, being revoked, and being traced back to its principal after an incident.

**Status: pilot. Not production software and not a conformity claim.** [docs/CONFORMANCE.md](docs/CONFORMANCE.md) marks every Appendix A requirement as demonstrated, partial or not implemented, with its evidence.

## The three parts

| Part | What it is | Where |
|---|---|---|
| **Directory** | Verifies principals, registers agents, issues short-lived IDs and claims, records passkey approvals, revokes, publishes its keys, status list and practices, and can resolve an ID back to its principal under a stated process. | `src/directory/` |
| **Sandbox Shop** | A counterparty. Verifies each presentation offline from what the directory publishes, offers four levels of access, signs a receipt for every decision. Nothing real is bought. | `src/shop/` |
| **`aaf-agent`** | A command-line tool that holds the agent's key and speaks the protocol. Claude Code and Codex use it through a skill or as a local MCP server. | `src/agent/`, `skill/` |

The principal acts only in the browser, with a passkey. The agent's tool has no way to approve, grant or revoke.

## Run it locally

Needs Node.js 22.13 or later.

```bash
npm install
```

```bash
npm start
```

This starts the directory at <http://localhost:4100> and the shop at <http://localhost:4200>. On first run the directory prints a one-time link for enrolling the operator's passkey. Open the pages in Chrome or Safari.

Then, in another terminal:

```bash
node src/agent/cli.js init http://localhost:4100 --shop http://localhost:4200
```

```bash
node src/agent/cli.js register --name "My coding agent"
```

Approve in the browser, then try `catalog`, `quote cards-500`, `order cards-500`, `order cards-5000` and `continue`. `node src/agent/cli.js help` lists everything.

A local build uses labelled stand-ins: invitation links are shown to the operator instead of being emailed, and principals enrolled that way are recorded with no assurance. All three parts also run under one user account, so the local build demonstrates the flows, not the separation between agent and services.

## Using it from Claude Code or Codex

Copy the skill folder, then ask the agent to "register with the accountable agents directory" or "get a quote from the sandbox shop".

```bash
cp -R skill/aaf-agent ~/.claude/skills/aaf-agent
```

```bash
cp -R skill/aaf-agent ~/.agents/skills/aaf-agent
```

The same operations are available as MCP tools: `node /absolute/path/to/src/agent/mcp.js` over stdio.

## Swappable page designs and sample data

Both web pages have a **Design** menu and a **Data** menu.

- A design ("skin") is one React component in `skins/directory/` or `skins/shop/`. Drop a new `.tsx` file in the folder while the service is running and it appears in the menu of every open tab within a few seconds. Save a change and open tabs reload it. No build step, no restart. The contract is in [skins/SkinContract.ts](skins/SkinContract.ts).
- A sample dataset is a JSON file in `datasets/directory/` or `datasets/shop/` with the same shape as live data. It appears in the Data menu next to "Live". Sample data is read-only and cannot affect live state.
- Skins are untrusted. They run in a sandboxed frame with no access to the session, the network or passkeys. Sign-in, every confirmation screen and every privileged action belong to the page shell.

## What a counterparty checks

For each request the shop verifies, without contacting the directory about that ID:

1. the ID names a directory the shop trusts, and is signed by that directory's published key;
2. it was issued for this shop and has not expired;
3. the request is signed by the key the ID is bound to, over the method, path, body, the exact credentials presented, and a single-use nonce the shop issued;
4. the ID, and each claim, is not revoked according to a status list no older than 18 seconds;
5. each claim was issued for this same ID, and who attests it (the directory, or only the agent itself).

See [docs/PROTOCOL.md](docs/PROTOCOL.md) for the message shapes and one annotated exchange.

## Design choices

Each is the simplest option in the paper's Appendix C. The directory states the consequences in its published practices at `/.well-known/aaf-directory`.

| Area | Choice |
|---|---|
| Identity proofing | Control of an email address, by redeeming a single-use link sent to it. Low assurance. |
| Principal authentication | Passkey with user verification. A fresh assertion for every privileged act. |
| Agent authentication | Ed25519 key. Proof of possession at registration, at each issuance and on each request. |
| IDs | Issued on demand, five-minute lifetime, each bound to a fresh key. A stable per-counterparty ID on request. |
| Authorizations | Set by the principal, attested by the directory. Per-action approvals by passkey, attested by the directory. |
| Revocation | Signed status list. Published bound: 30 seconds (10 to publish, 18 accepted age, 2 clock skew). |
| Identity escrow | The directory keeps the map from each issued ID to its agent and principal. |

Known limits: the directory learns which counterparty each ID is for and when; IDs are unlinkable to counterparties, not to the directory; one online signing key; no delegation, key rotation, multi-party escrow or legal-person proofing; the lawful-request step is a labelled simulation.

## Deploying

See [docs/DEPLOYING.md](docs/DEPLOYING.md).

## Credits and license

Written for the AAF paper's call for reference implementations. Christian Turner's [accountable-agents-framework](https://github.com/christortheak/accountable-agents-framework) is the fuller reference profile and implementation; this pilot is an independent, deliberately smaller one. MIT license.
