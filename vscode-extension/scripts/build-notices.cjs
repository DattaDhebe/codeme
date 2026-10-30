'use strict';

// Preserve the exact notices for runtime libraries bundled by esbuild.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const dependencies = [
  ['marked', 'LICENSE.md'],
  ['prismjs', 'LICENSE'],
];
let output = 'CodeMe VS Code extension — bundled third-party notices\n\n'
  + 'The following runtime libraries are included in the compiled extension or webview.\n'
  + 'Their upstream license texts are reproduced without modification below.\n'
  + 'The extension code license is in LICENSE; component and brand information is in NOTICE.\n\n';
for (const [name, licenseFile] of dependencies) {
  const directory = path.join(root, 'node_modules', name);
  const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  const license = fs.readFileSync(path.join(directory, licenseFile), 'utf8');
  output += '='.repeat(72) + '\n' + `${metadata.name} ${metadata.version}\n`
    + `Source: https://www.npmjs.com/package/${name}\nLicense file: ${licenseFile}\n\n`
    + license + (license.endsWith('\n') ? '\n' : '\n\n');
}
output += 'End of bundled third-party notices.\n';
fs.writeFileSync(path.join(root, 'THIRD_PARTY_NOTICES.txt'), output, 'utf8');
console.log('Bundled marked and Prism notices refreshed from installed packages.');
