# The pilot protocol

This is the small protocol the pilot uses. It is one way to meet the paper's requirements, not the only one. Every signed object is a compact JWS using EdDSA (Ed25519) with an explicit `typ`, so an object made for one purpose cannot be replayed as another.

## Parties and keys

| Party | Key | Published at |
|---|---|---|
| Directory | One signing key | `GET /.well-known/aaf-directory` (`jwks`, `status_list_uri`, `practices`) |
| Shop (counterparty) | One signing key, for approval requests and receipts | `GET /.well-known/aaf-counterparty` |
| Agent | A long-term key, registered with the directory. A fresh presentation key for every ID. | Not published |
| Principal | A passkey, held in their browser or device | Not published |

## Signed objects

| `typ` | Signed by | Purpose | Main fields |
|---|---|---|---|
| `aaf-id+jwt` | Directory | The ID | `iss`, `sub` (the ID), `aud` (one counterparty), `iat`, `exp`, `jti`, `cnf.jwk` (presentation key), `id_mode`, `status.idx` |
| `aaf-claim+jwt` | Directory, or the agent itself | One claim about the same ID | `sub`, `aud`, `exp`, `attested_by` (`directory` or `self`), `claim.type`, `claim.value`, `status.idx` |
| `aaf-proof+jwt` | Agent, with the presentation key | Holder proof for one HTTP request | `aud`, `htm`, `htu`, `body_hash`, `creds_hash`, `nonce`, `op`, `iat` |
| `aaf-ticket+jwt` | Shop | "Approve exactly this" | `aud` (the directory), `for_id`, `action`, `params`, `action_digest`, `exp` |
| `aaf-receipt+jwt` | Shop | Record of one decision | `action`, `params`, `action_digest`, `decision`, `reason`, `holder_verified`, `id`, `id_jti`, `id_issuer`, `claims`, `status` |
| `aaf-statuslist+jwt` | Directory | Revocation snapshot | `iat`, `exp`, `rev`, `status_list.lst` (one bit per ID or claim, deflated) |
| `aaf-agent-req+jwt` | Agent, with its long-term key | Authenticates a request to the directory | `iss` (agent record), `aud`, `htm`, `htu`, `body_hash`, `iat`, `jti` |
| `aaf-key-pop+jwt` | Agent, with a new presentation key | Proves it holds that key | `aud`, `agent`, `iat` |

Claim types: `authorization` (`action`, `max_amount`, `currency`, `grant_ref`), `principal_verification` (`identity_type`, `method`, `assurance`), `principal_identity` (only if the principal allowed it for that counterparty), `approval` (`ticket_digest`, `action_digest`, `grant_ref`, `user_verified`).

## The exchange, step by step

All values below are synthetic.

**1. Agent asks the shop for a nonce.**

```
GET https://shop.example/api/challenge
→ { "nonce": "Zk3…", "expires_in": 120, "audience": "https://shop.example" }
```

**2. Agent asks its directory for an ID for this shop.** The request is authenticated with the agent's registered key and carries a new presentation key with proof that the agent holds it.

```
POST https://directory.example/api/issue
AAF-Agent-Auth: <aaf-agent-req+jwt>
{ "aud": "https://shop.example", "mode": "ephemeral",
  "presentation_jwk": { "kty": "OKP", "crv": "Ed25519", "x": "…" },
  "key_pop": "<aaf-key-pop+jwt>", "want": [] }
→ { "id": "<aaf-id+jwt>", "claims": [], "withheld": [] }
```

The directory writes the link from this ID to the agent and principal before it answers. That record is the identity escrow.

**3. Agent presents.** One header carries the ID, any claims and the holder proof.

```
POST https://shop.example/api/orders
AAF-Presentation: base64url({ "id": "<aaf-id+jwt>", "claims": [], "proof": "<aaf-proof+jwt>" })
{ "sku": "cards-500", "qty": 1 }
```

**4. Shop answers.** One of:

| Status | `error` | Meaning | What the agent does |
|---|---|---|---|
| 200 | | Done. `receipt` is the shop's signed record. | Report it. |
| 401 | `presentation_required` | No ID was presented. | Present one. |
| 403 | `claim_required` | `required` lists the claims needed, and why any offered claim was not accepted. | Ask the directory for those claims and present again. If the directory withholds them, only the principal can help. |
| 403 | `authorization_insufficient` | The authorization does not cover the amount. | Only the principal can widen it. |
| 403 | `approval_required` | `ticket` is the shop's signed request for approval of this exact action. | Relay the ticket to the directory. |
| 403 | anything else | Denied: `id_revoked`, `holder_binding_failed`, `untrusted_issuer`, and so on. | Stop. |
| 503 | `status_too_old` | The shop's copy of the status list is too old to rely on. Nothing was done. | Try again shortly. |

Every answer except a malformed request includes a signed `receipt`.

**5. Approval.** The agent relays the ticket. The directory checks the shop's signature, that the ticket was requested with one of this agent's own IDs, and that the amount is within the standing authorization.

```
POST https://directory.example/api/approvals   { "ticket": "<aaf-ticket+jwt>" }
→ { "approval_id": "ap_…", "status": "pending", "review_url": "https://directory.example/?approval=ap_…" }
```

The principal opens `review_url`. The directory shows the action and parameters from the signed ticket and asks for a passkey assertion whose challenge is the hash of that exact description. On success the agent asks for a new ID with `"approval_id"` set and receives an `approval` claim, then repeats step 3 with the same body. The shop checks that the approval matches its own ticket, the same action digest and the same authorization, then writes the order, marks the ticket used and stores the receipt in one transaction.

**6. Revocation.** The principal revokes one authorization or the whole registration with a passkey. The directory sets the status bits of every affected, unexpired ID and claim, raises the list revision and republishes. The shop fetches the whole list every 5 seconds and refuses to rely on a list older than 18 seconds.

**7. Attribution.** The shop sends the directory its signed receipt for a decision in which the holder was verified. The directory checks the shop's signature and that the ID was issued for that shop, and opens a case. An operator releases, with a passkey and a recorded basis, the agent label and verified identity for that one issuance. The principal is notified at both steps.

## Request retries

Each intended write has an operation ID, chosen by the agent and signed into the holder proof (`op`). The shop writes an operation once and returns the original receipt if it sees the same one again. An approved order is also tied to its ticket, which can be used once.
