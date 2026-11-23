# AAF agent client 0.2.0

The agent side of the Accountable Agents Framework (AAF) reference implementation: a command-line client, the same client as a local MCP server, and the skill that tells an AI agent how to use them.

Source, license and issues: https://github.com/dazzaji/AAF_OSFI

Everything this client talks to in the pilot is a sandbox. Orders are fictional and nothing is charged.

## What is in this folder

| File | What it is |
|---|---|
| `aaf-agent.mjs` | The command-line client. Run it with `node`. |
| `aaf-agent-mcp.mjs` | The same operations as a local MCP server over stdio. |
| `lib/` | The bundled code the two files above load. No `npm install` is needed. |
| `SKILL.md` | Instructions for an AI agent. This folder is a ready-made skill folder. |
| `LICENSE`, `NOTICE`, `THIRD-PARTY-NOTICES.md` | Apache License 2.0, attribution, and the licenses of the bundled libraries. |

## Prerequisite

Node.js 22.13 or later. Check with `node --version`. If it is missing or older, install the current LTS release from https://nodejs.org with its standard installer.

## Command-line quickstart

You need an invitation to the Directory first. Open the invitation link from your email, create your passkey, and stay signed in to the Directory in your browser.

```bash
# 1. Download the release ZIP and check it. Compare the printed value with the
#    SHA-256 published in the GitHub release notes and at <directory>/skill.md.
curl -fLO https://github.com/dazzaji/AAF_OSFI/releases/download/v0.2.0/aaf-agent-v0.2.0.zip
shasum -a 256 aaf-agent-v0.2.0.zip        # Linux: sha256sum aaf-agent-v0.2.0.zip

# 2. Unpack. This creates a folder named aaf-agent.
unzip -q aaf-agent-v0.2.0.zip
cd aaf-agent
node aaf-agent.mjs version

# 3. Point the client at the hosted pilot.
node aaf-agent.mjs init https://aaf-dir.civics.com --shop https://aaf-shop.civics.com

# 4. Ask the Directory to register this agent. It prints a code, a key
#    fingerprint and a link, and opens the link in your browser.
node aaf-agent.mjs register --name "My command-line agent" --harness cli

# 5. In the browser: check that the code and fingerprint match, choose the
#    limit, and approve with your passkey. The page says "Approval is complete".

# 6. Confirm the registration. This only checks; it approves nothing.
node aaf-agent.mjs register --wait 90
node aaf-agent.mjs status

# 7. Your first quote: a box of 500 business cards, USD 38.
node aaf-agent.mjs quote cards-500
```

`node aaf-agent.mjs help` lists every command. Try `node aaf-agent.mjs order cards-5000` next: the Shop asks for your approval of that exact fictional USD 480 order, you approve it in the Directory with your passkey, and `node aaf-agent.mjs continue` completes it.

## Where things are kept

The client keeps the agent's key and settings in a profile folder: `$AAF_AGENT_HOME` if set, else the folder you chose with `init --home <folder>`, else `~/.aaf-agent`. It never holds your passkey. It cannot approve, grant or revoke anything; only you can, in the Directory's web page.

If the agent was revoked and you want to connect it again, run `node aaf-agent.mjs register --new --name "..."`. The old key is moved aside and a new registration is requested.

## Use it from a desktop agent

Paste the message from the Directory's home page (**Copy for my agent**) into Claude Code, Codex, or any agent that can run commands. The agent reads the Directory's `/skill.md`, installs this folder as a skill, and walks you through the same steps without you typing commands.

To use the MCP server instead of the command line, register it with your app, for example `claude mcp add aaf-agent -- node /absolute/path/to/aaf-agent/aaf-agent-mcp.mjs`. Run `init` once with the command-line client first so both use the same profile.
