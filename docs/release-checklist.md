# Review a CodeMe release

Use this checklist to prepare a concrete, reviewable distribution. It does not publish a release, create a Marketplace listing, enable checkout, or approve a customer payment.

## Confirm the intended version and scope

- Check the application version, extension version, package filename, repository URLs, brand assets, and user-facing names agree.
- Update [CHANGELOG.md](../CHANGELOG.md) and the relevant guides with actual behavior and limitations.
- Preserve existing configuration, databases, checkpoints, model weights, and unrelated working-tree changes.
- Review [LICENSE](../LICENSE), [NOTICE](../NOTICE), the existing extension license, and third-party notices. Do not silently turn a restricted application into a repository-wide MIT release or remove existing rights notices.

## Validate the product

Run checks appropriate to the changed behavior using the commands in [Development](development.md). Shared backend/client changes should exercise the backend and both clients. Record tests not run, failures, and material limits. Report fixture, native editor, live local model, and fresh-install evidence separately.

Build the browser and rebuild/package the extension before packaging their assets. An updated source tree with stale `dist/` output is not a verified release. Local builds do not establish passing remote CI, macOS/Linux compatibility, Marketplace acceptance, or a clean OS installation.

## Build the customer ZIP

From the repository root, inspect the packaging options:

```console
python -B scripts/package_release.py --help
```

Then build the package:

```console
python -B scripts/package_release.py
```

The tool uses an explicit source allowlist and writes generated output under ignored `.runtime/releases/`. Read its report and manifest. Confirm the ZIP contains the intended source, built browser, extension VSIX, setup scripts, documentation, branding, and applicable notices. Check the final source and asset hashes after branding or metadata changes; an older ZIP must be rebuilt.

The package is a **source-and-prebuilt-assets distribution**, not a standalone `.exe`. Python and supported Node/npm are prerequisites for first installation. Ollama/runtime setup and model weights are separate; the weights are not bundled. Initial dependency/model downloads need internet access.

Verify that `.env`, user databases, customer/payment state, conversations, credentials, Git history, model weights, caches, dependency directories, test fixtures, private deployment configuration, and unrelated audit edits are absent. Do not publish an entire working-tree archive.

## Review publication separately

Before making a public release, verify the intended Git commit/tag, artifact, checksum, release notes, and destination. Keep a copy of the exact published manifest. A GitHub source repository is not automatically a downloadable paid product or a verified Marketplace listing.

Review the intended [repository About metadata](../.github/repository-metadata.json) with `python -B scripts/configure_repository.py`. Applying it requires the explicit `--apply` option and authenticated access, as described in [Development](development.md#repository-about-information). Verify the remote fields after applying; an unauthenticated or plan-only run is not an update. Inspect actual [CI results](../.github/workflows/ci.yml) before claiming that remote checks passed.

The planned DHEBE Studios product is **₹499 once**, with a Cashfree-protected download on `dhebe.com`. It is currently **not live**. Before advertising a working purchase button, the product needs its reviewed server-owned price, separate CodeMe order/entitlement scope, private artifact storage, payment verification, download gating, and a verified deployment. A redirect, browser flag, screenshot, order ID, or local fixture result is not proof of a real paid purchase.

Do not expose the customer ZIP through a public static URL to simulate a paid download. Do not copy payment secrets into the package or source. Reusing the resume project's Cashfree connection must not share its prices, sessions, purchase records, or entitlements. Never make a real charge as an ordinary test without explicit authorization for that transaction.

Use accurate release notes and support information. Do not invent a refund policy, tax claim, response-time commitment, customer testimonial, compatibility guarantee, or release approval.
