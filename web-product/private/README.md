# CodeMe paid downloads

This is the private PHP backend for the CodeMe product page at **https://www.dhebe.com/products/codeme/**. The one-time price is fixed in server code at **₹499 (49900 paise), INR**. The public website uses Cashfree hosted checkout; a redirect never grants a download.

## Deployment layout

Copy the contents of `web-product/public/` to the product route, and the contents of this directory to a separate private directory:

```text
/home/u942725982/domains/dhebe.com/
├── public_html/products/codeme/       # public page, assets and tiny API shims only
├── careerlift-payments-private/
│   └── config.php                    # existing merchant connection, untouched
└── codeme-payments-private/
    ├── bootstrap.php
    ├── config.php                    # connection location and fixed release metadata
    ├── check-install.php             # CLI only
    ├── lib/Commerce.php
    ├── releases/codeme-0.7.0-local-9587d0a573e2.zip
    └── runtime/                      # created privately; keep across deployments
```

Never place the backend, ZIP, runtime files or merchant configuration below **any** `public_html`, including a parent site's directory. The shims resolve the private service outside the document root and fail closed if the layout is unsafe. Public page assets must not contain a direct ZIP link.

The included `config.php` has no credentials. On the server it reads the sibling connection file through the bootstrap, importing only `enabled`, `mode`, `client_id` and `client_secret`. It does not import Resume pricing, origin, sessions, products, recovery records or entitlements. Do not copy the merchant credentials into this repository, client JavaScript, environment files, deployment logs or support messages.

Use PHP 8.1 or later with cURL, sessions, JSON, HTTPS support and writable private storage. Set private directories to `0700` and private files to `0600`; the runtime also applies these permissions. Keep Cashfree's existing merchant connection intact and confirm that **www.dhebe.com** is approved in the Cashfree merchant dashboard before accepting customers. This integration pins the documented API version `2025-01-01` and hosted web SDK v3.

The archive currently expected by the server is:

```text
Version: 0.7.0
Bytes: 644172
SHA-256: 2a36319da9fbe3e5d03e9de0de43c01d1de01dfb678300a2544022dc71254b67
```

Upload the ZIP to the private `releases/` folder. For a release change, upload a new immutable file first, then update the trusted archive filename, bytes, SHA-256, version and download name together in `config.php`. A missing, public, corrupt, symlinked or mismatched archive disables new checkout. Do not replace an active archive in place.

Run the private diagnostic through SSH/CLI:

```sh
php /home/u942725982/domains/dhebe.com/codeme-payments-private/check-install.php /home/u942725982/domains/dhebe.com/public_html
```

It prints readiness booleans and public release metadata, without credentials or private paths. Exit `0` means production checkout is ready; exit `2` means it is disabled. Do not test deployment by creating a live order or making a charge without separately authorized payment testing.

## Browser and API flow

1. `GET api/payments.php?action=config` starts a dedicated host-only `CODEMEPAYSESSION` session and returns a server-issued `purchaseId`, CSRF token, fixed product/price, production readiness and release checksum. The cookie is Secure, HttpOnly, SameSite=Lax and limited to `/products/codeme/`.
2. `POST api/payments.php?action=create` accepts JSON `{purchaseId, customerPhone, customerEmail?, acceptTerms:true, termsVersion:"2026-10-31"}` with `X-CSRF-Token`. The browser cannot choose price, currency, product, mode, return URL or archive path.
3. Start Cashfree SDK v3 checkout with the returned `paymentSessionId`. The server fixes the return URL to `https://www.dhebe.com/products/codeme/?order_id={order_id}`.
4. `POST api/payments.php?action=verify` accepts `{purchaseId, orderId?}` with the same CSRF token. A payment reference in the URL is only a lookup hint. It must belong to the current server session and purchase.
5. `POST api/download.php` accepts the same body and CSRF header. It freshly checks the provider and streams a verified ZIP attachment; it never returns a reusable public archive URL.

