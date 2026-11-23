// Runs inside the sandboxed frame. Loads one skin and renders it with the
// display data the shell sends. The only way out is postMessage to the shell.
import React from 'react';
import { createRoot } from 'react-dom/client';
import * as jsx from 'react/jsx-runtime';

window.__AAF = { React, jsx };
// Belt and braces with the frame's content security policy: remove the browser
// features that can open a network path a design has no use for.
for (const k of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'WebSocket', 'EventSource', 'fetch', 'XMLHttpRequest', 'WebTransport', 'Worker', 'SharedWorker']) { try { Object.defineProperty(window, k, { value: undefined, configurable: false, writable: false }); } catch { /* not present */ } }
try { Object.defineProperty(navigator, 'sendBeacon', { value: () => false }); } catch { /* ignore */ }
const root = createRoot(document.getElementById('root'));
let Skin = null; let props = null; let skinKey = ''; let failure = null;

// Calling actions.anything(...) asks the shell. The shell decides.
const actions = new Proxy({}, { get: (_t, name) => (...args) => { try { parent.postMessage({ aaf: 'action', name: String(name), args: JSON.parse(JSON.stringify(args)) }, '*'); } catch { /* unserialisable argument */ } } });

class Boundary extends React.Component {
  constructor(p) { super(p); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error) { parent.postMessage({ aaf: 'skin-error', message: String(error?.message ?? error) }, '*'); }
  render() { return this.state.error ? React.createElement('pre', { style: { padding: 16, color: '#b91c1c', whiteSpace: 'pre-wrap' } }, 'This design failed to render:\n' + String(this.state.error?.message ?? this.state.error)) : this.props.children; }
}
function render() {
  if (failure) return root.render(React.createElement('pre', { style: { padding: 16, color: '#b91c1c', whiteSpace: 'pre-wrap' } }, 'This design could not be loaded:\n' + failure));
  if (!Skin || !props) return;
  root.render(React.createElement(Boundary, { key: skinKey }, React.createElement(Skin, { ...props, actions })));
}
function loadSkin(url, key) {
  const s = document.createElement('script');
  delete window.__AAF_SKIN; delete window.__AAF_SKIN_ERROR;
  s.src = url;
  s.onload = () => {
    const mod = window.__AAF_SKIN;
    failure = window.__AAF_SKIN_ERROR ?? (typeof mod?.default === 'function' ? null : 'The file has no default-exported component.');
    Skin = failure ? null : mod.default; skinKey = key;
    if (failure) parent.postMessage({ aaf: 'skin-error', message: failure }, '*');
    render(); s.remove();
  };
  s.onerror = () => { failure = 'The design file could not be fetched.'; render(); };
  document.head.appendChild(s);
}
window.addEventListener('message', (e) => {
  if (e.source !== parent) return;
  const m = e.data ?? {};
  if (m.aaf === 'props') { props = m.props; render(); }
  if (m.aaf === 'skin') loadSkin(m.url, m.key);
});
parent.postMessage({ aaf: 'ready' }, '*');
