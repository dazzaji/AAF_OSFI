#!/usr/bin/env node
// aaf-agent: the agent's wallet and protocol client.
// Every command prints one JSON object. Run `aaf-agent help` for the list.
import { createAgent, AgentError } from './client.js';

const HELP = `aaf-agent: hold an Accountable Agent ID and use it at a counterparty

  aaf-agent init <directory-url> --shop <shop-url>   one-time setup (fixed origins)
  aaf-agent register [--name "..."] [--harness claude-code|codex]
                                                     ask the directory to register this agent;
                                                     the user approves in the browser with a passkey
  aaf-agent status                                   registration, authorizations, anything pending
  aaf-agent catalog                                  what the shop sells and what each level needs
  aaf-agent quote <sku> [--qty N]                    needs only an ID
  aaf-agent order <sku> [--qty N] [--new]            needs an authorization; large orders need approval.
                                                     Repeating an order whose answer was lost does not buy twice;
                                                     --new places a second, separate order on purpose
  aaf-agent continue [--approval <id>]               resume after the user approved in the browser
  aaf-agent recheck                                  read-only: is the last ID this agent holds still accepted?

Options: --pairwise (same ID at this shop every time)  --wait <seconds>  --no-browser
Keys and settings live in ~/.aaf-agent (or $AAF_AGENT_HOME). This tool holds the
agent's key only. It cannot approve, grant or revoke anything: only the user can,
with their passkey, in the directory's web page.`;

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
  const agent = createAgent({ openBrowser: !flags['no-browser'] });
  const mode = flags.pairwise ? 'pairwise' : 'ephemeral';
  const wait = flags.wait !== undefined ? Number(flags.wait) : undefined;
  const qty = Number(flags.qty ?? 1);
  switch (cmd) {
    case 'init': if (!pos[1]) throw new AgentError('usage', { usage: 'aaf-agent init <directory-url> --shop <shop-url>' }); return agent.init({ directory: pos[1], shops: flags.shop ? [flags.shop] : [] });
    case 'register': return agent.register({ name: flags.name, harness: flags.harness, wait: wait ?? 0 });
    case 'status': return agent.status();
    case 'catalog': return agent.catalog(agent.shop());
    case 'quote': if (!pos[1]) throw new AgentError('usage', { usage: 'aaf-agent quote <sku> [--qty N]' }); return agent.act({ url: agent.shop() + '/api/quotes', body: { sku: pos[1], qty }, mode, wait: wait ?? 45 });
    case 'order': if (!pos[1]) throw new AgentError('usage', { usage: 'aaf-agent order <sku> [--qty N] [--new]' }); return agent.act({ url: agent.shop() + '/api/orders', body: { sku: pos[1], qty }, mode, wait: wait ?? 45, fresh: !!flags.new });
    case 'continue': return agent.continue({ wait: wait ?? 5, approvalId: typeof flags.approval === 'string' ? flags.approval : undefined });
    case 'recheck': return agent.act({ url: agent.shop() + '/api/check', body: {}, useCached: true });
    default: throw new AgentError('unknown_command', { command: cmd, hint: 'aaf-agent help' });
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('aaf-agent')) {
  run(process.argv.slice(2)).then((out) => { console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2)); }).catch((e) => {
    if (e instanceof AgentError) { console.log(JSON.stringify({ status: 'error', error: e.code, ...e.detail }, null, 2)); process.exit(2); }
    if (e?.code === 'EPERM' || e?.code === 'EACCES') { console.log(JSON.stringify({ status: 'error', error: 'cannot_write_agent_home', path: e.path, hint: 'This shell is sandboxed and may not write the agent\'s key folder. Use the aaf-agent MCP server instead, or allow writes to that folder.' }, null, 2)); process.exit(2); }
    console.error(e); process.exit(1);
  });
}
