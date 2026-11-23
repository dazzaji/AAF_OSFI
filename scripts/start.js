// Start the directory and the shop together for local use.
import { spawn } from 'node:child_process';
const run = (name, file) => { const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', file], { stdio: 'inherit', env: process.env }); p.on('exit', (c) => { console.log(`[${name}] exited (${c})`); process.exit(c ?? 1); }); return p; };
const d = run('directory', 'src/directory/server.js');
setTimeout(() => { const s = run('shop', 'src/shop/server.js'); process.on('SIGINT', () => { d.kill(); s.kill(); }); }, 800);
