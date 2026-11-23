// The Setup guide's only script: Copy buttons, and the operator-link button.
for (const b of document.querySelectorAll('[data-copy]')) {
  b.addEventListener('click', async () => {
    const box = document.getElementById(b.dataset.copy);
    let ok = false;
    try { await navigator.clipboard.writeText(box.value); ok = true; } catch { /* fall back below */ }
    if (!ok) { box.focus(); box.select(); try { ok = document.execCommand('copy'); } catch { ok = false; } }
    const note = b.parentElement.querySelector('.copied');
    note.textContent = ok ? 'Copied. Paste it into your agent.' : 'Select the text above and copy it.';
    note.hidden = false;
    if (!ok) { box.focus(); box.select(); }
  });
}
for (const t of document.querySelectorAll('textarea[readonly]')) t.addEventListener('focus', () => t.select());
const op = document.getElementById('operator-link');
if (op) op.addEventListener('click', async () => {
  op.disabled = true;
  const note = document.getElementById('operator-link-note');
  try { const res = await fetch('/api/setup/operator-link', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); const j = await res.json(); note.textContent = j.note ?? 'Requested.'; } catch { note.textContent = 'The request did not go through. Try again in a moment.'; op.disabled = false; }
});
