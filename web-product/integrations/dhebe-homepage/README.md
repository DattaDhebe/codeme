# CodeMe on the DHEBE Studios homepage

**Status: prepared, pending deployment.** This bundle records the reviewed source change and static overlay. It does not claim that the homepage or checkout has been published. See the [product deployment guide](../../README.md) for the separate product page and payment backend.

## What the patch changes

[`codeme-homepage.patch`](codeme-homepage.patch) contains only four CodeMe changes:

- Adds `components/codeme-product-section.tsx` and its scoped CSS module.
- Imports the component in `app/page.tsx` and passes it through a `productApp` slot.
- Adds that optional slot to `StudiosHub`, immediately after the existing company introduction.

It adds the real CodeMe logo, ₹499 one-time price, setup requirements and a link to `https://www.dhebe.com/products/codeme/`. It includes no full homepage, company implementation, other page source, PHP, credentials or environment files. The shared logo must be deployed at `/products/codeme/assets/codeme-logo.svg` with the product page.

The patch was checked and applied to an isolated copy of its captured baseline. The resulting four files match the reviewed modified sources after Windows line-ending normalization. Patch SHA256:

```text
cc02228a4634b2356869bbc778eef6dc593cd29d61d6e29e29be2c1ba4c91af3
```

## Apply to the website source

Use the DHEBE Studios Next.js checkout, rather than the CodeMe application directory. Read its `AGENTS.md` and the installed Next.js guides first. The reviewed build used Node.js 24.14.1, Next.js 16.4.2 and React 19.2.5 with the website's existing lockfile. No dependencies were changed.

From the website checkout, inspect the patch and run:

```powershell
$codemePatch = 'F:\ai_projects\codeme\web-product\integrations\dhebe-homepage\codeme-homepage.patch'
git apply --check $codemePatch
git apply $codemePatch
npm run build
```

The captured website already had a company introduction that was newer than its committed `HEAD`. This patch targets that deployed layout. If the check fails, adapt only the CodeMe import, optional slot and render call to the current layout; preserve the website owner's other work. Do not replace the original source files with the isolated snapshot.

The source baseline was reconstructed by reversing only these integration changes, then verified against the two public source hashes captured before editing. [`provenance.json`](provenance.json) records those hashes, file maps, validation and archive integrity. Five original website source files changed concurrently outside this task after the snapshot. The original website checkout was never written by this integration task.

## Reviewed deployment artifacts

Artifacts are local build outputs under `.runtime/dhebe-codeme-home/` in the CodeMe checkout; they are not embedded in this source integration bundle.

| Artifact | Bytes | SHA256 |
| --- | ---: | --- |
| `codeme-homepage-overlay.zip` | 130178 | `5b01d95139242ac6cac4ce824873846f320b4ef2dae5f74780d4244330bcac72` |
| `codeme-homepage-rollback.zip` | 111482 | `c39c80162e5e83efaa770dc9a6b0acd2f2c0e98fc80dfd600f1d31203e71d869` |

The baseline was the deployed `https://www.dhebe.com/` homepage, 251338 bytes. Its HTML and all nine directly referenced JS/CSS assets matched the existing local static export byte-for-byte. Before uploading this frozen overlay, fetch the homepage again and require this SHA256:

```text
f6725f63bf03c9c15b8a56b14ee1259d8e920a20333b6fbe4b7d99305782d0dc
```

The precondition was last checked at **2026-10-30 19:15:28 UTC**. If it changes, rebuild and review against the new deployed baseline before publishing. The source patch remains useful independently of this frozen artifact.

The overlay destination is `/home/u942725982/domains/dhebe.com/public_html`. Upload only these files, in the groups shown:

| Order | File |
| --- | --- |
| Assets first | `_next/static/chunks/0kdqh4qfr9ke7.css` |
| Assets first | `_next/static/chunks/1yi48_89br7_j.js` |
| Assets first | `products/codeme/assets/codeme-logo.svg` |
| Route data next | `__next.__PAGE__.txt` |
| Route data next | `__next._full.txt` |
| Route data next | `__next._index.txt` |
| Route data next | `__next._tree.txt` |
| Route data next | `index.txt` |
| HTML last | `index.html` |

This is an additive overlay with exact file overwrites. Do not replace or delete the website root, upload other page outputs, change `.htaccess`, or remove existing hashed assets, APIs or subdomain directories. The rollback archive contains the six captured live homepage HTML/RSC files; new immutable assets can remain when rolling back.

## Build and review another overlay

1. Start from an isolated copy of the current deployed public frontend. Match the homepage and referenced modules against production before adding CodeMe. Keep private/server/environment files outside that snapshot.
2. Apply this patch and run the website's normal build and static audit. Keep the HTML and all homepage RSC payloads from the same build so React hydration and client navigation agree.
3. Compare the generated homepage with the baseline after removing the CodeMe section. Other rendered markup and structured data must remain unchanged.
4. Include only root `index.html`, root `index.txt`, root `__next.*.txt` homepage payloads, necessary new immutable chunks and the CodeMe logo. Exclude all other route outputs and unrelated assets. Existing immutable filenames must never acquire different contents.
5. Review CSS separately. In the recorded isolated build, Tailwind's scan changed only unused utility candidates; the original homepage CSS rules were unchanged. The frozen overlay therefore consistently remaps its generated global stylesheet URL `/_next/static/chunks/0bf2tjd8g8rhc.css` to the already deployed `/_next/static/chunks/20rqb8lp2chql.css` in **both HTML and every homepage RSC file**. Only CodeMe's separate CSS module is added. For a new baseline, verify CSS equivalence again before using a similar remap.
6. Preview the overlay on top of the captured complete static export. Verify desktop/mobile layout, loaded logo, hydrated tool search, working product link, missing assets and browser errors. Capture a fresh six-file live rollback and pre-upload homepage digest.
7. Produce a new allowlisted manifest and archive hashes. A fresh build can have different build IDs and hashes; do not reuse this artifact's provenance for changed bytes.

The recorded overlay passed the website build, TypeScript checks and static audit (105 canonical pages, 41 aliases and 78 direct tool pages). Desktop at 1440px and mobile at 390px passed hydration/search checks, logo loading, CTA actionability and overflow/error checks. Both layouts were visually reviewed. Existing global assets and every unrelated page output are excluded from the upload.
