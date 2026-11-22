// Delivery of invitation links.
//   local  : written to a local outbox the operator can see. This is a labelled
//            stand-in and proves nothing about mailbox control.
//   hosted : sent by SMTP to the asserted mailbox only. The link is never shown
//            to the operator. Without mail settings, invitations are refused.
import { fail, nowSec } from '../core/util.js';

export async function sendMail(cfg, db, { to, subject, body, link }) {
  if (cfg.mode === 'local') {
    db.run('INSERT INTO outbox (ts, to_addr, subject, body, link) VALUES (?,?,?,?,?)', nowSec(), to, subject, body, link);
    return 'local outbox (stand-in, not real delivery)';
  }
  if (!cfg.smtp || !cfg.mailFrom) fail(503, 'mail_not_configured');
  const { smtpSend } = await import('./smtp.js');
  await smtpSend(cfg.smtp, { from: cfg.mailFrom, to, subject, body });
  return 'email to the asserted mailbox';
}
