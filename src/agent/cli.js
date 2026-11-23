#!/usr/bin/env node
// aaf-agent: the agent's wallet and protocol client.
// Every command prints one JSON object. Run `aaf-agent help` for the list.
import { main } from './commands.js';

main(process.argv.slice(2));
