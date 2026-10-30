import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { CheckoutController, validateConfig, validateOrder, validateContact, isReady, sha256 } from '../public/checkout.mjs';

const purchaseId = 'ee54c760-d575-4c2e-a568-6daed73824cf';
const orderId = 'codeme_0123456789abcdef0123456789abcdef';
const bytes = Uint8Array.from([80,75,3,4,...Array.from({ length: 28 }, (_, i) => i)]);
const checksum = createHash('sha256').update(bytes).digest('hex');
const config = (extra = {}) => ({ enabled: true, mode: 'production', product: 'codeme_download', amount: 499, amountPaise: 49900,
  currency: 'INR', csrfToken: 'a'.repeat(64), purchaseId, termsVersion: '2026-10-31', version: '0.7.0', downloadName: 'CodeMe-0.7.0.zip', sha256: checksum, downloadReady: true, ...extra });
const order = (status = 'NOT_CREATED', extra = {}) => ({ paid: status === 'PAID', orderId: status === 'NOT_CREATED' ? null : orderId,
  status, amount: 499, amountPaise: 49900, currency: 'INR', product: 'codeme_download', mode: 'production', ...extra });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const zip = (data = bytes, extra = {}) => new Response(data, { headers: { 'Content-Type': 'application/zip', 'Content-Length': String(data.length), ...extra } });
const contact = { phone: '+91 98765 43210', email: 'user@example.com', acceptTerms: true };
function harness(responses, overrides = {}) {
  const calls = []; const saves = []; const sdkCalls = []; const states = [];
  const queue = [...responses];
  const controller = new CheckoutController({
    fetchImpl: async (url, init) => { calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
      assert.ok(queue.length, `Unexpected request: ${url}`); const next = queue.shift();
      if (next instanceof Error) throw next;
      return typeof next === 'function' ? next(url, init) : next;
    },
    loadSdk: async () => ({ checkout: async request => { sdkCalls.push(request); return { paymentDetails: { paymentStatus: 'SUCCESS' } }; } }),
    saveDownload: async (blob, name) => { saves.push({ blob, name }); },
    onChange: state => states.push(state), ...overrides,
  });
  return { controller, calls, saves, sdkCalls, states, queue };
}

