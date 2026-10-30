# CodeMe deployment verification

Published October 31, 2026 (Asia/Kolkata) at https://www.dhebe.com/products/codeme/ and linked from the main homepage.

The one-time price is INR 499 (49900 paise). The existing private Resume merchant connection is reused server-side; enabled, production mode and download readiness were verified through the deployed CodeMe API. No merchant credentials were copied or changed.

Customer edition: 0.7.0; 638432 bytes; SHA-256 6f640c61bb3b83b578b0740525ebe65b5f677f80422edb47abd8a3af221d8639. The customer ZIP and backend are outside public_html. The paid package was transferred directly to Hostinger using authenticated HTTPS and an encrypted payload. GitHub received only non-secret installation scripts and manifest hashes. The one-time upload endpoint, transfer key, temporary plaintext installation ZIP and temporary hosting tasks were removed.

Validation: 77 offline commerce checks, 23 loopback HTTP checks and 24 checkout tests passed; all PHP syntax checks passed. The homepage passed its production build, TypeScript, static audit and all 64 Node checks. Four installer fixtures verified success, rollback, stale-homepage rejection and tampered-ciphertext rejection.

Live checks verified 17 frontend assets and payloads (one PNG was losslessly re-encoded by the CDN, with identical decoded pixels), production price/currency/release, secure session cookie flags, an empty purchase returning NOT_CREATED, unpaid download rejection with HTTP 403, missing-CSRF rejection with HTTP 403 and five private/setup-path access denials. The checkout .mjs is served as JavaScript by the product-scoped hosting rule.

All 105 existing main-site pages passed the live metadata audit. The existing five company services and homepage content outside CodeMe were preserved. Seven separate app/API endpoints retained their previous HTTP 200 responses. Existing private merchant settings, signup/careers endpoints and scheduled maintenance tasks were unchanged.

No real provider order, charge or email was created. A completed customer payment and Cashfree merchant-domain approval remain unverified; configuration readiness is not an end-to-end settlement test. Windows browser visual verification was not repeated because the available Computer Use URL checks were unavailable.

The homepage source integration is in C:/Users/DELL/web_applications/Base64Convertor. Preserve unrelated working changes in both repositories. Local detailed receipts are under F:/ai_projects/digital-assets/outputs/codeme-release-20261031/ and are not customer downloads.

## Prepared maintenance package

The dependency and Markdown fixes in [PR #12](https://github.com/DattaDhebe/codeme/pull/12) have a newer private package: `codeme-0.7.0-local-9587d0a573e2.zip`, 644172 bytes, SHA-256 `2a36319da9fbe3e5d03e9de0de43c01d1de01dfb678300a2544022dc71254b67`, source revision `e7f1c8de7ab8ebcf47e0d0a64d523645466df65d`. Its 143 files include the tested dependencies and rebuilt extension. The repository's deployment configuration now pins this package.

The live verification above records the earlier package. Upload the newer archive privately before changing server configuration, preserve purchase/session records, then verify the public configuration returns the new SHA-256. A prepared ZIP or repository merge does not establish that this maintenance package is deployed.
