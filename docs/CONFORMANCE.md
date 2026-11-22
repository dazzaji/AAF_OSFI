# Conformance to Appendix A of the AAF paper

**This is a self-assessment of a pilot, not a certification.** "Demonstrated" means a mechanism exists in the code and an automated scenario exercises it. It does not mean independently audited or fit for production. Human approval in the automated scenarios is simulated by a software authenticator; only a person's own passkey runs count as a human test.

Scenario numbers refer to the end-to-end scenarios (94 checks in the last run), plus a browser run of the same pages with a virtual passkey (17 checks).

## Mandatory rows (19)

| Row | Status | How | Limits | Scenarios |
|---|---|---|---|---|
| PV-1 Identity proofing | Demonstrated, low assurance | Control of an email address by redeeming a single-use, expiring link emailed to it. Agents cannot register before the principal is enrolled. | Anyone who can read the mailbox or is handed the link can redeem it. Records made on a local build, or from the operator bootstrap link, are recorded and attested with no assurance. | 1, 2, 13 |
| PV-3 Sybil resistance | Demonstrated | One principal record per canonical mailbox, enforced in the database. | Email-level only: one person with two mailboxes is two principals. | 1 |
| PV-5 Principal authentication | Demonstrated | Passkey with user verification. Registering an agent, granting, approving, changing disclosure, revoking and releasing each need a fresh assertion whose challenge is the hash of the server's own description of that act. | User verification shows the passkey holder approved, not which person it was. No passkey recovery. | 1, 2, 5, 10, 11 |
| AG-1 Agent authentication | Demonstrated | Ed25519 key. Signed, single-use requests to the directory; proof of possession of every new presentation key; signed proof on every request to a counterparty. | Key is a file on the agent's machine, not hardware-protected. | 2, 6 |
| AG-2 Registration | Demonstrated | The agent record is created only by the principal's passkey-confirmed approval of a pairing that names the key fingerprint and a code shown on both sides. One record per key. | | 2 |
| PR-1 ID | Demonstrated | Every presentation carries a directory-signed ID naming the directory. No other claim is needed for the lowest protected level. | | 3 |
| PR-2 Holder binding | Demonstrated | The proof is signed by the key in the ID and covers method, path, body, the exact credentials, a single-use nonce from the counterparty and the operation ID. Each claim names the one issuance it belongs to. | Bound to the request, not to the connection (Appendix C §2 option 1). Protection in transit relies on TLS. | 6, 7b |
| PR-3 Validity | Demonstrated | Expiry and revocation status are checked for the ID and for each claim separately, and again inside the write transaction. | | 6, 10 |
| PR-4 Claims and issuers | Demonstrated | Each claim is labelled directory-attested or self-asserted, and the shop treats them differently. | Claims signed by the principal's own key are not implemented; authorizations and approvals are attested by the directory. | 4, 6 |
| PR-5 Selective disclosure | Demonstrated | The agent asks for only the claims a counterparty requires; the principal's policy can withhold verification details and identity per counterparty. A presentation contains nothing about claims it omits. | Disclosure is per claim, chosen at issuance. | 4, 7 |
| PR-6 Anonymity toward counterparties | Demonstrated | The ID alone carries no information about the agent or principal. | Network metadata is outside this protection. | 3, 4 |
| PR-7 Unlinkability | Partial | By default every presentation has a fresh ID, key and status entry. | Unlinkable to counterparties only: the directory sees every issuance. When several outstanding IDs are revoked together, their status entries change together, which can reveal that they belong to one agent. The presentations inside one transaction (a request for more, an approval, a retry) share an operation ID by design. | 3 |
| PR-9 No directory contact | Demonstrated | The shop verifies from published keys and a whole status list fetched on a timer. It keeps working with the directory switched off while its list is fresh. | | 3, 8 |
| PR-10 Presentation requests | Demonstrated | The shop states which claims it needs and why offered ones were not accepted; the agent returns with them. The shop's approval request is signed and carried by the agent; the shop contacts neither directory nor principal. | | 3, 4, 5 |
| RV-1 Revocation | Demonstrated | A principal can revoke one authorization (the registration and other claims survive), withdraw a disclosure (outstanding verification or identity claims are revoked, each through its own status entry), or revoke the whole registration; the operator can revoke a registration. Records are kept. | The directory cannot revoke a single claim on its own initiative, only a registration. | 9b, 10, 12 |
| RV-2 Revocation latency | Demonstrated | Published bound of 30 seconds: 10 to publish, 18 accepted age, 2 clock skew. The shop defers and writes nothing when its list is older. Measured at about 5 seconds locally. | Measured on one machine, not across a network. | 8, 10 |
| ES-1 Identity escrow | Demonstrated, simulated process | Each issued ID is recorded with its agent and principal before it is returned. A case needs a report signed by the counterparty, covering its signed receipt for a holder-verified decision, and resolves that exact issuance. Works after revocation and restart. | The lawful request is a labelled simulation. The directory alone can resolve. | 11 |
| DR-1 Published practices | Demonstrated | Proofing, authentication, lifetimes, revocation bound and its budget, what the directory learns, retention, release process, key handling and active stand-ins are published with the keys. | | 1, 13 |
| DR-2 Adherence | Partial | Lifetimes and the revocation bound are enforced by the code that publishes them; records, keys and the hash-chained event log survive restart. | Not independently assessed. The event log detects partial edits, not a full rewrite by the operator. No automatic deletion; retention is whatever the operator does at pilot close. | 8, 9, 11 |

## Optional rows (8)

| Row | Status |
|---|---|
| PV-2 Human and legal entity proofing | Not implemented. The "organization" case in scenario 7 uses a synthetic, email-verified principal that chooses to disclose its address. |
| PV-4 Sybil resistance across directories | Not implemented. |
| AG-3 Delegation | Not implemented. |
| AG-4 Multiple principals | Not implemented. |
| AG-5 Re-registration | Not implemented. A new key is a new agent record. |
| PR-8 Pairwise pseudonymous identifiers | Demonstrated for agents: on request, one stable ID per agent and counterparty, derived by the directory. No principal-level identifier. |
| ES-2 Multi-party control | Not implemented. |
| DR-3 Conformity assessment | Not implemented. Two independent model reviewers examined the code; that is not an audit. |

## The paper's four pilot cases (section 4)

| Case | Where |
|---|---|
| Disclosed organizational principal | Scenario 7, with a synthetic identity |
| Privacy-protected human principal | Scenarios 3 to 5 |
| Unsupported accountability claims | Scenarios 4 and 6: self-asserted authorization, untrusted directory, forged ID |
| Revoked or compromised credentials | Scenarios 6 and 10: copied ID, replay, revoked authorization, revoked registration |
