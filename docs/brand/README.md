# CodeMe brand assets

**CodeMe** is the product name. **DHEBE Studios** is the public studio brand. Use the tagline **Local coding, your control.** Describe the product as a local coding assistant: its browser inspects repositories; its VS Code extension reviews edits and runs approved checks.

## Identity

The original mark combines a code bracket with an angular **M**. The bracket represents source code; the M refers to CodeMe. A quiet navy tile holds two clear geometric shapes, which remain readable at sidebar and browser-icon sizes. The design is authored in this repository and does not use another coding agent's logo.

| Asset | Purpose |
| --- | --- |
| [codeme-logo.svg](codeme-logo.svg) | Canonical square full-color mark |
| [codeme-wordmark-light.svg](codeme-wordmark-light.svg) | Dark lettering for light backgrounds |
| [codeme-wordmark-dark.svg](codeme-wordmark-dark.svg) | Light lettering for dark backgrounds |
| [codeme-monochrome.svg](codeme-monochrome.svg) | Single-color mark on a contrasting background |
| [codeme-256.png](codeme-256.png) | Extension/package icon |
| [codeme-512.png](codeme-512.png) | High-resolution app icon |

The browser also includes a 32-pixel ICO favicon, a 180-pixel Apple touch icon, and 192/512-pixel manifest icons. The extension uses its own monochrome Activity Bar export and a full-color 256-pixel marketplace-compatible PNG. An icon file is not evidence that the extension has been published to the Visual Studio Marketplace.

## Colors and typography

| Color | Value | Use |
| --- | --- | --- |
| Midnight | `#111D32` | Mark tile and dark surfaces |
| Cobalt | `#8DA2FF` | Code bracket, focus and primary accents |
| Mint | `#4DE0C1` | M monogram and supporting accent |
| Ink | `#15243B` | Wordmark on light backgrounds |
| Ice | `#F3F6FF` | Wordmark and primary text on dark backgrounds |

Use the platform's readable UI font, with Segoe UI, Inter, Arial and system sans-serif fallbacks. No external font service is required. Use **CodeMe**, including its capital C and M, in headings and interface labels. Keep body text plain and concrete; avoid claims of identical intelligence to another agent, guaranteed correctness, or unattended approval.

Keep at least one-quarter of the mark's width clear around the standalone mark. Preserve its square proportions. Use the full-color square at 24 pixels or larger; the monochrome mark is preferable for small theme-controlled navigation. Do not stretch, rotate, redraw or add effects to the mark. Use the supplied light/dark wordmark on a sufficiently contrasting background. The monochrome SVG uses `currentColor`; supply a contrasting color when embedding it.

## Regenerate assets

From the repository root:

```console
python -B scripts/build_brand_assets.py
```

The standard-library generator owns the shared geometry and exports matching SVG, PNG, ICO, and web manifest files. It requires no image library, model, font download, or network connection. Rebuild the browser and extension after changing assets. The web manifest provides application identity; it does not add a service worker or make an unstarted local backend available offline.

## Compatibility identifiers

The extension's user-facing name is CodeMe. Its established package identity remains `personal-codex-local.personal-codeme`, and its `personalCodex.*` settings and command IDs remain stable so existing installations retain configuration. `personal-codex-local` is a legacy compatibility identifier, not a claim of an OpenAI affiliation or a verified Marketplace publisher. Repository and issue links point to [DattaDhebe/codeme](https://github.com/DattaDhebe/codeme).

The extension's existing MIT license and third-party notices remain separate from application-wide licensing. That code license does not itself grant permission to use the CodeMe name or original logo as another product's branding. Refer to the repository's root license and notices for the main application's and original brand assets' current terms. This guide makes no claim of a registered trademark.