Config includes `enabled`, `downloadReady`, `mode`, `product:"codeme_download"`, `amount:499`, `amountPaise:49900`, `currency:"INR"`, `csrfToken`, `purchaseId`, `termsVersion`, `version`, `downloadName` and `sha256`. Successful create/verify responses include `paid`, `orderId`, `status`, fixed product/amount/currency and mode. Only create for an ACTIVE unpaid order includes `paymentSessionId`. An empty purchase verifies as `paid:false,status:"NOT_CREATED",orderId:null`.

Errors use `{error:{code,message}}`. A `409` means the existing payment is running or may still settle: verify or retry that same order, and do not start another charge. A `503` means status/configuration is unavailable and grants nothing. A `403` means ownership, payment proof or refund checks failed. The browser must preserve an uncertain payment reference and offer status checks/support.

If a saved CREATING intent is authoritatively missing at the provider, verification returns that owner-scoped CREATING state without granting payment or automatically retrying. The customer can explicitly resume checkout; create then reuses the original payload, order ID and idempotency key. A definite rejected creation verifies locally as REJECTED and permits an explicit new checkout. Provider outages do not become retry authorization, and EXPIRED/TERMINATION_REQUESTED states still block another payment.

## Payment proof and duplicate prevention

Each create records its immutable order request, product, production mode, customer ID, accepted terms, order ID and idempotency key **before** calling Cashfree. A short per-purchase stable file lock prevents parallel mutations. A timed-out create retries the original payload and idempotency key. ACTIVE orders reuse checkout. EXPIRED and TERMINATION_REQUESTED orders block replacement because they may still settle. Only an authoritative TERMINATED order or a definite rejected creation permits replacement. Rate limits bound repeated requests.

Cashfree POST error responses, including HTTP 400/409/422, are always unresolved in this gateway. Their status or error text cannot prove that an order was never created; duplicate-order/idempotency conflicts may use these responses. The original intent remains intact for a provider lookup and explicit idempotent retry. A new order is never created just because a POST returned an error.

Every paid verification and download requires the current provider order to be PAID with the exact CodeMe order, production product/mode tags, customer ID, ₹499 amount and INR currency. It also requires a matching SUCCESS payment, a valid payment ID, and no explicit uncaptured payment. The provider refund list must be available and contain no successful, pending, unknown or malformed refunds; only complete FAILED/CANCELLED refund entries are allowed. Stored PAID status alone never grants access. Sandbox receipts and Resume purchases cannot unlock this package.

The ZIP path is fixed by private configuration, resolved outside all public roots, constrained to its private release directory and rejected if symlinked. Its ZIP signature, exact size and SHA-256 are checked on the same open file handle that is streamed. Responses are private/no-store. Host, HTTPS, same-origin and CSRF validation apply independently of provider checks. There is no public fake-payment route, client paid flag, redirect grant, cross-origin API or client-selected download path.

## Operation and customer support

Keep `runtime/` and its session/record files when deploying; deletion can disconnect buyers from their records and payment references. Do not copy Resume runtime data here. Back up this private directory with access controls and an appropriate retention policy. Checkout contact data remains in an unresolved durable create request only until the provider order is resolved; resolved records retain purchase references and terms, without phone/email. Session lifetime is 30 days subject to server cleanup settings.

Automatic access currently belongs to the original browser session. A cleared/expired cookie or another browser requires support using the payment reference; the public UI must explain this. Do not bypass provider, refund or ownership checks by editing JSON, accepting a screenshot or sharing a public ZIP. A cross-browser recovery flow is a separate feature, not implemented here. No email is sent by this service. No webhook endpoint is needed for access because every verification/download queries the provider directly.

## Local checks

```sh
php web-product/private/tests/commerce.test.php
php web-product/private/tests/http.test.php
```

Commerce tests inject a fake gateway and include real child-process file-lock contention. HTTP tests use only a temporary loopback PHP server and dummy connection data; they never submit an order to Cashfree. They verify durable retries, price/product/owner/mode/payment/refund checks, private archive validation, rate limits, safe bootstrap discovery, session/CSRF behavior and request boundaries.

Reference: [Cashfree create order API](https://www.cashfree.com/docs/api-reference/payments/previous/v2025-01-01/orders/create) and [hosted web checkout](https://www.cashfree.com/docs/payments/online/web/redirect).
