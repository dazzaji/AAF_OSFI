// The contract every skin implements. A skin is one React component, default
// exported from skins/directory/<Name>.tsx or skins/shop/<Name>.tsx.
//
// Drop a new file in the folder while the service is running and it appears in
// the Design menu of every open tab within a few seconds. Save a change and
// the open tabs reload that design.
//
// Rules:
//  - Import only "react". Styling: Tailwind classes work (loaded in the frame).
//  - A skin is presentation only. It runs in a sandboxed frame with no access
//    to the session, cookies, network or passkeys.
//  - `data` has the same shape whether it is live or a sample dataset.
//  - `actions.x(id)` asks the trusted page shell to start something. The shell
//    shows its own confirmation screen and passkey prompt. A skin cannot make
//    anything happen by itself, and cannot draw the confirmation.
//  - Each action takes at most one string or number argument.
//  - Times are seconds since 1970. Show them with
//    toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) so a deadline
//    reads the same in a design as on the shell's trusted screens.
//  - A design cannot copy to the clipboard or open links. The page shell draws
//    the first-time setup strip (the agent message, Copy, the download link);
//    a design may show that text and ask for the strip to be opened.

export interface SkinProps<D = DirectoryData | ShopData> {
  data: D;
  viewer: { role: 'public' | 'principal' | 'operator' | 'admin'; identity?: string | null };
  source: { kind: 'live' | 'sample'; name: string };
  isBusy: boolean;
  statusText: string;
  actions: DirectoryActions & ShopActions;
}

export interface DirectoryActions {
  getStarted(): void;                          // open the shell's own first-time setup strip (copying and links live there)
  signIn(): void;
  signOut(): void;
  reviewPairing(pairingId: string): void;      // an agent asks to be registered
  reviewApproval(approvalId: string): void;    // approve one exact action
  declineApproval(approvalId: string): void;
  grant(agentId: string): void;                // set or change an authorization
  revokeGrant(grantId: string): void;          // withdraw one authorization
  revokeApproval(approvalId: string): void;    // take back one approval that has not expired
  revokeAgent(agentId: string): void;          // revoke the whole registration
  setPolicy(agentId: string): void;            // what the agent may disclose
  invite(): void;                              // operator: invite a mailbox
  releaseCase(caseId: string): void;           // operator: attribution release
  operatorRevokeAgent(agentId: string): void;  // operator: revoke under published practice
}
export interface ShopActions {
  reportIncident(decisionSeq: number): void;   // send the signed receipt to the directory
  adminSignIn(): void;
}

export interface Grant { id: string; action: string; label?: string; max_amount: number; currency: string; version: number; status: 'active' | 'revoked'; exp: number; revoked_at: number | null }
export interface Agent { id: string; name: string; harness: string | null; fingerprint: string; status: 'active' | 'revoked'; created: number; revoked_at: number | null; revoked_by: string | null; policy: { share_verification: boolean; share_identity_with: string[] }; ids_issued: number; last_issued: number | null; grants: Grant[] }
export interface PendingApproval { id: string; counterparty: string; agent_name: string; exp: number; created?: number; action_label?: string; fictional?: boolean; action: string; params: Record<string, unknown>; summary: Record<string, string | number> }

export interface DirectoryData {
  surface: 'directory';
  meta: { name: string; url: string; mode: 'local' | 'hosted'; now: number };
  viewer: { role: 'public' | 'principal' | 'operator'; identity: string | null };
  practices: Record<string, any>;              // what the directory publishes about itself (DR-1)
  status: { rev: number; published_at: number; uri: string };
  // First-time setup, for display. The shell owns the Copy button and the links.
  setup?: { version: string; skill_url: string; guide_url: string; zip_url: string; zip_sha256: string; source_url: string; shop_url: string; shop_name: string; agent_message: string; enrolled: boolean; operator_enrolled: boolean; paths: Record<string, { label: string; status: string; how: string }> };
  public: { principals: number; agents: number; ids_issued: number };
  principal?: {
    identity: { type: string; value: string; method: string; assurance: string };
    agents: Agent[];
    pending_pairings: { id: string; user_code: string; name: string; harness: string | null; fingerprint: string; exp: number; created?: number }[];
    pending_approvals: PendingApproval[];
    recent_approvals: (PendingApproval & { status: string; decided_at: number | null; can_revoke: boolean })[];
    notifications: { ts: number; kind: string; text: string }[];
  };
  operator?: {
    principals: { id: string; identity_type: string; identity_value: string; assurance: string; is_operator: number; created: number; agents: number }[];
    all_agents: { id: string; name: string; status: string; fingerprint: string; principal: string }[];
    invites: { email: string; exp: number; used_at: number | null; created: number; delivery: string; state: string }[];
    invite_mode: string;   // 'local' | 'resend' | 'smtp' | 'operator-link' | 'none'
    outbox: { ts: number; to_addr: string; subject: string }[];   // local stand-in only; links are never given to a design
    cases: { id: string; counterparty: string; sub: string; note: string; status: 'open' | 'released'; created: number; released_at: number | null; basis: string | null; disclosure: any | null }[];
    events: { seq: number; ts: number; type: string; data: any; hash: string }[];
  };
}

export interface Decision {
  seq: number; ts: number; action: string;
  decision: 'granted' | 'denied' | 'step_up' | 'deferred'; reason: string;
  id: string | null; id_mode: 'ephemeral' | 'pairwise' | null; issuer: string | null;
  claims: { type: string; attested_by: 'directory' | 'self' | 'other' | 'unknown'; accepted: boolean; reason: string | null }[];
  status_rev: number | null; status_age: number | null;
  params: Record<string, any> | null; result: Record<string, any> | null; required: any[] | null;
  learned: string[]; not_learned: string[];
  receipt_ref: string | null; case_ref: string | null; can_report: boolean;
}
export interface ShopData {
  surface: 'shop';
  meta: { name: string; url: string; mode: 'local' | 'hosted'; now: number };
  viewer: { role: 'public' | 'admin' };
  levels: { level: number; example: string; requires: string }[];
  catalog: { sku: string; name: string; price: number }[];
  currency: string;
  trust: { issuer: string; name: string | null; status_rev: number | null; status_age: number | null; fresh: boolean; max_age: number; error: string | null }[];
  decisions: Decision[];
  orders: { id: string; ts: number; sku: string; qty: number; total: number; currency: string; approved: number }[];
  feed_hidden?: boolean;
}
