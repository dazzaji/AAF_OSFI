// Serves the page shell, the sandboxed skin frame, and the runtime catalog of
// skins and sample datasets for one surface ("directory" or "shop").
//
// Trust boundary: the shell is trusted and owns sign-in, passkey prompts and
// every privileged action. A skin is a React component from skins/<surface>/
// that anyone with file access can drop in while the service runs. It is
// rendered inside an iframe with an opaque origin (sandbox="allow-scripts",
// no allow-same-origin), so it cannot read cookies, call the API as the user
// or reach the passkey API. It receives display data and can only *ask* the
// shell to do one of a fixed list of things.
import fs from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';
import { send, serveFile } from '../core/http.js';
import { fail } from '../core/util.js';

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,48}$/;
const here = path.dirname(new URL(import.meta.url).pathname);
const bundles = new Map();

async function bundle(key, build) {
  if (!bundles.has(key)) bundles.set(key, build().then((r) => r.outputFiles[0].text));
  return bundles.get(key);
}
const runtimeJs = () => bundle('runtime', () => esbuild.build({ entryPoints: [path.join(here, 'frame-runtime.js')], bundle: true, format: 'iife', minify: true, write: false, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' }));
const tailwindJs = () => fs.readFileSync(path.join(here, '../../node_modules/@tailwindcss/browser/dist/index.global.js'));
const webauthnJs = () => bundle('webauthn', () => esbuild.build({ stdin: { contents: "export { startRegistration, startAuthentication } from '@simplewebauthn/browser';", resolveDir: here }, bundle: true, format: 'esm', minify: true, write: false, logLevel: 'silent' }));

// A skin may import only React. Everything else is refused at build time.
const reactShim = {
  name: 'aaf-react-shim',
  setup(build) {
    build.onResolve({ filter: /^react(\/jsx-runtime|\/jsx-dev-runtime)?$/ }, (a) => ({ path: a.path, namespace: 'aaf-shim' }));
    // Nothing else may be pulled into the bundle: not other packages, and not
    // files by relative or absolute path (which could be service keys or data).
    // Type-only imports are erased before this point and are unaffected.
    build.onResolve({ filter: /.*/ }, (a) => (a.kind === 'entry-point' ? null : { errors: [{ text: `Skins may import only "react". Found: ${a.path}` }] }));
    build.onLoad({ filter: /.*/, namespace: 'aaf-shim' }, (a) => ({ contents: a.path === 'react' ? 'module.exports = window.__AAF.React;' : 'module.exports = window.__AAF.jsx;', loader: 'js' }));
  },
};
const skinCache = new Map();
async function buildSkin(file) {
  const mtime = fs.statSync(file).mtimeMs;
  const hit = skinCache.get(file);
  if (hit?.mtime === mtime) return hit.js;
  let js;
  try {
    const out = await esbuild.build({ entryPoints: [file], bundle: true, format: 'iife', globalName: '__AAF_SKIN', jsx: 'automatic', write: false, plugins: [reactShim], logLevel: 'silent', target: 'es2020' });
    js = out.outputFiles[0].text;
  } catch (e) {
    const msg = (e.errors ?? []).map((x) => `${x.text}${x.location ? ` (line ${x.location.line})` : ''}`).join('\n') || String(e.message);
    js = `window.__AAF_SKIN_ERROR = ${JSON.stringify(msg)};`;
  }
  skinCache.set(file, { mtime, js });
  return js;
}

const listDir = (dir, ext) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(ext) && NAME.test(f.slice(0, -ext.length))).map((f) => ({ name: f.slice(0, -ext.length), mtime: Math.round(fs.statSync(path.join(dir, f)).mtimeMs) })).sort((a, b) => a.name.localeCompare(b.name)) : []);

export function mountUi(app, { surface, projectRoot, title, mode, origin }) {
  const skinsDir = path.join(projectRoot, 'skins', surface);
  const dataDir = path.join(projectRoot, 'datasets', surface);
  const SHELL_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
  // "sandbox" in the header forces an opaque origin even if someone opens the
  // frame page directly in a tab. Scripts load only from this service (styling
  // is served locally, not from a CDN) and connect-src is 'none', so a skin has
  // no way to send the display data to another host.
  const FRAME_CSP = `sandbox allow-scripts; default-src 'none'; script-src ${origin}; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'`;

  app.get('/', (ctx) => send(ctx.res, 200, Buffer.from(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title.replace(/[<&]/g, '')}</title><link rel="stylesheet" href="/ui/shell.css"></head><body data-surface="${surface}" data-mode="${mode}" data-title="${title.replace(/["<&]/g, '')}"><div id="app"></div><script type="module" src="/ui/shell.js"></script></body></html>`), { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': SHELL_CSP, 'referrer-policy': 'no-referrer', 'cross-origin-opener-policy': 'same-origin', 'x-content-type-options': 'nosniff' }));
  app.get('/ui/shell.js', (ctx) => serveFile(ctx.res, path.join(here, 'shell.js')));
  app.get('/ui/shell.css', (ctx) => serveFile(ctx.res, path.join(here, 'shell.css')));
  app.get('/ui/webauthn.js', async (ctx) => send(ctx.res, 200, Buffer.from(await webauthnJs()), { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'max-age=3600' }));
  app.get('/ui/frame.html', (ctx) => send(ctx.res, 200, Buffer.from('<!doctype html><html><head><meta charset="utf-8"><script src="/ui/tailwind.js"></script><style>html,body{margin:0;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;background:#f8fafc;color:#0f172a}</style></head><body><div id="root"></div><script src="/ui/frame-runtime.js"></script></body></html>'), { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': FRAME_CSP }));
  app.get('/ui/tailwind.js', (ctx) => send(ctx.res, 200, tailwindJs(), { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'max-age=3600' }));
  app.get('/ui/frame-runtime.js', async (ctx) => send(ctx.res, 200, Buffer.from(await runtimeJs()), { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'max-age=3600' }));
  app.get('/ui/skins/:file', async (ctx) => {
    const name = ctx.params.file.replace(/\.js$/, '');
    if (!NAME.test(name)) fail(400, 'bad_skin_name');
    const file = path.join(skinsDir, name + '.tsx');
    if (!fs.existsSync(file)) fail(404, 'skin_not_found');
    send(ctx.res, 200, Buffer.from(await buildSkin(file)), { 'content-type': 'text/javascript; charset=utf-8' });
  });
  // The runtime catalog. Open tabs poll this, so a file dropped into the
  // folder shows up in the menu within a few seconds, with no restart.
  app.get('/api/ui/catalog', () => ({ surface, skins: listDir(skinsDir, '.tsx'), datasets: listDir(dataDir, '.json') }));
  app.get('/api/ui/datasets/:name', (ctx) => {
    if (!NAME.test(ctx.params.name)) fail(400, 'bad_dataset_name');
    const file = path.join(dataDir, ctx.params.name + '.json');
    if (!fs.existsSync(file)) fail(404, 'dataset_not_found');
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail(422, 'dataset_is_not_valid_json'); }
  });
}
