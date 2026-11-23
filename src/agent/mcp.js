#!/usr/bin/env node
// The same four operations as the CLI, exposed as MCP tools over stdio.
// From the release ZIP the file is aaf-agent-mcp.mjs; from a checkout, src/agent/mcp.js.
// Add to Claude Code:  claude mcp add aaf-agent -- node /absolute/path/aaf-agent-mcp.mjs
// Add to Codex:        codex mcp add aaf-agent -- node /absolute/path/aaf-agent-mcp.mjs
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createAgent, AgentError, VERSION } from './client.js';

const TOOLS = [
  { name: 'aaf_status', description: 'Show whether this agent is registered with the Accountable Agents directory, what it is authorized to do, and anything waiting for the user.', inputSchema: { type: 'object', properties: {} } },
  { name: 'aaf_register', description: 'Ask the directory to register this agent. Opens the directory page in the user\'s browser; the user approves with their passkey. Tell the user the code and key fingerprint so they can check they match. Call again afterwards to confirm.', inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'A label the user will recognise, e.g. "Claude Code on my Mac"' }, harness: { type: 'string', description: 'claude-code or codex' }, wait: { type: 'integer', minimum: 0, maximum: 90, description: 'Seconds to watch for the user\'s approval before answering (it only checks; it approves nothing)' }, new: { type: 'boolean', description: 'Start over with a new key. Only after this agent was revoked, and only if the user asks.' } } } },
  { name: 'aaf_shop', description: 'Use the sandbox shop with this agent\'s accountable ID. operation "catalog" lists items and what each level of access requires; "quote" needs only an ID; "order" needs the user\'s standing authorization, and large orders need the user to approve the exact order with their passkey (the result then says approval_pending).', inputSchema: { type: 'object', required: ['operation'], properties: { operation: { type: 'string', enum: ['catalog', 'quote', 'order'] }, sku: { type: 'string' }, qty: { type: 'integer', minimum: 1 } } } },
  { name: 'aaf_continue', description: 'Resume a pending action after the user says they approved it in the browser. With several pending, pass approval_id (see aaf_status); otherwise the newest is resumed.', inputSchema: { type: 'object', properties: { approval_id: { type: 'string' } } } },
];

const server = new Server({ name: 'aaf-agent', version: VERSION }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const a = req.params.arguments ?? {};
  const agent = createAgent();
  try {
    let out;
    if (req.params.name === 'aaf_status') out = await agent.status();
    else if (req.params.name === 'aaf_register') out = await agent.register({ name: a.name, harness: a.harness, wait: Math.min(Math.max(Number(a.wait ?? 0) || 0, 0), 90), fresh: a.new === true });
    else if (req.params.name === 'aaf_continue') out = await agent.continue({ wait: 5, approvalId: typeof a.approval_id === 'string' ? a.approval_id : undefined });
    else if (req.params.name === 'aaf_shop') {
      if (a.operation === 'catalog') out = await agent.catalog(agent.shop());
      else if (a.operation === 'quote' || a.operation === 'order') { if (!a.sku) throw new AgentError('sku_required'); out = await agent.act({ url: `${agent.shop()}/api/${a.operation === 'quote' ? 'quotes' : 'orders'}`, body: { sku: String(a.sku), qty: Number(a.qty ?? 1) }, wait: 20 }); } else throw new AgentError('unknown_operation');
    } else throw new AgentError('unknown_tool');
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
  } catch (e) {
    const body = e instanceof AgentError ? { status: 'error', error: e.code, ...e.detail } : { status: 'error', error: String(e.message ?? e) };
    return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], isError: true };
  }
});
await server.connect(new StdioServerTransport());
