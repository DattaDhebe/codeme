// The browser never grants access. Each download is authorized by the payment service.
export const PRODUCT = Object.freeze({ id: 'codeme_download', amount: 499, amountPaise: 49900, currency: 'INR', version: '0.7.0', termsVersion: '2026-10-31' });
const API = 'api/payments.php';
const DOWNLOAD = 'api/download.php';
const SDK_URL = 'https://sdk.cashfree.com/js/v3/cashfree.js';
const MAX_ARCHIVE_BYTES = 104857600;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const ORDER = /^codeme_[a-f0-9]{32}$/;
const SHA = /^[a-f0-9]{64}$/;
const STATUSES = new Set(['NOT_CREATED', 'CREATING', 'ACTIVE', 'PAID', 'EXPIRED', 'TERMINATED', 'TERMINATION_REQUESTED', 'REJECTED']);
const RETRYABLE_CHECKOUT = new Set(['NOT_CREATED', 'CREATING', 'ACTIVE', 'TERMINATED', 'REJECTED']);
const MESSAGES = Object.freeze({
  invalid_csrf: 'Your checkout session needs refreshing. Refresh checkout, then check payment status before paying.',
  purchase_mismatch: 'This purchase could not be matched to this browser session. Use the original browser or contact support with your payment reference.',
  order_not_found: 'This order could not be matched to your checkout session. Use the original browser or contact support.',
  payment_not_paid: 'Payment has not been confirmed. Check its status before paying again.',
  payment_pending: 'The earlier order may still settle. Check its status or contact support before paying again.',
  payment_in_progress: 'A request is already running. Wait a moment and check payment status.',
  refund_unresolved: 'This payment needs support review because of a refund status. Contact support with your payment reference.',
  gateway_unavailable: 'Payment status is temporarily unavailable. Check this same order again before paying.',
  gateway_order_missing: 'The provider has not confirmed this order yet. Check its status again before paying.',
  checkout_rejected: 'Cashfree could not start checkout. Check your payment contact details, then retry.',
  invalid_phone: 'Enter a payment phone number with 10 to 15 digits, including the country code if needed.',
  invalid_email: 'Enter a valid payment email address, or leave the optional field empty.',
  terms_required: 'Read and accept the license and setup requirements before paying.',
  rate_limited: 'Too many checkout requests. Wait a minute, then check payment status.',
  payment_unavailable: 'Secure checkout is temporarily unavailable. Refresh checkout later, or contact support.',
});