test('config requires fixed product, price, version, terms and integrity metadata', () => {
  assert.equal(isReady(validateConfig(config())), true);
  for (const bad of [{ amount: 1 }, { amountPaise: 499 }, { product: 'resume' }, { currency: 'USD' }, { csrfToken: 'short' },
    { purchaseId: 'client-generated' }, { termsVersion: 'old' }, { version: '9.9.9' }, { downloadName: '../private.zip' }, { sha256: 'bad' }, { enabled: 'true' }]) {
    assert.throws(() => validateConfig(config(bad)), { code: 'invalid_response' });
  }
});
test('disabled and sandbox configuration cannot start payment', async () => {
  for (const extra of [{ enabled: false }, { mode: 'sandbox' }, { downloadReady: false }]) {
    const responses = [json(config(extra)), ...(extra.enabled === false ? [json(order())] : [])];
    const h = harness(responses); await h.controller.load();
    assert.equal(h.controller.canPay(), false); assert.equal(await h.controller.pay(contact), false);
    assert.equal(h.calls.length, responses.length); assert.equal(h.sdkCalls.length, 0); assert.equal(h.controller.state.phase, 'unavailable');
  }
});
test('disabling new sales preserves verification and download of an existing paid purchase', async () => {
  const h = harness([json(config({ enabled: false })), json(order('PAID')), zip()]);
  await h.controller.load(); assert.equal(h.controller.canPay(), false); assert.equal(h.controller.state.phase, 'paid');
  assert.equal(await h.controller.download(), true); assert.equal(h.saves.length, 1);
});
test('invalid config and failed loading fail closed with a useful status', async () => {
  for (const response of [json(config({ amount: 0 })), json({ error: { code: 'payment_unavailable' } }, 503), new Response('<html>error</html>')]) {
    const h = harness([response]); await h.controller.load();
    assert.equal(h.controller.canPay(), false); assert.equal(h.controller.state.phase, 'unknown'); assert.ok(h.controller.state.error);
  }
});
test('payment scope, server order identity and PAID consistency are mandatory', () => {
  assert.equal(validateOrder(order('PAID')).paid, true);
  for (const bad of [order('ACTIVE', { paid: true }), order('PAID', { paid: false }), order('PAID', { amountPaise: 1 }),
    order('PAID', { mode: 'sandbox' }), order('PAID', { product: 'resume' }), order('PAID', { orderId: 'other' }),
    order('NOT_CREATED', { orderId }), order('PAID', { paymentSessionId: 'fake-session' }), order('ACTIVE', { paymentSessionId: 'bad session' })]) {
    assert.throws(() => validateOrder(bad), { code: 'invalid_response' });
  }
});
test('phone, optional email and explicit acceptance are validated before requests', () => {
  assert.deepEqual(validateContact(contact), { customerPhone: '+919876543210', customerEmail: 'user@example.com', acceptTerms: true, termsVersion: '2026-10-31' });
  assert.equal('customerEmail' in validateContact({ ...contact, email: '' }), false);
  for (const bad of [{ phone: '123' }, { email: 'bad' }, { acceptTerms: false }]) assert.throws(() => validateContact({ ...contact, ...bad }));
});
test('load checks only the server-issued purchase, with same-origin credentials and CSRF', async () => {
  const h = harness([json(config()), json(order())]); await h.controller.load();
  assert.equal(h.controller.canPay(), true); assert.deepEqual(h.calls[1].body, { purchaseId });
  assert.equal(h.calls[1].init.headers['X-CSRF-Token'], 'a'.repeat(64)); assert.equal(h.calls[1].init.credentials, 'same-origin');
  assert.equal(h.calls[1].init.cache, 'no-store'); assert.equal(h.calls[1].init.redirect, 'error');
  assert.equal(h.calls[0].init.method, 'GET'); assert.equal(h.calls[1].init.method, 'POST');
});
test('checkout sends contact and terms only, then verifies without trusting SDK success', async () => {
  const h = harness([json(config()), json(order()), json(order('ACTIVE', { paymentSessionId: 'session_12345678' })), json(order('ACTIVE'))]);
  await h.controller.load(); await h.controller.pay(contact);
  assert.deepEqual(h.calls[2].body, { purchaseId, customerPhone: '+919876543210', customerEmail: 'user@example.com', acceptTerms: true, termsVersion: '2026-10-31' });
  assert.deepEqual(h.sdkCalls, [{ paymentSessionId: 'session_12345678', redirectTarget: '_self' }]);
  assert.deepEqual(h.calls[3].body, { purchaseId, orderId }); assert.equal(h.controller.state.order.paid, false);
  assert.equal(await h.controller.download(), false); assert.equal(h.saves.length, 0);
});
test('only fresh authoritative PAID result enables download', async () => {
  const h = harness([json(config()), json(order()), json(order('ACTIVE', { paymentSessionId: 'session_12345678' })), json(order('PAID'))]);
  await h.controller.load(); await h.controller.pay(contact);
  assert.equal(h.controller.state.phase, 'paid'); assert.equal(h.controller.canPay(), false);
});
test('an already-paid create response is verified again and never opens another checkout', async () => {
  const h = harness([json(config()), json(order()), json(order('PAID')), json(order('PAID'))]);
  await h.controller.load(); await h.controller.pay(contact);
  assert.equal(h.controller.state.phase, 'paid'); assert.equal(h.sdkCalls.length, 0); assert.equal(h.calls.length, 4);
});
test('cancelled or failed hosted checkout retains the same unpaid reference', async () => {
  const h = harness([json(config()), json(order()), json(order('ACTIVE', { paymentSessionId: 'session_12345678' }))], {
    loadSdk: async () => ({ checkout: async () => { throw new Error('cancelled'); } }),
  });
  await h.controller.load(); assert.equal(await h.controller.pay(contact), false);
  assert.equal(h.controller.state.order.orderId, orderId); assert.equal(h.controller.state.phase, 'pending');
  assert.match(h.controller.state.error, /Check payment status/); assert.equal(h.calls.length, 3);
});
test('failed SDK loading does not create an order', async () => {
  const h = harness([json(config()), json(order())], { loadSdk: async () => { throw new Error('offline'); } });
  await h.controller.load(); await h.controller.pay(contact); assert.equal(h.calls.length, 2); assert.equal(h.saves.length, 0);
  assert.equal(h.controller.canPay(), true); assert.match(h.controller.state.message, /No new payment was started/);
});
test('an ambiguous create response is never retried automatically or paid twice', async () => {
  const h = harness([json(config()), json(order()), new Error('network timeout'), json(order('ACTIVE'))]);
  await h.controller.load(); await h.controller.pay(contact);
  assert.equal(h.calls.length, 3); assert.equal(h.controller.state.uncertain, true); assert.equal(h.controller.canPay(), false);
  assert.equal(await h.controller.pay(contact), false); assert.equal(h.calls.length, 3);
  await h.controller.check(); assert.equal(h.controller.state.order.orderId, orderId); assert.equal(h.controller.canPay(), true);
});
test('CREATING recovery requires an explicit resume of the same server-issued intent', async () => {
  const h = harness([json(config()), json(order('CREATING')), json(order('ACTIVE', { paymentSessionId: 'session_12345678' })), json(order('ACTIVE'))]);
  await h.controller.load(); assert.equal(h.calls.length, 2); assert.equal(h.controller.canPay(), true);
  assert.match(h.controller.state.message, /explicitly resume/); await h.controller.pay(contact);
  assert.equal(h.calls[2].body.purchaseId, purchaseId); assert.equal(h.calls[3].body.orderId, orderId);
});
test('expired and unresolved closing orders cannot create a second charge', async () => {
  for (const status of ['EXPIRED', 'TERMINATION_REQUESTED']) {
    const h = harness([json(config()), json(order(status))]); await h.controller.load();
    assert.equal(h.controller.canPay(), false); assert.equal(await h.controller.pay(contact), false); assert.equal(h.calls.length, 2);
  }
});
test('409 provider-pending response retains context and requires a status check', async () => {
  const h = harness([json(config()), json(order('ACTIVE')), json({ error: { code: 'payment_pending' } }, 409)]);
  await h.controller.load(); await h.controller.pay(contact); assert.equal(h.controller.state.order.orderId, orderId);
  assert.equal(h.controller.canPay(), false); assert.match(h.controller.state.error, /earlier order may still settle/);
});
test('fresh verification errors revoke a previously displayed paid entitlement', async () => {
  const h = harness([json(config()), json(order('PAID')), json({ error: { code: 'refund_unresolved' } }, 403)]);
  await h.controller.load(); assert.equal(h.controller.state.phase, 'paid'); await h.controller.check();
  assert.notEqual(h.controller.state.phase, 'paid'); assert.equal(h.controller.state.order, null);
  assert.equal(await h.controller.download(), false); assert.match(h.controller.state.error, /refund status/);
});
test('stale configuration responses cannot overwrite newer refresh ownership', async () => {
  let release;
  const old = new Promise(resolve => { release = resolve; });
  const h = harness([() => old, json(config()), json(order())]);
  const first = h.controller.load(); await Promise.resolve(); const second = h.controller.load(); await second;
  release(json(config({ enabled: false }))); await first;
  assert.equal(h.controller.state.phase, 'ready'); assert.equal(h.controller.canPay(), true);
});
test('another submit or refresh cannot race a payment creation request', async () => {
  let release; const pending = new Promise(resolve => { release = resolve; });
  const h = harness([json(config()), json(order()), () => pending, json(order('ACTIVE'))]);
  await h.controller.load(); const paying = h.controller.pay(contact); await Promise.resolve(); await Promise.resolve();
  assert.equal(await h.controller.pay(contact), false); assert.equal(await h.controller.load(), false);
  release(json(order('ACTIVE', { paymentSessionId: 'session_12345678' }))); await paying;
  assert.equal(h.calls.filter(call => call.url.includes('action=create')).length, 1);
});
test('download posts scope, validates a bounded ZIP and checksum, then offers the correct filename', async () => {
  const h = harness([json(config()), json(order('PAID')), zip()]); await h.controller.load();
  assert.equal(await h.controller.download(), true); assert.equal(h.saves.length, 1);
  assert.equal(h.saves[0].name, 'CodeMe-0.7.0.zip'); assert.equal(h.saves[0].blob.type, 'application/zip');
  assert.deepEqual(h.calls[2].body, { purchaseId, orderId }); assert.equal(h.calls[2].url, 'api/download.php');
  assert.equal(h.controller.state.downloaded, true); assert.equal(await sha256(bytes), checksum);
});
test('download never saves provider errors, wrong types, truncated archives or mismatched checksums', async () => {
  const damaged = Uint8Array.from(bytes); damaged[10] ^= 1;
  const attempts = [json({ error: { code: 'payment_not_paid' } }, 403), json({ error: { code: 'gateway_unavailable' } }, 503),
    json({ paid: true }), zip(damaged), zip(bytes, { 'Content-Length': '500' }), zip(bytes, { 'Content-Length': '104857601' }), zip(Uint8Array.from([1,2,3]))];
  for (const response of attempts) {
    const h = harness([json(config()), json(order('PAID')), response]); await h.controller.load();
    assert.equal(await h.controller.download(), false); assert.equal(h.saves.length, 0); assert.notEqual(h.controller.state.phase, 'paid');
  }
});
test('unknown provider errors do not render arbitrary server or third-party text', async () => {
  const h = harness([json({ error: { code: 'unknown', message: '<secret provider payload>' } }, 503)]);
  await h.controller.load(); assert.doesNotMatch(h.controller.state.error, /secret|payload/);
});
test('public page exposes accurate package prerequisites and no static ZIP entitlement', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const source = await readFile(new URL('../public/checkout.mjs', import.meta.url), 'utf8');
  for (const required of ['₹499', 'not a standalone Windows .exe', 'Python 3.10+', 'Node.js 24 LTS', 'read-only repository explorer', 'five of six', '30 days', 'support@dhebe.com', 'role="alert"', 'aria-live="polite"', 'Skip to content']) assert.ok(html.includes(required), required);
  assert.doesNotMatch(html, /href=["'][^"']+\.zip/i); assert.doesNotMatch(source, /localStorage|sessionStorage|URLSearchParams|location\.search/);
  assert.match(source, /https:\/\/sdk\.cashfree\.com\/js\/v3\/cashfree\.js/);
  assert.match(html, /id="pay-button"[^>]*disabled/);
});
test('product assets are byte-identical to existing CodeMe brand assets', async () => {
  for (const name of ['codeme-logo.svg', 'codeme-wordmark-light.svg', 'codeme-512.png']) {
    assert.deepEqual(await readFile(new URL(`../public/assets/${name}`, import.meta.url)), await readFile(new URL(`../../docs/brand/${name}`, import.meta.url)));
  }
});
