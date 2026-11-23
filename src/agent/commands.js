// The commands behind `aaf-agent`. Every command returns one JSON object
// (or the help text). `cli.js` and the release bundle both call main().
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgent, AgentError, VERSION, installRoot } from './client.js';

const HELP = `aaf-agent: hold an Accountable Agent ID and use it at a counterparty

  aaf-agent version                                  client version, Node.js version, profile folder
  aaf-agent init <directory-url> --shop <shop-url> [--home <folder>]
                                                     one-time setup (fixed origins). --home keeps this
                                                     install's agent key in its own profile folder
  aaf-agent register [--name "..."] [--harness claude-code|codex] [--wait <seconds>] [--new]
                                                     ask the directory to register this agent;
                                                     the user approves in the browser with a passkey.
                                                     --wait watches for that approval. --new starts over
                                                     with a new key after this agent was revoked
  aaf-agent status                                   registration, authorizations, anything pending
  aaf-agent catalog                                  what the shop sells and what each level needs
  aaf-agent quote <sku> [--qty N]                    needs only an ID
  aaf-agent order <sku> [--qty N] [--new]            needs an authorization; large orders need approval.
                                                     Repeating an order whose answer was lost does not buy twice;
                                                     --new places a second, separate order on purpose
  aaf-agent continue [--approval <id>]               resume after the user approved in the browser
  aaf-agent recheck                                  read-only: is the last ID this agent holds still accepted?

Options: --pairwise (same ID at this shop every time)  --wait <seconds>  --no-browser
Keys and settings live in the profile folder: $AAF_AGENT_HOME, else the folder set
with "init --home", else ~/.aaf-agent. This tool holds the agent's key only. It
cannot approve, grant or revoke anything: only the user can, with their passkey,
in the directory's web page. Every order at the sandbox shop is fictional.`;

function parse(argv) {
  const pos = []; const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); const next = argv[i + 1]; if (next === undefined || next.startsWith('--')) flags[k] = true; else { flags[k] = next; i++; } } else pos.push(a);
  }
  return { pos, flags };
}

export async function run(argv) {
  const { pos, flags } = parse(argv);
  const cmd = pos[0] ?? 'help';
  if (cmd === 'help' || flags.help) return HELP;
  if (cmd === 'version') return { name: 'aaf-agent', version: VERSION, node: process.version, profile_folder: createAgent().home };
  // `init --home <folder>`: remember, beside this install, which profile folder
  // it uses. Two apps on one computer then hold two different agent keys.
  if (cmd === 'init' && typeof flags.home === 'string') {
    const home = path.resolve(flags.home.replace(/^~(?=$|\/)/, os.homedir()));
    if (process.env.AAF_AGENT_HOME && path.resolve(process.env.AAF_AGENT_HOME) !== home) throw new AgentError('home_set_by_environment', { hint: 'AAF_AGENT_HOME is set and wins. Unset it, or leave out --home.' });
    fs.writeFileSync(path.join(installRoot(), 'profile-home.txt'), home + '\n', { mode: 0o600 });
  }
  const agent = createAgent({ openBrowser: !flags['no-browser'] });
  const mode = flags.pairwise ? 'pairwise' : 'ephemeral';
  const wait = flags.wait !== undefined ? Number(flags.wait) : undefined;
  const qty = Number(flags.qty ?? 1);
  switch (cmd) {
    case 'init': if (!pos[1]) throw new AgentError('usage', { usage: 'aaf-agent init <directory-url> --shop <shop-url> [--home <folder>]' }); return { ...agent.init({ directory: pos[1], shops: typeof flags.shop === 'string' ? [flags.shop] : [] }), profile_folder: agent.home };
    case 'register': return agent.register({ name: typeof flags.name === 'string' ? flags.name : undefined, harness: typeof flags.harness === 'string' ? flags.harness : undefined, wait: wait ?? 0, fresh: !!flags.new });
    case 'status': return agent.status();
    case 'catalog': return agent.catalog(agent.shop());
    case 'quote': if (!pos[1]) throw new AgentError('usage', { usage: 'aaf-agent quote <sku> [--qty N]' }); return agent.act({ url: agent.shop() + '/api/quotes', body: { sku: pos[1], qty }, mode, wait: wait ?? 45 });
    case 'order': if (!pos[1]) throw new AgentError('usage', { usage: 'aaf-agent order <sku> [--qty N] [--new]' }); return agent.act({ url: agent.shop() + '/api/orders', body: { sku: pos[1], qty }, mode, wait: wait ?? 45, fresh: !!flags.new });
    case 'continue': return agent.continue({ wait: wait ?? 5, approvalId: typeof flags.approval === 'string' ? flags.approval : undefined });
    case 'recheck': return agent.act({ url: agent.shop() + '/api/check', body: {}, useCached: true });
    default: throw new AgentError('unknown_command', { command: cmd, hint: 'aaf-agent help' });
  }
}

export function main(argv) {
  return run(argv).then((out) => { console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2)); }).catch((e) => {
    if (e instanceof AgentError) { console.log(JSON.stringify({ status: 'error', error: e.code, ...e.detail }, null, 2)); process.exit(2); }
    if (e?.code === 'EPERM' || e?.code === 'EACCES') { console.log(JSON.stringify({ status: 'error', error: 'cannot_write_agent_home', path: e.path, hint: 'This shell is sandboxed and may not write the agent\'s profile folder. Ask the user to allow writes to that folder, or use the aaf-agent MCP server instead.' }, null, 2)); process.exit(2); }
    console.error(e); process.exit(1);
  });
}