export class CheckoutError extends Error {
  constructor(code, message, status = 0) { super(message); this.name = 'CheckoutError'; this.code = code; this.status = status; }
}
function invalidResponse() { return new CheckoutError('invalid_response', 'The payment service returned an unexpected response. Check payment status before trying to pay again.'); }
function scopeMatches(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && value.product === PRODUCT.id && value.amount === PRODUCT.amount &&
    value.amountPaise === PRODUCT.amountPaise && value.currency === PRODUCT.currency && value.mode === 'production';
}
export function validateConfig(value) {
  // A sound but disabled install may be in sandbox mode. It is never purchase-ready.
  if (!value || typeof value !== 'object' || Array.isArray(value) || !['production', 'sandbox'].includes(value.mode) ||
      !scopeMatches({ ...value, mode: 'production' }) || typeof value.enabled !== 'boolean' || typeof value.downloadReady !== 'boolean' ||
      !UUID.test(value.purchaseId) || !/^[a-f0-9]{64}$/.test(value.csrfToken) || value.termsVersion !== PRODUCT.termsVersion ||
      value.version !== PRODUCT.version || value.downloadName !== `CodeMe-${PRODUCT.version}.zip` || !SHA.test(value.sha256)) throw invalidResponse();
  return Object.freeze({ ...value });
}
export function isReady(config) { return Boolean(config?.enabled && config.mode === 'production' && config.downloadReady); }
export function canAccessPurchases(config) { return Boolean(config?.mode === 'production' && config.downloadReady); }
export function validateOrder(value) {
  if (!scopeMatches(value) || typeof value.paid !== 'boolean' || !STATUSES.has(value.status) ||
      (value.status === 'NOT_CREATED' ? value.orderId !== null : !ORDER.test(value.orderId)) ||
      value.paid !== (value.status === 'PAID')) throw invalidResponse();
  if (value.paymentSessionId !== undefined && (value.status !== 'ACTIVE' || value.paid || typeof value.paymentSessionId !== 'string' ||
      value.paymentSessionId.length < 8 || value.paymentSessionId.length > 2048 || /[\s\x00-\x1f\x7f]/.test(value.paymentSessionId))) throw invalidResponse();
  return Object.freeze({ ...value });
}
export function validateContact({ phone, email = '', acceptTerms }) {
  const customerPhone = String(phone ?? '').trim().replace(/[\s()-]/g, '');
  const customerEmail = String(email ?? '').trim();
  if (!/^\+?[0-9]{10,15}$/.test(customerPhone)) throw new CheckoutError('invalid_phone', MESSAGES.invalid_phone);
  if (customerEmail && (customerEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail))) throw new CheckoutError('invalid_email', MESSAGES.invalid_email);
  if (acceptTerms !== true) throw new CheckoutError('terms_required', MESSAGES.terms_required);
  return { customerPhone, ...(customerEmail ? { customerEmail } : {}), acceptTerms: true, termsVersion: PRODUCT.termsVersion };
}
async function errorFromResponse(response) {
  let code = 'payment_unavailable';
  try { const body = await response.json(); if (typeof body?.error?.code === 'string') code = body.error.code; } catch { /* Fail closed without exposing provider details. */ }
  return new CheckoutError(code, MESSAGES[code] || (response.status === 429 ? MESSAGES.rate_limited : MESSAGES.payment_unavailable), response.status);
}
function friendlyError(error) {
  return error instanceof CheckoutError ? error : new CheckoutError('network_error', 'The request could not be confirmed. Check payment status in this browser before paying again.');
}
export async function sha256(bytes) {
  if (!globalThis.crypto?.subtle) throw new CheckoutError('integrity_unavailable', 'This browser cannot verify the package checksum. Use a current browser over HTTPS, or contact support.');
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
async function readArchive(response) {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) < 22 || Number(length) > MAX_ARCHIVE_BYTES)) throw invalidResponse();
  if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/zip') throw invalidResponse();
  let bytes;
  if (response.body?.getReader) {
    const reader = response.body.getReader(); const chunks = []; let total = 0;
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        total += value.byteLength;
        if (total > MAX_ARCHIVE_BYTES) { await reader.cancel(); throw invalidResponse(); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    bytes = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  } else { bytes = new Uint8Array(await response.arrayBuffer()); }
  if (bytes.length < 22 || bytes.length > MAX_ARCHIVE_BYTES || (length !== null && Number(length) !== bytes.length) ||
      bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) throw invalidResponse();
  return bytes;
}
function statusText(order) {
  switch (order?.status) {
    case 'PAID': return 'Payment verified. Your CodeMe package is ready.';
    case 'ACTIVE': return 'Payment is not confirmed yet. Continue the same checkout or check its status.';
    case 'CREATING': return 'Checkout confirmation is pending. Check status or explicitly resume the same checkout; the server reuses the original payment request.';
    case 'EXPIRED': return 'This order expired. Check once more or contact support before starting another payment.';
    case 'TERMINATION_REQUESTED': return 'The provider is closing this order. Check its status before paying again.';
    case 'TERMINATED': return 'The earlier checkout was closed. You can start checkout again.';
    case 'REJECTED': return 'The earlier checkout could not start. Review your contact details and retry.';
    default: return 'Secure checkout is ready. ₹499 one-time package.';
  }
}

