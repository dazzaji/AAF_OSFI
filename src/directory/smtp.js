// A small SMTP client, enough to send one plain-text invitation.
//   smtps://user:pass@host:465     TLS from the start
//   smtp://user:pass@host:587      upgrades with STARTTLS (required unless the host is localhost)
//   sendmail:/usr/sbin/sendmail    hand the message to a local sendmail-compatible program
import net from 'node:net';
import tls from 'node:tls';
import { spawn } from 'node:child_process';

const message = ({ from, to, subject, body }) => [`From: ${from}`, `To: ${to}`, `Subject: ${subject}`, `Date: ${new Date().toUTCString()}`, `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@aaf-pilot>`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', body].join('\r\n');
const clean = (s) => String(s).replace(/[\r\n]/g, ' ');

export async function smtpSend(url, mail) {
  mail = { from: clean(mail.from), to: clean(mail.to), subject: clean(mail.subject), body: mail.body };
  if (url.startsWith('sendmail:')) return viaSendmail(url.slice('sendmail:'.length) || '/usr/sbin/sendmail', mail);
  const u = new URL(url);
  const implicit = u.protocol === 'smtps:';
  const port = Number(u.port || (implicit ? 465 : 587));
  const local = ['localhost', '127.0.0.1'].includes(u.hostname);
  let sock = await new Promise((resolve, reject) => { const s = implicit ? tls.connect({ host: u.hostname, port, servername: u.hostname }, () => resolve(s)) : net.connect({ host: u.hostname, port }, () => resolve(s)); s.once('error', reject); s.setTimeout(15000, () => s.destroy(new Error('smtp timeout'))); });
  let buf = '';
  const reply = () => new Promise((resolve, reject) => {
    const tryParse = () => { const lines = buf.split('\r\n'); for (let i = 0; i < lines.length - 1; i++) if (/^\d{3} /.test(lines[i])) { const text = lines.slice(0, i + 1).join('\n'); buf = lines.slice(i + 1).join('\r\n'); sock.off('data', onData); return resolve({ code: Number(lines[i].slice(0, 3)), text }); } };
    const onData = (d) => { buf += d.toString('utf8'); tryParse(); };
    sock.on('data', onData); sock.once('error', reject); tryParse();
  });
  const cmd = async (line, expect) => { if (line !== null) sock.write(line + '\r\n'); const r = await reply(); if (!expect.includes(r.code)) throw new Error(`smtp: expected ${expect} got ${r.text.slice(0, 200)}`); return r; };
  try {
    await cmd(null, [220]);
    let ehlo = await cmd('EHLO aaf-pilot', [250]);
    if (!implicit) {
      if (/STARTTLS/i.test(ehlo.text)) { await cmd('STARTTLS', [220]); sock = await new Promise((resolve, reject) => { const s = tls.connect({ socket: sock, servername: u.hostname }, () => resolve(s)); s.once('error', reject); }); buf = ''; ehlo = await cmd('EHLO aaf-pilot', [250]); } else if (!local) throw new Error('smtp: server does not offer STARTTLS; refusing to send in clear text');
    }
    if (u.username) await cmd('AUTH PLAIN ' + Buffer.from(`\0${decodeURIComponent(u.username)}\0${decodeURIComponent(u.password)}`).toString('base64'), [235]);
    const addr = (s) => (s.match(/<([^>]+)>/)?.[1] ?? s).trim();
    await cmd(`MAIL FROM:<${addr(mail.from)}>`, [250]);
    await cmd(`RCPT TO:<${addr(mail.to)}>`, [250, 251]);
    await cmd('DATA', [354]);
    await cmd(message(mail).replace(/\r\n\./g, '\r\n..') + '\r\n.', [250]);
    sock.write('QUIT\r\n');
  } finally { sock.end(); }
}

function viaSendmail(bin, mail) {
  return new Promise((resolve, reject) => { const p = spawn(bin, ['-t', '-i'], { stdio: ['pipe', 'ignore', 'pipe'] }); let err = ''; p.stderr.on('data', (d) => { err += d; }); p.on('error', reject); p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error('sendmail failed: ' + err.slice(0, 200))))); p.stdin.end(message(mail).replace(/\r\n/g, '\n')); });
}
