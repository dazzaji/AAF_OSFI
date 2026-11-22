import { createDirectory, directoryConfig } from './directory.js';
const cfg = directoryConfig();
const d = await createDirectory(cfg);
await d.listen();
console.log(`[directory] ${cfg.name} at ${cfg.url} (mode: ${cfg.mode})`);
const link = d.operatorInviteLink();
if (link && !d.db.get('SELECT 1 FROM principals WHERE is_operator = 1')) console.log(`[directory] First run. Enroll the operator passkey here:\n            ${link}`);
