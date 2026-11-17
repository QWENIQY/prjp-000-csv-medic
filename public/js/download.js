/* CSV Medic — download / payment page */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const id = decodeURIComponent(location.pathname.split('/').pop() || '');
  const params = new URLSearchParams(location.search);
  const api = (path, opts = {}) =>
    fetch(`/api/exports/${encodeURIComponent(id)}${path}`, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    }).then(async (r) => ({ ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) }));

  const views = ['loading', 'error', 'locked', 'ready'];
  function show(name) {
    for (const v of views) $(`view-${v}`).hidden = v !== name;
  }
  function fail(msg) {
    $('error-msg').textContent = msg;
    show('error');
  }
  function setAll(cls, text) {
    document.querySelectorAll(cls).forEach((e) => (e.textContent = text));
  }
  function actionError(msg) {
    const e = $('action-error');
    e.textContent = msg || '';
    e.hidden = !msg;
  }

  let downloaded = false;

  function render(s) {
    setAll('.js-filename', s.filename);
    setAll('.js-meta', `${s.rows.toLocaleString('en-GB')} rows · ${s.products.toLocaleString('en-GB')} products · ${s.fixed.toLocaleString('en-GB')} fixes applied`);
    setAll('.js-price', s.priceLabel);
    setAll('.js-free-per-day', String(s.freePerDay));
    const hours = Math.max(1, Math.round((s.expiresAt - Date.now()) / 3600000));
    setAll('.js-expiry', `${hours} more hour${hours === 1 ? '' : 's'}`);

    if (s.unlocked) {
      const href = `/api/exports/${encodeURIComponent(id)}/file`;
      $('file-link').href = href;
      $('file-link').setAttribute('download', s.filename);
      $('ready-title').textContent = s.unlockMethod === 'stripe' ? 'Payment received — your CSV is ready' : 'Your CSV is ready';
      show('ready');
      if (!downloaded) {
        downloaded = true;
        // Start the download automatically (the response is an attachment, so the page stays put).
        setTimeout(() => $('file-link').click(), 300);
      }
      return;
    }

    const freeAvailable = s.freeRemaining > 0;
    $('free-block').hidden = !freeAvailable;
    $('free-used-note').hidden = freeAvailable;
    const pay = $('pay-btn');
    pay.className = `btn btn-lg btn-block ${freeAvailable ? 'btn-secondary' : 'btn-primary'}`;
    pay.dataset.enabled = String(Boolean(s.paymentsEnabled));
    pay.disabled = !s.paymentsEnabled || !$('consent-box').checked;
    if (!s.paymentsEnabled) actionError('Card payments are not set up yet on this server (missing Stripe keys).');
    $('cancelled-note').hidden = params.get('cancelled') !== '1';
    show('locked');
  }

  async function load() {
    const r = await api('');
    if (!r.ok) return fail(r.data.error || 'This download link is not valid.');
    render(r.data);
    return r.data;
  }

  /** Back from Stripe Checkout: confirm the payment (the webhook may arrive a moment later). */
  async function verifyPayment(sessionId) {
    $('loading-msg').textContent = 'Confirming your payment…';
    show('loading');
    for (let attempt = 0; attempt < 10; attempt++) {
      const r = await api('/verify', { method: 'POST', body: JSON.stringify({ sessionId }) });
      if (r.ok && r.data.unlocked) break;
      if (!r.ok && r.status !== 429) {
        return fail(r.data.error || 'We could not confirm your payment. If you were charged, contact us and we\'ll sort it out straight away.');
      }
      await new Promise((res) => setTimeout(res, 2000));
    }
    history.replaceState(null, '', location.pathname);
    const s = await load();
    if (s && !s.unlocked) {
      actionError('Your payment is still processing. This page will unlock as soon as it completes — try refreshing in a minute.');
    }
  }

  $('consent-box').addEventListener('change', () => {
    const pay = $('pay-btn');
    pay.disabled = pay.dataset.enabled !== 'true' || !$('consent-box').checked;
  });

  $('free-btn').addEventListener('click', async () => {
    actionError('');
    const btn = $('free-btn');
    btn.disabled = true;
    btn.textContent = 'Unlocking…';
    const r = await api('/claim-free', { method: 'POST', body: '{}' });
    btn.disabled = false;
    btn.textContent = 'Use my free download';
    if (!r.ok) {
      actionError(r.data.error || 'Could not use your free download.');
      return load();
    }
    load();
  });

  $('pay-btn').addEventListener('click', async () => {
    actionError('');
    const btn = $('pay-btn');
    const label = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = 'Opening secure checkout…';
    const r = await api('/checkout', { method: 'POST', body: JSON.stringify({ consent: $('consent-box').checked }) });
    if (r.ok && r.data.url && /^https:\/\/checkout\.stripe\.com\//.test(r.data.url)) {
      window.location.href = r.data.url;
      return;
    }
    btn.disabled = false;
    btn.innerHTML = label;
    if (r.ok && r.data.unlocked) return load();
    actionError(r.data.error || 'Could not start checkout. Please try again.');
  });

  if (!/^[A-Za-z0-9_-]{24}$/.test(id)) {
    fail('This download link is not valid.');
  } else if (params.get('session_id')) {
    verifyPayment(params.get('session_id'));
  } else {
    load();
  }
})();
