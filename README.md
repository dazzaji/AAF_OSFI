# Accountable Agents Framework reference implementation

Use a desktop coding agent to try the lifecycle in *The Accountable Agents Framework (AAF): A Blueprint for AI Agent IDs*. Ask the agent in chat to get a quote or place a fictional order. The Sandbox Shop checks the agent's ID and asks for more proof when needed. You control the agent's permissions and approve specific actions with your passkey in the Directory.

## Try the hosted pilot

Open the [Accountable Agents Directory](https://aaf-dir.civics.com/) and the [Sandbox Print Shop](https://aaf-shop.civics.com/). Both sites have a **Design** menu with **Story** and **Console**, and a **Data** menu with live data and read-only samples. Live enrollment is by invitation. The Shop's live decision history is available to its administrator.

**Use Claude Code in the Claude desktop app or the Codex desktop app** after [one-time setup](#connect-a-desktop-agent). The live walkthrough below was tested with Claude Code Desktop on a Mac. The Codex skill and local MCP server are included. The hosted Codex desktop passkey flow has yet to be tested end to end.

1. Open the Directory invitation from your inbox and create a passkey. Redeeming an emailed invitation demonstrates control of that mailbox.
2. In a local desktop coding session, ask **“Use the AAF agent skill and register with the Directory as my demo agent.”** Compare the pairing code and key fingerprint shown in chat and in the Directory, then confirm with your passkey.
3. Ask **“Get a quote from the Sandbox Shop for 500 business cards.”** The Shop checks a short-lived ID issued by the Directory and returns a fictional **$38** quote.
4. Ask for a fictional order for **5,000 business cards**. The Shop asks for authorization and requires your approval of this exact **$480** order. Review the Directory confirmation and approve with your passkey, then ask the agent to continue.
5. In the Directory, withdraw the ordering permission or revoke the agent. Withdrawing the permission blocks new orders that require it. Revoking the agent stops the Directory from issuing it new IDs.

The pilot also shows how a Shop can report a transaction using its signed receipt. In a simulated release process, an authorized operator can trace that receipt to the principal, who receives a notice. See the [Appendix A conformance notes](docs/CONFORMANCE.md) for what the pilot demonstrates and where it is partial. This is a sandbox for exploring the framework. All orders are fictional.

## Connect a desktop agent

A local setup gives the desktop agent access to the included client. Once that is configured, the walkthrough takes place in the coding app and browser. The client holds the agent's signing key. You retain the passkey used to approve, grant, and revoke in the Directory.

From a clone of this repository, with Node.js 22.13 or later, install dependencies with `npm ci`. For a new install, copy the [AAF agent skill](skill/aaf-agent/SKILL.md) for the desktop app you use.

```bash
# Claude Code in the Claude app
mkdir -p ~/.claude/skills
cp -R skill/aaf-agent ~/.claude/skills/

# Codex desktop
mkdir -p ~/.agents/skills
cp -R skill/aaf-agent ~/.agents/skills/
```

Open a **local** coding session in this checkout. On first use, ask the agent to use the AAF skill and tell it the Directory and Shop addresses above (or the addresses of your own instance). The agent can initialize the client and open the pairing page. Use the [Claude Code desktop guide](https://code.claude.com/docs/en/desktop) or [Codex skill guide](https://learn.chatgpt.com/docs/build-skills) for the app's local configuration.

### Local MCP server

The same agent client has a [local MCP server](src/agent/mcp.js). Configure the desktop app to launch it over stdio with `node /absolute/path/to/src/agent/mcp.js`. This is useful when the desktop session's shell cannot write the agent's local profile. Initialize the client for the same profile before using MCP:

```bash
node src/agent/cli.js init https://aaf-dir.civics.com --shop https://aaf-shop.civics.com
```

Use separate `AAF_AGENT_HOME` profiles if you want the two desktop apps to represent different agents, or if you use both a hosted and a local Directory. The profile configured for MCP must match the one initialized by the client. The [command-line entry point](src/agent/cli.js) is also available for developers who want to run the flows directly.

## The three parts

| Part | What it does | Code |
|---|---|---|
| **Directory** | Enrolls people, registers agents, issues IDs and claims, records passkey approvals, publishes revocations, and can trace an ID under a stated process. | [Directory source](src/directory/) |
| **Sandbox Shop** | Checks the agent's presentation against a trusted Directory's published keys and status list, applies its access rules, and signs decision receipts. | [Shop source](src/shop/) |
| **Agent client** | Holds the agent's key and handles registration, ID requests, and Shop interactions for the desktop agent. | [Agent source](src/agent/) |

## Run the services locally

With Node.js 22.13 or later, run the following from the repository root:

```bash
npm ci
npm start
```

Open the [local Directory](http://localhost:4100) and [local Shop](http://localhost:4200) in Chrome or Safari. On the first run, the local Directory prints a one-time link to enroll its operator. Invite a principal from the operator view, then use the desktop walkthrough with the local addresses. Developers can also initialize the client with `node src/agent/cli.js init http://localhost:4100 --shop http://localhost:4200` and run `node src/agent/cli.js help` for commands.

Local invitations appear in the operator's outbox and carry no mailbox assurance. The services and agent run under one user account. For separate hosted services and real email delivery, see [Deploying the pilot](docs/DEPLOYING.md).

## Swappable page designs and sample data

Both web pages have a **Design** menu and a **Data** menu.

- A design ("skin") is one React component in `skins/directory/` or `skins/shop/`. Drop a new `.tsx` file in the folder while the service is running and it appears in the menu of every open tab within a few seconds. Save a change and open tabs reload it. No build step, no restart. The contract is in [skins/SkinContract.ts](skins/SkinContract.ts).
- A sample dataset is a JSON file in `datasets/directory/` or `datasets/shop/` with the same shape as live data. It appears in the Data menu next to "Live". Sample data is read-only and cannot affect live state.
- Skins are untrusted. They run in a sandboxed frame with no access to the session, the network or passkeys. Sign-in, every confirmation screen and every privileged action belong to the page shell.

## What a counterparty checks

For requests that require an agent ID, the Shop checks the presentation against the Directory's published information:

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

Known limits: the directory learns which counterparty each ID is for and when; the default single-use IDs carry no stable identifier for the Shop, while the Directory can link its own issuances; one online signing key; no delegation, key rotation, multi-party escrow or legal-person proofing; the lawful-request step is a labelled simulation.

## Deploying

See [docs/DEPLOYING.md](docs/DEPLOYING.md).

## Credits and license

Written for the AAF paper's call for reference implementations. Christian Turner's [accountable-agents-framework](https://github.com/christortheak/accountable-agents-framework) is the fuller reference profile and implementation; this pilot is an independent, deliberately smaller one.

This pilot is licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for copyright and attribution.
