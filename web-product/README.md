# CodeMe website product

This directory contains the separate website checkout for the **₹499 one-time CodeMe package**, at `https://www.dhebe.com/products/codeme/`. It is not part of the locally installed application. Model inference continues to run on the customer's machine.

- `public/`: product page, original brand assets, checkout controller and small PHP API entry points.
- `private/`: Cashfree verification, private purchase records and private release streaming. See [deployment and operational details](private/README.md).
- `prepare_deploy.py`: creates a bounded deployment archive under the ignored `.runtime/deployment/` directory. It includes only explicit application files and the checksum-pinned customer release. It never includes merchant credentials, tests or payment records.

Run `python web-product/prepare_deploy.py` after the PHP and browser contract checks pass. Extract the resulting overlay **at `/home/u942725982/domains/dhebe.com/`, above `public_html`**. The new `codeme-payments-private` directory and customer ZIP must remain outside every public web root. Preserve its `runtime/` directory on later deployments. The existing Resume private merchant connection is read on the server; its configuration and purchase records must remain unchanged.

Local checks, without provider calls or real orders:

```sh
php web-product/private/tests/commerce.test.php
php web-product/private/tests/http.test.php
node --check web-product/public/checkout.mjs
node --test web-product/tests/checkout.test.mjs
```

The homepage listing is a separately verified, additive overlay. Publish immutable assets first, homepage route data second, and homepage HTML last. Check the live homepage against the captured baseline immediately before updating it, because other website work may be happening concurrently. Do not replace the website root or publish unrelated working changes.

Deployment verification must confirm the product page and assets load, checkout configuration reports ₹499 / INR and the expected release, and unauthenticated or unpaid requests cannot download the ZIP. A deployment check does not create an order or charge money. A real Cashfree purchase remains a separate end-to-end check.
