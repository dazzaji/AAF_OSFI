import { createDirectory, directoryConfig } from './directory.js';
const cfg = directoryConfig();
const d = await createDirectory(cfg);
await d.listen();
console.log(`[directory] ${cfg.name} at ${cfg.url} (mode: ${cfg.mode})`);
const link = d.operatorInviteLink();
// The operator link is a secret. On a hosted build it stays in its 0600 file
// in the data folder and is never printed, so it cannot end up in container logs.
if (link && !d.db.get('SELECT 1 FROM principals WHERE is_operator = 1')) console.log(cfg.mode === 'local' ? `[directory] First run. Enroll the operator passkey here:\n            ${link}` : '[directory] First run. The operator link is in OPERATOR-INVITE.txt in the data folder.');
console.log(`[directory] invitations: ${d.mailMode}`);
