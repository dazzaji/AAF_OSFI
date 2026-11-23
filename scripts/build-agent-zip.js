#!/usr/bin/env node
// Builds the agent release ZIP: the skill folder with a bundled client that
// runs on Node.js 22.13+ with no `npm install`.
//
//   node scripts/build-agent-zip.js            build dist/<asset> and print its SHA-256
//   node scripts/build-agent-zip.js --write    also record the SHA-256 in config/agent-release.json and README.md
//   node scripts/build-agent-zip.js --check    fail unless it matches config/agent-release.json
//
// The archive is reproducible: entries are sorted and stored uncompressed with
// fixed times and modes, so the bytes depend only on the source files and the
// lockfile-pinned bundler. The inputs do not include config/agent-release.json,
// which is how the checksum can be committed beside the source it was built from.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseFile = path.join(root, 'config/agent-release.json');
const FOLDER = 'aaf-agent';

// A launcher small and plain enough to run on an old Node.js, so the person
// gets a clear next step instead of a syntax error from the bundle.
const launcher = (bundle) => `#!/usr/bin/env node
// AAF agent client launcher. Checks the Node.js version, then loads lib/${bundle}.
import path from 'path';
import { fileURLToPath } from 'url';

var v = process.versions.node.split('.').map(Number);
if (v[0] < 22 || (v[0] === 22 && v[1] < 13)) {
  console.log(JSON.stringify({ status: 'error', error: 'node_too_old', found: process.version, needs: 'Node.js 22.13 or later', next: 'Install the current LTS release from https://nodejs.org with its standard installer, then run this command again.' }, null, 2));
  process.exit(2);
}
process.env.AAF_AGENT_INSTALL_ROOT = path.dirname(fileURLToPath(import.meta.url));
import('./lib/${bundle}').then(function (m) { if (m.main) return m.main(process.argv.slice(2)); }).catch(function (e) { console.error(e); process.exit(1); });
`;

async function bundle(entry) {
  const out = await esbuild.build({
    absWorkingDir: root, entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', target: 'node22', write: false, metafile: true,
    legalComments: 'none', charset: 'utf8', logLevel: 'silent',
    // Some bundled packages are CommonJS and call require() for Node built-ins.
    banner: { js: "import { createRequire as __aafCreateRequire } from 'node:module';\nconst require = __aafCreateRequire(import.meta.url);" },
  });
  return { text: out.outputFiles[0].text, inputs: Object.keys(out.metafile.inputs) };
}

// The licences of every package that ended up in a bundle, from the bundler's own list.
function thirdPartyNotices(inputs) {
  const pkgs = new Map();
  for (const f of inputs) {
    const m = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(f);
    if (!m) continue;
    const dir = path.join(root, m[1]);
    if (pkgs.has(dir)) continue;
    const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const lic = fs.readdirSync(dir).filter((n) => /^(licen[sc]e|copying)(\.|$)/i.test(n)).sort()[0];
    pkgs.set(dir, { name: pj.name, version: pj.version, license: typeof pj.license === 'string' ? pj.license : (pj.license?.type ?? 'see package'), text: lic ? fs.readFileSync(path.join(dir, lic), 'utf8').replace(/\r\n/g, '\n').trim() : null });
  }
  const list = [...pkgs.values()].sort((a, b) => (a.name + '@' + a.version).localeCompare(b.name + '@' + b.version));
  return '# Third-party notices\n\nThe files in `lib/` bundle the following open-source packages. Each is used under its own license, reproduced below.\n\n'
    + list.map((p) => `- ${p.name} ${p.version} (${p.license})`).join('\n') + '\n\n'
    + list.map((p) => `## ${p.name} ${p.version}\n\nLicense: ${p.license}\n\n${p.text ? '```\n' + p.text + '\n```' : 'No license file is shipped in the package; see its repository.'}\n`).join('\n');
}

// A minimal ZIP writer: stored entries, fixed timestamp (1980-01-01), Unix modes.
function zip(entries) {
  const locals = []; const centrals = []; let offset = 0;
  for (const e of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const name = Buffer.from(e.name, 'utf8'); const data = e.data; const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0x0021, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12); central.writeUInt16LE(0x0021, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((0o100000 | e.mode) << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, name, data); centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

export async function buildAgentZip() {
  const release = JSON.parse(fs.readFileSync(releaseFile, 'utf8'));
  const cli = await bundle('src/agent/commands.js');
  const mcp = await bundle('src/agent/mcp.js');
  const text = (rel) => Buffer.from(fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n'), 'utf8');
  const files = [
    { name: 'SKILL.md', data: text('skill/aaf-agent/SKILL.md'), mode: 0o644 },
    { name: 'README.md', data: text('skill/aaf-agent/README.md'), mode: 0o644 },
    { name: 'LICENSE', data: text('LICENSE'), mode: 0o644 },
    { name: 'NOTICE', data: text('NOTICE'), mode: 0o644 },
    { name: 'THIRD-PARTY-NOTICES.md', data: Buffer.from(thirdPartyNotices([...cli.inputs, ...mcp.inputs]), 'utf8'), mode: 0o644 },
    { name: 'aaf-agent.mjs', data: Buffer.from(launcher('cli.mjs'), 'utf8'), mode: 0o755 },
    { name: 'aaf-agent-mcp.mjs', data: Buffer.from(launcher('mcp.mjs'), 'utf8'), mode: 0o755 },
    { name: 'lib/cli.mjs', data: Buffer.from(cli.text, 'utf8'), mode: 0o644 },
    { name: 'lib/mcp.mjs', data: Buffer.from(mcp.text, 'utf8'), mode: 0o644 },
  ].map((f) => ({ ...f, name: `${FOLDER}/${f.name}` }));
  const buffer = zip(files);
  return { release, buffer, sha256: crypto.createHash('sha256').update(buffer).digest('hex'), files };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { release, buffer, sha256, files } = await buildAgentZip();
  const out = path.join(root, 'dist', release.asset);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, buffer);
  console.log(`${release.asset}  ${buffer.length} bytes  ${files.length} files  node ${process.version}  esbuild ${esbuild.version}`);
  console.log(`sha256 ${sha256}`);
  if (process.argv.includes('--write')) {
    fs.writeFileSync(releaseFile, JSON.stringify({ ...release, sha256 }, null, 2) + '\n'); console.log('recorded in config/agent-release.json');
    // The README prints the checksum too. It is not a ZIP input, so this cannot change the bytes.
    const readme = path.join(root, 'README.md'); const text = fs.readFileSync(readme, 'utf8');
    if (release.sha256 && release.sha256 !== sha256 && text.includes(release.sha256)) { fs.writeFileSync(readme, text.replaceAll(release.sha256, sha256)); console.log('updated in README.md'); }
  }
  if (process.argv.includes('--check') && sha256 !== release.sha256) { console.error(`MISMATCH: config/agent-release.json says ${release.sha256}`); process.exit(1); }
}
