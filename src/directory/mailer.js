// Delivery of invitation links. One transport is chosen at start-up:
//   local         : written to a local outbox the operator can see. A labelled
//                   stand-in that proves nothing about mailbox control.
//   resend        : one HTTPS request to the Resend API (hosts such as
//                   DigitalOcean block the SMTP ports).
//   smtp          : SMTP, for hosts that allow it.
//   operator-link : nothing is sent. The link is shown once to the operator,
//                   who hands it over. Records made this way carry no mailbox
//                   assurance. Must be switched on explicitly.
//   none          : invitations are refused.
// Nothing here logs an address, a link, a provider response or a key.
import fs from 'node:fs';

export function mailMode(cfg) {
  if (cfg.mode === 'local') return 'local';
  if (cfg.resendKey && cfg.mailFrom) return 'resend';
  if (cfg.smtp && cfg.mailFrom) return 'smtp';
  if (cfg.inviteFallback === 'operator-link') return 'operator-link';
  return 'none';
}

export function readKeyFile(file) {
  try { const k = fs.readFileSync(file, 'utf8').trim(); return k || null; } catch { return null; }
}

// Returns { send({ to, subject, body, idemKey }) }. send resolves when the
// provider accepted the message and throws otherwise; it never reports why.
export function createTransport(cfg, { fetchImpl = fetch } = {}) {
  const mode = mailMode(cfg);
  if (mode === 'resend') {
    return { mode, async send({ to, subject, body, idemKey }) {
      const res = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { authorization: `Bearer ${cfg.resendKey}`, 'content-type': 'application/json', 'Idempotency-Key': idemKey },
        body: JSON.stringify({ from: cfg.mailFrom, to, subject, text: body }),
      });
      if (!res.ok) throw new Error('send refused');
    } };
  }
  if (mode === 'smtp') {
    return { mode, async send({ to, subject, body }) { const { smtpSend } = await import('./smtp.js'); await smtpSend(cfg.smtp, { from: cfg.mailFrom, to, subject, body }); } };
  }
  return { mode, async send() { throw new Error('no mail transport'); } };
}