export class CheckoutController {
  constructor({ fetchImpl = globalThis.fetch?.bind(globalThis), loadSdk = loadCashfree, saveDownload = saveArchive, digest = sha256, onChange = () => {}, timeoutMs = 20000 } = {}) {
    this.fetch = fetchImpl; this.loadSdk = loadSdk; this.saveDownload = saveDownload; this.digest = digest; this.onChange = onChange; this.timeoutMs = timeoutMs;
    this.generation = 0; this.abort = null;
    this.state = { config: null, order: null, phase: 'loading', message: 'Checking secure checkout…', error: '', busy: false, action: '', uncertain: false, downloaded: false };
  }
  emit(changes) { this.state = { ...this.state, ...changes }; this.onChange({ ...this.state }); }
  start(action, message) {
    this.abort?.abort(); this.abort = new AbortController(); const id = ++this.generation;
    this.emit({ busy: true, action, error: '', message }); return { id, signal: this.abort.signal };
  }
  current(operation) { return operation.id === this.generation; }
  finish(operation) { if (this.current(operation)) this.emit({ busy: false, action: '' }); }
  fail(operation, error, { uncertain = false, revoke = false } = {}) {
    if (!this.current(operation)) return;
    const safe = friendlyError(error);
    this.emit({ error: safe.message, uncertain: this.state.uncertain || uncertain, ...(revoke ? { order: null, phase: 'unknown' } : {}) });
  }
  async request(path, operation, body, timeout = this.timeoutMs, consume = response => response) {
    const abort = new AbortController(); const cancel = () => abort.abort(); operation.signal.addEventListener('abort', cancel, { once: true });
    if (operation.signal.aborted) abort.abort();
    const timer = setTimeout(cancel, timeout);
    try {
      const response = await this.fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        headers: { Accept: body === undefined || path !== DOWNLOAD ? 'application/json' : 'application/zip, application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': this.state.config.csrfToken }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: abort.signal });
      return await consume(response);
    } finally { clearTimeout(timer); operation.signal.removeEventListener('abort', cancel); }
  }
  async json(action, operation, body) {
    return this.request(`${API}?action=${action}`, operation, body, this.timeoutMs, async response => {
      if (!response.ok) throw await errorFromResponse(response);
      if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw invalidResponse();
      try { return await response.json(); } catch { throw invalidResponse(); }
    });
  }
  body() { return { purchaseId: this.state.config.purchaseId, ...(this.state.order?.orderId ? { orderId: this.state.order.orderId } : {}) }; }
  applyOrder(order) {
    this.emit({ order, uncertain: false, phase: order.paid ? 'paid' : !isReady(this.state.config) ? 'unavailable' : order.status === 'NOT_CREATED' ? 'ready' : 'pending',
      message: !order.paid && !isReady(this.state.config) ? 'New purchases are unavailable. Existing paid purchases can still be checked in this browser.' : statusText(order), error: '' });
  }
  async verify(operation) {
    const order = validateOrder(await this.json('verify', operation, this.body()));
    if (this.current(operation)) this.applyOrder(order);
    return order;
  }
  async load() {
    // Refresh can replace a read, but must never race an in-flight payment or download.
    if (this.state.busy && !['loading', 'checking'].includes(this.state.action)) return false;
    const operation = this.start('loading', 'Checking secure checkout…');
    this.emit({ config: null, order: null, phase: 'loading', uncertain: false, downloaded: false });
    try {
      const config = validateConfig(await this.json('config', operation));
      if (!this.current(operation)) return false;
      this.emit({ config });
      if (!canAccessPurchases(config)) {
        this.emit({ phase: 'unavailable', message: 'Paid downloads are not available right now. Refresh later, or contact support.' });
      } else { await this.verify(operation); }
      return true;
    } catch (error) {
      if (this.current(operation)) { this.emit({ phase: 'unknown', message: 'Checkout could not be confirmed. Refresh or check payment status before paying.' }); this.fail(operation, error, { uncertain: true }); }
      return false;
    } finally { this.finish(operation); }
  }
  async check() {
    if (this.state.busy || !canAccessPurchases(this.state.config)) return false;
    const operation = this.start('checking', 'Checking payment with the secure payment service…');
    // An earlier paid view is not retained if a fresh authoritative check fails.
    this.emit({ phase: 'checking', uncertain: true });
    try { await this.verify(operation); return true; }
    catch (error) { this.fail(operation, error, { uncertain: true, revoke: true }); return false; }
    finally { this.finish(operation); }
  }
  canPay() { return isReady(this.state.config) && !this.state.busy && !this.state.uncertain && RETRYABLE_CHECKOUT.has(this.state.order?.status); }
  async pay(contact) {
    if (!this.canPay()) return false;
    let details;
    try { details = validateContact(contact); } catch (error) { this.emit({ error: friendlyError(error).message }); return false; }
    const operation = this.start('paying', 'Preparing secure Cashfree checkout…');
    let attempted = false; let created = false;
    try {
      // Load the hosted SDK before creating an order. A missing SDK must not create a charge attempt.
      const cashfree = await this.loadSdk();
      if (!this.current(operation)) return false;
      attempted = true;
      const order = validateOrder(await this.json('create', operation, { purchaseId: this.state.config.purchaseId, ...details }));
      if (!this.current(operation)) return false;
      created = true; this.applyOrder(order);
      if (order.paid) { await this.verify(operation); return true; }
      if (order.status !== 'ACTIVE' || !order.paymentSessionId) throw new CheckoutError('payment_pending', MESSAGES.payment_pending);
      this.emit({ message: 'Opening Cashfree. Complete checkout there, then return here to verify payment.' });
      try {
        await cashfree.checkout({ paymentSessionId: order.paymentSessionId, redirectTarget: '_self' });
      } catch {
        if (this.current(operation)) this.emit({ message: statusText(order), error: 'Checkout closed or could not open. Check payment status before continuing the same checkout.' });
        return false;
      }
      // SDK callbacks and redirect query parameters are never evidence of payment.
      await this.verify(operation); return true;
    } catch (error) {
      if (this.current(operation)) this.emit({ message: attempted ? 'Checkout needs a payment status check before another attempt.' : 'Cashfree could not open. No new payment was started.' });
      this.fail(operation, error, { uncertain: attempted && (!created || error?.code !== 'payment_pending'), revoke: created && this.state.order?.paid === true });
      return false;
    } finally { this.finish(operation); }
  }
  async download() {
    if (this.state.busy || this.state.phase !== 'paid' || !this.state.order?.paid || !canAccessPurchases(this.state.config)) return false;
    const operation = this.start('downloading', 'Verifying payment and package checksum…');
    try {
      const bytes = await this.request(DOWNLOAD, operation, this.body(), 60000, async response => {
        if (!response.ok) throw await errorFromResponse(response);
        return readArchive(response);
      });
      const hash = await this.digest(bytes);
      if (hash !== this.state.config.sha256) throw new CheckoutError('integrity_error', 'The package checksum did not match. No file was saved. Check payment status and retry, or contact support.');
      if (!this.current(operation)) return false;
      await this.saveDownload(new Blob([bytes], { type: 'application/zip' }), this.state.config.downloadName);
      this.emit({ downloaded: true, message: 'Verified package sent to your browser’s downloads. Extract the ZIP and follow the setup guide.' });
      return true;
    } catch (error) { this.fail(operation, error, { uncertain: true, revoke: true }); return false; }
    finally { this.finish(operation); }
  }
}

let sdkPromise;
export function loadCashfree() {
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = SDK_URL; script.async = true; script.referrerPolicy = 'strict-origin-when-cross-origin';
    const timeout = setTimeout(() => fail(), 20000);
    const fail = () => { clearTimeout(timeout); script.remove(); sdkPromise = undefined; reject(new CheckoutError('sdk_unavailable', 'Cashfree checkout could not load. Refresh later or contact support. No new payment was started.')); };
    script.onerror = fail;
    script.onload = () => {
      clearTimeout(timeout);
      try { if (typeof globalThis.Cashfree !== 'function') return fail(); const sdk = globalThis.Cashfree({ mode: 'production' }); if (typeof sdk?.checkout !== 'function') return fail(); resolve(sdk); }
      catch { fail(); }
    };
    document.head.append(script);
  });
  return sdkPromise;
}
export function saveArchive(blob, name) {
  const url = URL.createObjectURL(blob); const link = document.createElement('a');
  link.href = url; link.download = name; link.hidden = true; document.body.append(link);
  try { link.click(); } finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
}

export function mountCheckout(documentRef = document) {
  const byId = id => documentRef.getElementById(id);
  const form = byId('purchase-form'); if (!form) return null;
  const pay = byId('pay-button'); const check = byId('check-button'); const refresh = byId('refresh-button'); const download = byId('download-button');
  const phone = byId('customer-phone'); const email = byId('customer-email'); const terms = byId('accept-terms');
  const controller = new CheckoutController({ onChange(state) {
    const paid = state.phase === 'paid' && state.order?.paid === true;
    byId('checkout-status').dataset.phase = paid ? 'paid' : state.phase === 'pending' ? 'pending' : state.phase;
    byId('status-message').textContent = state.message;
    byId('checkout-error').textContent = state.error; byId('checkout-error').hidden = !state.error;
    form.hidden = paid; download.hidden = !paid; download.disabled = !paid || state.busy;
    pay.disabled = !controller.canPay(); pay.textContent = state.busy && state.action === 'paying' ? 'Opening secure checkout…' : state.order?.status === 'CREATING' ? 'Resume same checkout · ₹499' : state.order?.status === 'ACTIVE' ? 'Continue checkout · ₹499' : 'Pay ₹499 with Cashfree ↗';
    check.disabled = state.busy || !canAccessPurchases(state.config); refresh.disabled = state.busy && !['loading', 'checking'].includes(state.action);
    phone.disabled = email.disabled = terms.disabled = state.busy;
    form.setAttribute('aria-busy', String(state.busy));
    byId('payment-reference').hidden = !state.order?.orderId;
    byId('payment-reference').textContent = state.order?.orderId ? `Payment reference: ${state.order.orderId}. Keep this browser session for download access.` : '';
    byId('checksum').hidden = !paid;
    byId('checksum').textContent = paid ? `Package SHA-256: ${state.config.sha256}` : '';
  } });
  form.addEventListener('submit', event => { event.preventDefault(); void controller.pay({ phone: phone.value, email: email.value, acceptTerms: terms.checked }); });
  check.addEventListener('click', () => { void controller.check(); });
  refresh.addEventListener('click', () => { void controller.load(); });
  download.addEventListener('click', () => { void controller.download(); });
  void controller.load(); return controller;
}
if (typeof document !== 'undefined') mountCheckout();
